import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SuperagentBinding, SuperagentDecisionState, SuperagentEvent, SuperagentGateway } from "../shared/superagent.ts";
import { askQuestionSummary, parseAskQuestions } from "../shared/ask-question.ts";
import {
  newEventId, newId,
  type ModelCatalog, type ProviderDriver, type RuntimeEvent, type RuntimeEventListener,
} from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

export const SUPERAGENT_INSTANCE_ID = "dsh-superagent";

interface DriverOptions {
  gateway(): SuperagentGateway;
  model(): string;
  configured(): boolean;
  currentBinding?(threadId: string): (SuperagentBinding & { requestId?: string }) | undefined;
}

interface ActiveTurn extends SuperagentBinding {
  contextId: string;
  requestId: string;
  replies: Set<string>;
  tools: Set<string>;
  stopping?: boolean;
}

function workspace(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function display(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redactSecretsInText(text).slice(0, 8_000);
}

function nativeQuestions(prompt: string) {
  const safe = redactSecretsInText(prompt);
  if (safe.length <= 100_000) {
    try {
      const payload: unknown = JSON.parse(safe);
      const questions = parseAskQuestions(Array.isArray(payload) ? { questions: payload } : payload);
      if (questions) return questions;
    } catch {}
  }
  return [{ question: safe.slice(0, 8_000), options: [] }];
}

const taskStateLabels: Record<string, string> = {
  "person/delivery": "Waiting for delivery", "person/answer": "Waiting for your answer",
  "person/review": "Ready for your review", "person/blocked": "Needs your help",
  "person/failed": "Needs attention", working: "Working", "working/queued": "Queued",
  idle: "Idle", completed: "Completed", merged: "Merged", closed: "Closed", dropped: "Dropped", stopped: "Stopped",
};

/** Adapts one official runtime to the original product bus; it never replays model history. */
export function createSuperagentDriver(options: DriverOptions): ProviderDriver<Record<string, never>> & { connect(): void } {
  const connections = new Set<() => void>();
  const models = (): ModelCatalog => ({
    default: options.model(),
    options: [{ id: options.model(), label: options.model(), provider: "deepseek-official" }],
  });
  return {
    connect() { for (const connect of connections) connect(); },
    driverKind: SUPERAGENT_INSTANCE_ID,
    metadata: { displayName: "DSH Super Agent", access: "api", supportsMultipleInstances: false },
    install: { settings: "connections" },
    defaultConfig: () => ({}),
    decodeConfig(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new TypeError("Super Agent has no per-instance configuration");
      return {};
    },
    get models() { return models(); },
    async create(input) {
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, ActiveTurn>();
      const requests = new Map<string, SuperagentBinding & { contextId: string; requestId: string; stopped?: boolean; cwd?: string }>();
      const decisions = new Map<string, SuperagentDecisionState>();
      const answering = new Map<string, "allow" | "deny" | "answer">();
      const taskStates = new Map<string, string>();
      const sessions = new Set<string>();
      let unsubscribe: (() => void) | undefined;
      const base = (turn: SuperagentBinding & { requestId: string }) => ({
        eventId: newEventId(), provider: SUPERAGENT_INSTANCE_ID, providerInstanceId: input.instanceId,
        threadId: turn.threadId, turnId: turn.requestId, createdAt: new Date().toISOString(),
      });
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      const finish = (turn: ActiveTurn, ok: boolean, reason?: string) => {
        if (active.get(turn.threadId) !== turn) return;
        for (const itemId of turn.tools) emit({ ...base(turn), type: "item.completed", itemId, itemType: "tool", ok });
        turn.tools.clear();
        active.delete(turn.threadId);
        emit({ ...base(turn), type: "turn.completed", ok, ...(reason ? { stopReason: reason } : {}) });
      };
      const valid = (binding: SuperagentBinding & { requestId: string }, terminalTask = false) => {
        const known = requests.get(binding.requestId);
        if (known?.stopped && !terminalTask) return false;
        if (known && (known.botId !== binding.botId || known.threadId !== binding.threadId || known.contextId !== binding.contextId)) return false;
        const current = options.currentBinding?.(binding.threadId);
        if (options.currentBinding && (!current || current.botId !== binding.botId)) return false;
        if (options.gateway().isActiveBinding) return options.gateway().isActiveBinding!(binding);
        return Boolean(known && (!current || current.contextId === binding.contextId));
      };
      const nativeBase = (event: SuperagentBinding & { requestId: string; sourceMessageId?: string; ticketId?: string; agentId?: string; callId?: string; authorizationVersion?: number }) => ({
        ...base(event),
        background: active.get(event.threadId)?.requestId !== event.requestId,
        nativeTask: {
          botId: event.botId, contextId: event.contextId!,
          sourceMessageId: event.sourceMessageId, ticketId: event.ticketId, agentId: event.agentId,
          callId: event.callId, authorizationVersion: event.authorizationVersion,
        },
      });
      const resolveDecision = (decision: SuperagentDecisionState, behavior: "allow" | "deny" | "answer", source: "user" | "system") => {
        if (!decisions.delete(decision.decisionId)) return;
        emit({ ...nativeBase(decision), type: "request.resolved", requestId: decision.decisionId, behavior, source });
      };
      const openDecision = (decision: SuperagentDecisionState) => {
        if (decision.status !== "pending" || !valid(decision) || decisions.has(decision.decisionId)) return;
        decisions.set(decision.decisionId, decision);
        const questions = decision.kind === "question" ? nativeQuestions(decision.prompt) : undefined;
        emit({
          ...nativeBase(decision), type: "request.opened", requestId: decision.decisionId,
          requestType: decision.kind === "approval" ? "permission" : "question",
          tool: decision.kind === "approval" ? "superagent" : "ask_user",
          summary: questions ? askQuestionSummary(questions) : redactSecretsInText(decision.prompt).slice(0, 8_000),
          ...(questions ? { questions } : {}), allowSession: false,
        });
      };
      const receive = (event: SuperagentEvent) => {
        const turn = active.get(event.threadId);
        const current = turn && turn.botId === event.botId && turn.requestId === event.requestId && turn.contextId === event.contextId ? turn : undefined;
        if (event.type === "decision.resolved") {
          const decision = decisions.get(event.decisionId);
          if (decision && decision.threadId === event.threadId && decision.contextId === event.contextId) {
            const source = answering.has(event.decisionId) && !event.reason && event.behavior === answering.get(event.decisionId) ? "user" : "system";
            resolveDecision(decision, event.behavior ?? "deny", source);
          } else if (!decision) {
            emit({ ...nativeBase(event), type: "request.resolved", requestId: event.decisionId,
              behavior: event.behavior ?? "deny", source: "system" });
          }
          return;
        }
        if (event.type === "approval" || event.type === "question") {
          openDecision({ ...event, kind: event.type, status: "pending" });
          return;
        }
        if (event.type === "task") {
          if (!valid(event, event.ended === true)) return;
          const title = redactSecretsInText(event.title?.trim() || "Super Agent task").slice(0, 160);
          const state = taskStateLabels[event.state] ?? redactSecretsInText(event.state).replaceAll("/", " ").slice(0, 80);
          const key = JSON.stringify([event.botId, event.threadId, event.contextId, event.ticketId]);
          const snapshot = JSON.stringify([title, state]);
          if (taskStates.get(key) === snapshot) return;
          taskStates.set(key, snapshot);
          emit({ ...nativeBase(event), type: "runtime.notice", message: `${title}: ${state}` });
          return;
        }
        if (!current || !turn) return;
        switch (event.type) {
          case "started":
            sessions.add(event.threadId);
            emit({ ...base(turn), type: "session.started", sessionId: `omb-superagent:${turn.contextId}`, model: options.model() });
            break;
          case "reply":
            if (event.persisted) return;
            if (turn.replies.has(event.messageId)) return;
            turn.replies.add(event.messageId);
            emit({ ...base(turn), type: "item.completed", itemId: event.messageId, itemType: "assistant_text", text: redactSecretsInText(event.text) });
            break;
          case "text":
            // Worker streams are private execution detail. The source outbox is the reply authority.
            break;
          case "tool":
            if (event.phase === "start") {
              if (turn.tools.has(event.callId)) return;
              turn.tools.add(event.callId);
              emit({ ...base(turn), type: "item.started", itemId: event.callId, itemType: "tool", title: event.name, input: display(event.input) });
            } else if (turn.tools.delete(event.callId)) {
              emit({ ...base(turn), type: "item.completed", itemId: event.callId, itemType: "tool", ok: true, output: display(event.output) });
            }
            break;
          case "failed":
            for (const decision of decisions.values()) if (decision.botId === event.botId && decision.threadId === event.threadId
              && decision.contextId === event.contextId && decision.requestId === event.requestId) resolveDecision(decision, "deny", "system");
            emit({ ...base(turn), type: "runtime.error", message: redactSecretsInText(event.error), terminal: true });
            finish(turn, false, event.error);
            break;
          case "completed": finish(turn, !turn.stopping, turn.stopping ? "interrupted" : undefined); break;
        }
      };
      const gateway = () => {
        const value = options.gateway();
        unsubscribe ??= value.subscribe(receive);
        return value;
      };
      const connect = () => { gateway(); };
      connections.add(connect);
      return {
        instanceId: input.instanceId, driverKind: SUPERAGENT_INSTANCE_ID, displayName: input.displayName ?? "DSH Super Agent",
        enabled: input.enabled,
        get models() { return models(); },
        snapshot: async () => options.configured()
          ? { state: "available", authenticated: true, billing: "metered" }
          : { state: "unavailable", authenticated: false, reason: "Configure the DeepSeek API key in Settings → Connections." },
        generateText: (prompt, settings) => gateway().generateText(prompt, { signal: settings?.signal }),
        generateMemoryText: (prompt, settings) => gateway().generateText(prompt, { signal: settings?.signal }),
        adapter: {
          provider: SUPERAGENT_INSTANCE_ID,
          capabilities: { sessionModelSwitch: "unsupported", strictResume: true, askTool: { kind: "native", name: "ask_user" } },
          async sendTurn(turn) {
            if (!turn.botId) throw new Error("Super Agent requires the original bot identity");
            if (turn.images?.length) throw new Error("This Super Agent profile does not support image input");
            if (active.has(turn.threadId)) throw new Error("This conversation is already working");
            const cursor = typeof turn.resumeCursor === "string" && /^omb-superagent:[A-Za-z0-9_-]{1,128}$/.test(turn.resumeCursor)
              ? turn.resumeCursor.slice("omb-superagent:".length) : undefined;
            const contextId = !turn.sessionReset && cursor ? cursor : newId();
            const current: ActiveTurn = { botId: turn.botId, threadId: turn.threadId, contextId, requestId: newId(), replies: new Set(), tools: new Set() };
            active.set(turn.threadId, current);
            requests.set(current.requestId, { ...current, cwd: turn.cwd ? workspace(turn.cwd) : undefined });
            emit({ ...base(current), type: "turn.started" });
            try {
              let transition: "branch" | "workspace" | undefined = turn.sessionReset ? "branch" : undefined;
              if (cursor && !turn.sessionReset && turn.cwd) {
                const snapshot = await gateway().inspect?.({ botId: turn.botId, threadId: turn.threadId, contextId: cursor });
                const oldWorkspace = snapshot?.bindings.find(binding => binding.contextId === cursor)?.workspace
                  ?? [...requests.values()].find(request => request.requestId !== current.requestId && request.contextId === cursor)?.cwd;
                if (oldWorkspace && workspace(oldWorkspace) !== workspace(turn.cwd)) {
                  current.contextId = newId();
                  transition = "workspace";
                  requests.set(current.requestId, { ...current, cwd: workspace(turn.cwd) });
                  emit({ ...base(current), type: "runtime.notice", message: `Execution directory: ${workspace(turn.cwd)}` });
                }
              }
              if (current.stopping) return { turnId: current.requestId };
              if (turn.sessionReset) {
                for (const request of requests.values()) if (request.threadId === turn.threadId && request.contextId !== current.contextId) request.stopped = true;
                for (const decision of decisions.values()) if (decision.threadId === turn.threadId && decision.contextId !== current.contextId) resolveDecision(decision, "deny", "system");
              }
              await gateway().submit({
                botId: current.botId, threadId: current.threadId, contextId: current.contextId, requestId: current.requestId, sourceMessageId: turn.sourceMessageId,
                text: turn.text, cwd: turn.cwd, ...(!cursor || turn.sessionReset || transition === "workspace" ? { instructions: turn.system } : {}),
                ...(transition ? { contextTransition: transition, previousContextId: cursor } : {}),
                model: turn.model, approvalMode: turn.approvalMode,
              });
              if (current.stopping) await gateway().interrupt(current, { scope: "request", requestId: current.requestId });
            } catch (error) {
              if (active.get(turn.threadId) === current) {
                emit({ ...base(current), type: "runtime.error", message: redactSecretsInText(error instanceof Error ? error.message : String(error)), terminal: true });
                finish(current, false);
              }
            }
            return { turnId: current.requestId };
          },
          async interruptTurn(threadId, turnId) {
            const turn = active.get(threadId);
            if (!turn) {
              const binding = options.currentBinding?.(threadId);
              if (binding && (!turnId || binding.requestId === turnId)) {
                await gateway().interrupt(binding, binding.requestId ? { scope: "request", requestId: binding.requestId } : { scope: "conversation" });
                for (const decision of decisions.values()) if (decision.threadId === threadId && (!binding.requestId || decision.requestId === binding.requestId)) resolveDecision(decision, "deny", "system");
              }
              return;
            }
            if (turnId && turn.requestId !== turnId) return;
            turn.stopping = true;
            const request = requests.get(turn.requestId);
            if (request) request.stopped = true;
            await gateway().interrupt(turn, { scope: "request", requestId: turn.requestId });
            for (const decision of decisions.values()) if (decision.threadId === threadId && decision.requestId === turn.requestId) resolveDecision(decision, "deny", "system");
            finish(turn, false, "interrupted");
          },
          async respondToRequest(threadId, decisionId, decision) {
            let pending = decisions.get(decisionId);
            if (!pending) {
              const snapshot = await gateway().inspect?.();
              const restored = snapshot?.decisions.find(decision => decision.threadId === threadId && decision.decisionId === decisionId);
              if (restored) openDecision(restored);
              pending = decisions.get(decisionId);
            }
            if (!pending || pending.threadId !== threadId || !valid(pending)) return "unavailable";
            const turn = pending;
            let accepted = false;
            answering.set(decisionId, decision.behavior);
            try { accepted = await gateway().respond(turn, decisionId, { behavior: decision.behavior, message: decision.message }); }
            catch { return "unavailable"; }
            finally { answering.delete(decisionId); }
            if (!accepted) return "unavailable";
            resolveDecision(turn, decision.behavior, "user");
            return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "deny" ? "rejected" : "answered";
          },
          hasSession: (threadId) => sessions.has(threadId),
          enginePid: () => options.gateway().status().pid,
          async stopAll() {
            for (const turn of active.values()) {
              turn.stopping = true;
              const request = requests.get(turn.requestId);
              if (request) request.stopped = true;
              await gateway().interrupt(turn, { scope: "conversation" });
              finish(turn, false, "interrupted");
            }
            for (const decision of decisions.values()) resolveDecision(decision, "deny", "system");
          },
          onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        },
        async dispose() { connections.delete(connect); unsubscribe?.(); listeners.clear(); },
      };
    },
  };
}
