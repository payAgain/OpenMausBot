import { api } from "@/state/api";
import {
  createTranscriptState,
  reconcileSnapshot,
  reduceRuntimeEvent,
  type PendingDecision,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type TranscriptState,
} from "../../packages/personbot-projection/src/index.ts";
import type {
  ArtifactRecord, ArtifactSnapshot, ChannelDeliveryRecord, CommandParamsMap, IntegrationSnapshot, MemoryRecord, Method, PersonalSnapshot,
  ProjectRecord, QuestionResult, RoleRecord, TaskAction, TaskRecord, TaskSnapshot,
} from "../../packages/personbot-protocol/src/index.ts";

export interface PersonbotStatus {
  enabled: boolean;
  state: "stopped" | "starting" | "ready" | "failed" | "closing";
  workspace: string;
  provider: string;
  model: string;
  error?: string;
}

export interface PersonbotClientState {
  status?: PersonbotStatus;
  transcript: TranscriptState;
  selectedId: string | null;
  connection: "connecting" | "connected" | "reconnecting" | "offline";
  error?: string;
  actionError?: string;
  action: string | null;
  tasks: TaskSnapshot;
  personal?: PersonalSnapshot;
  artifacts?: ArtifactSnapshot;
  integrations?: IntegrationSnapshot;
}

type SubmitParams = CommandParamsMap["personbot.v1.messages.submit"];
type Listener = () => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function personbotRpc<T, M extends Method = Method>(method: M, params: CommandParamsMap[M], signal?: AbortSignal): Promise<T> {
  return api<T>("/api/personbot/rpc", {
    method: "POST",
    body: JSON.stringify({ method, params }),
    timeoutMs: 45_000,
    signal,
  });
}

export class PersonbotClient {
  private current: PersonbotClientState = {
    transcript: createTranscriptState(),
    selectedId: null,
    connection: "connecting",
    action: null,
    tasks: { tasks: [], executions: [], updates: [] },
  };
  private readonly listeners = new Set<Listener>();
  private readonly lifetime = new AbortController();
  private source?: EventSource;
  private timer?: ReturnType<typeof setInterval>;
  private disposalTimer?: ReturnType<typeof setTimeout>;
  private refreshPromise?: Promise<void>;
  private refreshRequested = false;
  private connectionRevision = 0;
  private streamRevision = 0;
  private readonly creates = new Map<string, CommandParamsMap["personbot.v1.sessions.create"]>();
  private selectionKey?: string;
  private savedSelection?: string;
  private readonly resumed = new Map<string, Promise<void>>();
  private readonly sends = new Map<string, SubmitParams>();
  private readonly stops = new Map<string, string>();
  private readonly taskCommands = new Map<string, CommandParamsMap["personbot.v1.tasks.create"] | CommandParamsMap["personbot.v1.tasks.control"]>();
  private readonly personalCommands = new Map<string, Record<string, unknown>>();

  readonly getSnapshot = (): PersonbotClientState => this.current;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.disposalTimer) {
      clearTimeout(this.disposalTimer);
      this.disposalTimer = undefined;
      return;
    }
    void this.connect();
    this.timer = setInterval(() => {
      if (document.visibilityState !== "hidden" && this.current.status?.enabled) {
        void this.refresh().catch((error: unknown) => this.update({ error: errorText(error) }));
      }
    }, 3_000);
  }

  dispose(): void {
    this.disposalTimer = setTimeout(() => {
      this.lifetime.abort();
      this.source?.close();
      if (this.timer) clearInterval(this.timer);
      this.listeners.clear();
      this.personalCommands.clear();
    }, 0);
  }

  suspend(): void {
    this.connectionRevision++;
    this.streamRevision++;
    this.source?.close();
    this.source = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.update({ connection: "offline" });
  }

  retry(): void {
    if (this.lifetime.signal.aborted) return;
    this.source?.close();
    void this.connect();
  }

  async select(sessionId: string): Promise<void> {
    this.update({ selectedId: sessionId, actionError: undefined });
    if (this.current.connection !== "connected") return;
    try {
      await this.resume(sessionId);
      await this.refresh();
    } catch (error) {
      this.update({ actionError: errorText(error) });
    }
  }

  async create(binding: { projectId?: string; roleId?: string } = {}): Promise<string | undefined> {
    const projectId = binding.projectId ?? this.current.personal?.projects.find((project) => project.id === "default")?.id;
    const roleId = binding.roleId ?? this.current.personal?.roles.find((role) => role.id === "assistant")?.id;
    const key = JSON.stringify([projectId, roleId]);
    let params = this.creates.get(key);
    if (!params) {
      const sessionId = crypto.randomUUID();
      params = { sessionId, conversationId: sessionId, ...(projectId ? { projectId } : {}), ...(roleId ? { roleId } : {}) };
      this.creates.set(key, params);
    }
    const creating = params;
    return this.perform("create", async () => {
      try {
        await personbotRpc("personbot.v1.sessions.create", creating, this.lifetime.signal);
      } catch (error) {
        if (this.definiteRejection(error)) this.creates.delete(key);
        throw error;
      }
      this.creates.delete(key);
      const sessionId = creating.sessionId;
      this.resumed.set(`${this.current.transcript.generation}:${sessionId}`, Promise.resolve());
      this.update({ selectedId: sessionId });
      await this.refreshAfterMutation();
      return sessionId;
    });
  }

  saveProject(input: { id?: string; name: string; path: string; kind: ProjectRecord["kind"]; revision?: number }): Promise<boolean> {
    const { revision, ...identity } = input;
    return this.personalMutation("personbot.v1.projects.put", identity, {
      projectId: input.id ?? crypto.randomUUID(), name: input.name, path: input.path, kind: input.kind,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  saveRole(input: { id?: string; name: string; instructions: string; revision?: number }): Promise<boolean> {
    const { revision, ...identity } = input;
    return this.personalMutation("personbot.v1.roles.put", identity, {
      roleId: input.id ?? crypto.randomUUID(), name: input.name, instructions: input.instructions,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  saveMemory(input: { id?: string; scope: MemoryRecord["scope"]; projectId?: string; key: string; value: string; revision?: number }): Promise<boolean> {
    const { revision, ...identity } = input;
    return this.personalMutation("personbot.v1.memory.put", identity, {
      memoryId: input.id ?? crypto.randomUUID(), scope: input.scope, key: input.key, value: input.value,
      ...(input.scope === "project" && input.projectId ? { projectId: input.projectId } : {}),
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  controlMemory(memory: MemoryRecord, action: "confirm" | "forget"): Promise<boolean> {
    return this.personalMutation("personbot.v1.memory.control", { id: memory.id, action }, {
      memoryId: memory.id, expectedRevision: memory.revision, action,
    });
  }

  publishArtifact(sessionId: string, path: string, name?: string): Promise<boolean> {
    return this.personalMutation("personbot.v1.artifacts.publish", { sessionId, path, name }, {
      artifactId: crypto.randomUUID(), sessionId, path, ...(name?.trim() ? { name } : {}),
    });
  }

  async saveSource(input: Omit<CommandParamsMap["personbot.v1.sources.put"], "commandId" | "sourceId" | "expectedRevision"> & { id?: string; revision?: number }): Promise<boolean> {
    const { id, revision, ...fields } = input;
    const { token, ...identity } = fields;
    const tokenHash = token ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (byte) => byte.toString(16).padStart(2, "0")).join("") : undefined;
    return this.personalMutation("personbot.v1.sources.put", { id, ...identity, tokenHash }, {
      ...fields, sourceId: id ?? crypto.randomUUID(), ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  saveSubscription(input: Omit<CommandParamsMap["personbot.v1.subscriptions.put"], "commandId" | "subscriptionId" | "expectedRevision"> & { id?: string; revision?: number }): Promise<boolean> {
    const { id, revision, ...fields } = input;
    return this.personalMutation("personbot.v1.subscriptions.put", { id, ...fields }, {
      ...fields, subscriptionId: id ?? crypto.randomUUID(), ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  saveSchedule(input: Omit<CommandParamsMap["personbot.v1.schedules.put"], "commandId" | "scheduleId" | "expectedRevision"> & { id?: string; revision?: number }): Promise<boolean> {
    const { id, revision, ...fields } = input;
    return this.personalMutation("personbot.v1.schedules.put", { id, ...fields }, {
      ...fields, scheduleId: id ?? crypto.randomUUID(), ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  controlDelivery(delivery: ChannelDeliveryRecord, action: "retry" | "mark_delivered"): Promise<boolean> {
    if (delivery.state !== "uncertain" && delivery.state !== "failed") return Promise.resolve(false);
    return this.personalMutation("personbot.v1.deliveries.control", { id: delivery.id, action }, {
      deliveryId: delivery.id, expectedState: delivery.state, action,
    });
  }

  async submit(sessionId: string, text: string, mode: "followup" | "steer"): Promise<boolean> {
    if (this.current.transcript.sessions[sessionId]?.summary?.taskId) {
      this.update({ actionError: "任务会话由监督层管理，请通过任务操作继续执行。" });
      return false;
    }
    let params = this.sends.get(sessionId);
    if (!params || params.text !== text || params.mode !== mode) {
      params = { commandId: crypto.randomUUID(), messageId: crypto.randomUUID(), sessionId, text, mode };
      this.sends.set(sessionId, params);
    }
    const sent = params;
    return (await this.perform("send", async () => {
      await personbotRpc("personbot.v1.messages.submit", sent, this.lifetime.signal);
      this.sends.delete(sessionId);
      await this.refreshAfterMutation();
      return true;
    })) ?? false;
  }

  async stop(sessionId: string): Promise<void> {
    if (this.current.transcript.sessions[sessionId]?.summary?.taskId) {
      this.update({ actionError: "请使用任务的暂停或终止操作，保存任务状态并停止执行。" });
      return;
    }
    const commandId = this.stops.get(sessionId) ?? crypto.randomUUID();
    this.stops.set(sessionId, commandId);
    await this.perform("stop", async () => {
      const result = await personbotRpc<{ confirmed: boolean; errors: string[] }>(
        "personbot.v1.sessions.stop", { commandId, sessionId }, this.lifetime.signal,
      );
      this.stops.delete(sessionId);
      if (!result.confirmed) throw new Error(result.errors.join("; ") || "停止尚未确认，请重试。");
      await this.refreshAfterMutation();
    });
  }

  async createTask(originSessionId: string, goal: string, criteria: string[], context?: string): Promise<boolean> {
    const key = JSON.stringify(["create", originSessionId, goal, criteria, context]);
    const params = this.taskCommands.get(key) as CommandParamsMap["personbot.v1.tasks.create"] | undefined ?? {
      commandId: crypto.randomUUID(), taskId: crypto.randomUUID(), originSessionId, goal, criteria,
      ...(context?.trim() ? { context } : {}),
    };
    this.taskCommands.set(key, params);
    return (await this.perform("task:create", async () => {
      await this.taskMutation("personbot.v1.tasks.create", params, key);
      return true;
    })) ?? false;
  }

  async controlTask(task: TaskRecord, action: TaskAction, text?: string): Promise<boolean> {
    const key = JSON.stringify(["control", task.id, action, text]);
    const params = this.taskCommands.get(key) as CommandParamsMap["personbot.v1.tasks.control"] | undefined ?? {
      commandId: crypto.randomUUID(), taskId: task.id, expectedRevision: task.revision, action,
      ...(text?.trim() ? { text } : {}),
    };
    this.taskCommands.set(key, params);
    return (await this.perform(`task:${task.id}:${action}`, async () => {
      await this.taskMutation("personbot.v1.tasks.control", params, key);
      return true;
    })) ?? false;
  }

  async decide(decision: PendingDecision, result: "allowed-once" | "rejected" | QuestionResult): Promise<void> {
    await this.perform(decision.requestId, async () => {
      if (decision.kind === "approval") {
        if (result !== "allowed-once" && result !== "rejected") return;
        await personbotRpc("personbot.v1.approvals.resolve", {
          requestId: decision.requestId, generation: decision.generation, outcome: result,
        }, this.lifetime.signal);
      } else {
        if (typeof result === "string") return;
        await personbotRpc("personbot.v1.questions.answer", {
          requestId: decision.requestId, generation: decision.generation, result,
        }, this.lifetime.signal);
      }
      await this.refreshAfterMutation();
    });
  }

  refresh(): Promise<void> {
    this.refreshRequested = true;
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = async () => {
      while (this.refreshRequested && !this.lifetime.signal.aborted) {
        this.refreshRequested = false;
        const snapshot = await personbotRpc<RuntimeSnapshot>("personbot.v1.snapshots.get", {}, this.lifetime.signal);
        this.applySnapshot(snapshot);
        const tasks = await personbotRpc<TaskSnapshot>("personbot.v1.tasks.list", {}, this.lifetime.signal);
        if (!Array.isArray(tasks.tasks) || !Array.isArray(tasks.executions) || !Array.isArray(tasks.updates)) {
          throw new Error("任务状态无法读取，请重新连接。");
        }
        this.update({ tasks });
        const [personal, artifacts, integrations] = await Promise.all([
          personbotRpc<PersonalSnapshot>("personbot.v1.personal.snapshot", {}, this.lifetime.signal),
          personbotRpc<ArtifactSnapshot>("personbot.v1.artifacts.list", {}, this.lifetime.signal),
          personbotRpc<IntegrationSnapshot>("personbot.v1.integrations.snapshot", {}, this.lifetime.signal),
        ]);
        this.update({
          personal: {
            projects: Array.isArray(personal.projects) ? personal.projects : [],
            roles: Array.isArray(personal.roles) ? personal.roles : [],
            memories: Array.isArray(personal.memories) ? personal.memories : [],
          },
          artifacts: { artifacts: Array.isArray(artifacts.artifacts) ? artifacts.artifacts : [] },
          integrations: {
            sources: Array.isArray(integrations.sources) ? integrations.sources : [],
            subscriptions: Array.isArray(integrations.subscriptions) ? integrations.subscriptions : [],
            schedules: Array.isArray(integrations.schedules) ? integrations.schedules : [],
            triggers: Array.isArray(integrations.triggers) ? integrations.triggers : [],
            deliveries: Array.isArray(integrations.deliveries) ? integrations.deliveries : [],
          },
        });
        const available = new Set(snapshot.sessions.map((session) => session.sessionId));
        const selectedId = this.current.selectedId && available.has(this.current.selectedId)
          ? this.current.selectedId
          : this.savedSelection && available.has(this.savedSelection)
            ? this.savedSelection
            : snapshot.sessions.find((session) => session.conversationId)?.sessionId ?? snapshot.sessions[0]?.sessionId;
        if (this.current.selectedId !== (selectedId ?? null)) this.update({ selectedId: selectedId ?? null });
        if (!selectedId) continue;
        let projection = this.current.transcript.sessions[selectedId];
        let cursor = projection?.nextSeq ?? 0;
        do {
          const page = await personbotRpc<RuntimeSnapshot>("personbot.v1.snapshots.get", {
            sessionId: selectedId, fromSeq: cursor, limit: 128,
          }, this.lifetime.signal);
          this.applySnapshot(page);
          projection = this.current.transcript.sessions[selectedId];
          const next = projection?.nextSeq ?? cursor;
          const hasMore = page.logs.find((log) => log.sessionId === selectedId)?.hasMore;
          if (!hasMore) break;
          if (next <= cursor) throw new Error("会话历史暂未连续，正在等待恢复。");
          cursor = next;
        } while (!this.lifetime.signal.aborted && this.current.selectedId === selectedId);
        if (this.current.selectedId === selectedId) await this.resume(selectedId);
      }
      this.update({ error: undefined });
    };
    this.refreshPromise = refresh().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async connect(): Promise<void> {
    const revision = ++this.connectionRevision;
    this.update({ connection: "connecting", error: undefined });
    try {
      const [status, environment] = await Promise.all([
        api<PersonbotStatus>("/api/personbot/status", { signal: this.lifetime.signal }),
        api<{ environmentId?: string }>("/.well-known/openmausbot/environment", { timeoutMs: 5_000, signal: this.lifetime.signal }).catch(() => undefined),
      ]);
      if (revision !== this.connectionRevision || this.lifetime.signal.aborted) return;
      this.selectionKey = `personbot:selected:${environment?.environmentId ?? status.workspace}`;
      try { this.savedSelection = localStorage.getItem(this.selectionKey) ?? undefined; } catch {}
      this.update({ status });
      if (!status.enabled) {
        this.update({ connection: "offline" });
        return;
      }
      const source = this.source = new EventSource("/api/personbot/events");
      source.onopen = () => {
        if (revision !== this.connectionRevision || this.lifetime.signal.aborted) return;
        const streamRevision = ++this.streamRevision;
        void this.refresh().then(() => {
          if (revision === this.connectionRevision && streamRevision === this.streamRevision && !this.lifetime.signal.aborted) {
            this.update({ connection: "connected", error: undefined });
          }
        }).catch((error: unknown) => {
          if (revision === this.connectionRevision && streamRevision === this.streamRevision) {
            this.update({ connection: "reconnecting", error: errorText(error) });
          }
        });
      };
      source.onmessage = (message) => {
        if (revision !== this.connectionRevision || this.lifetime.signal.aborted) return;
        try {
          const frame = JSON.parse(message.data) as { kind?: string; event?: RuntimeEvent; state?: PersonbotStatus["state"]; error?: string };
          if (frame.kind === "runtime" && frame.event) {
            this.update({ transcript: reduceRuntimeEvent(this.current.transcript, frame.event) });
            if (["task.changed", "personal.changed", "integrations.changed"].includes(frame.event.type)) {
              void this.refresh().catch((error: unknown) => this.update({ error: errorText(error) }));
            }
          } else if (frame.kind === "gateway" && this.current.status && frame.state) {
            this.update({ status: { ...this.current.status, state: frame.state, error: frame.error } });
          }
        } catch {
          this.update({ error: "收到无法读取的会话更新，请重新连接。" });
        }
      };
      source.onerror = () => {
        if (revision !== this.connectionRevision || this.lifetime.signal.aborted) return;
        this.streamRevision++;
        this.update({ connection: "reconnecting", error: "连接已中断，正在恢复会话。" });
      };
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.update({ connection: "offline", error: errorText(error) });
    }
  }

  private applySnapshot(snapshot: RuntimeSnapshot): void {
    this.update({ transcript: reconcileSnapshot(this.current.transcript, snapshot) });
  }

  private async refreshAfterMutation(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.update({ error: errorText(error) });
    }
  }

  private resume(sessionId: string): Promise<void> {
    if (this.current.transcript.sessions[sessionId]?.summary?.taskId) return Promise.resolve();
    const key = `${this.current.transcript.generation}:${sessionId}`;
    const resumed = this.resumed.get(key);
    if (resumed) return resumed;
    const opening = personbotRpc("personbot.v1.sessions.resume", { sessionId }, this.lifetime.signal)
      .then(() => {});
    this.resumed.set(key, opening);
    void opening.catch(() => { if (this.resumed.get(key) === opening) this.resumed.delete(key); });
    return opening;
  }

  private async taskMutation<M extends "personbot.v1.tasks.create" | "personbot.v1.tasks.control">(
    method: M, params: CommandParamsMap[M], key: string,
  ): Promise<void> {
    try {
      await personbotRpc(method, params, this.lifetime.signal);
    } catch (error) {
      if (this.definiteRejection(error)) this.taskCommands.delete(key);
      throw error;
    }
    this.taskCommands.delete(key);
    await this.refreshAfterMutation();
  }

  private async personalMutation<M extends "personbot.v1.projects.put" | "personbot.v1.roles.put" | "personbot.v1.memory.put" | "personbot.v1.memory.control" | "personbot.v1.artifacts.publish" | "personbot.v1.sources.put" | "personbot.v1.subscriptions.put" | "personbot.v1.schedules.put" | "personbot.v1.deliveries.control">(
    method: M, identity: unknown, input: Omit<CommandParamsMap[M], "commandId">,
  ): Promise<boolean> {
    if (this.current.action || this.current.connection !== "connected") return false;
    const key = JSON.stringify([method, identity]);
    const params = this.personalCommands.get(key) ?? { ...input, commandId: crypto.randomUUID() };
    this.personalCommands.set(key, params);
    return (await this.perform(method, async () => {
      try {
        await personbotRpc<ArtifactRecord | ProjectRecord | RoleRecord | MemoryRecord, M>(
          method, params as CommandParamsMap[M], this.lifetime.signal,
        );
      } catch (error) {
        if (this.definiteRejection(error)) this.personalCommands.delete(key);
        throw error;
      }
      this.personalCommands.delete(key);
      await this.refreshAfterMutation();
      return true;
    })) ?? false;
  }

  private definiteRejection(error: unknown): boolean {
    const status = (error as { status?: unknown } | undefined)?.status;
    return typeof status === "number" && status >= 400 && status < 500;
  }

  private async perform<T>(action: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (this.current.action || this.current.connection !== "connected") return undefined;
    this.update({ action, actionError: undefined });
    try {
      return await operation();
    } catch (error) {
      this.update({ actionError: errorText(error) });
      void this.refresh().catch(() => {});
      return undefined;
    } finally {
      this.update({ action: null });
    }
  }

  private update(patch: Partial<PersonbotClientState>): void {
    if (this.lifetime.signal.aborted) return;
    this.current = { ...this.current, ...patch };
    if (patch.selectedId !== undefined && this.selectionKey) {
      this.savedSelection = patch.selectedId ?? undefined;
      try {
        if (patch.selectedId) localStorage.setItem(this.selectionKey, patch.selectedId);
        else localStorage.removeItem(this.selectionKey);
      } catch {}
    }
    this.listeners.forEach((listener) => listener());
  }
}
