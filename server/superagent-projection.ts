import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { SuperagentBinding } from "../shared/superagent.ts";
import { commandReceipt } from "./commands.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store } from "./store.ts";

interface ProjectionOptions {
  store: Pick<Store, "botByThread" | "taskByThread" | "activePath" | "messagesFor" | "appendMessage" | "patchMessage">;
  currentContext(binding: SuperagentBinding): boolean;
  attention?(binding: SuperagentBinding, kind: "approval" | "question", summary: string): void;
}

export function createSuperagentProjection(options: ProjectionOptions) {
  return (event: RuntimeEvent): boolean => {
    const native = event.nativeTask;
    if (!native || event.type !== "request.opened" && event.type !== "request.resolved" && event.type !== "runtime.notice") return false;
    const binding = { botId: native.botId, threadId: event.threadId, contextId: native.contextId };
    if (options.store.botByThread(binding.threadId)?.id !== binding.botId) return true;
    if (event.type === "request.resolved") {
      const previous = options.store.messagesFor(binding.threadId).find(message => message.card?.requestId === event.requestId
        && message.card?.superagent?.contextId === binding.contextId);
      if (previous?.card && !previous.card.answered) options.store.patchMessage(binding.threadId, previous.id, {
        card: {
          ...previous.card, answered: event.behavior, dismissed: event.source !== "user",
          ...(event.source === "system" || event.source === "unavailable" ? { expired: true } : {}),
        },
      });
      return true;
    }
    if (!options.store.taskByThread(binding.botId, binding.threadId) || !options.currentContext(binding)) return true;
    const source = options.store.activePath(binding.threadId).find(message => message.id === native.sourceMessageId);
    if (!source || source.role !== "user" || source.kind !== "text"
      || event.type === "request.opened" && source.requestCancelled || !event.turnId) return true;
    const command = {
      kind: event.type === "request.opened" ? "superagent.decision" : "superagent.task-notice",
      key: JSON.stringify([binding.botId, binding.threadId, binding.contextId,
        event.type === "request.opened" ? event.requestId : native.ticketId]),
    };
    const previous = commandReceipt<Message>(command.kind, command.key);
    if (previous) {
      if (event.type === "runtime.notice") options.store.patchMessage(binding.threadId, previous.result.id, {
        tool: { name: redactSecretsInText(event.message).slice(0, 400), ok: true },
      });
      return true;
    }
    if (event.type === "request.opened") {
      if (!event.requestId) return true;
      const question = event.requestType === "question";
      const summary = redactSecretsInText(event.summary).slice(0, 8_000);
      options.store.appendMessage(binding.threadId, {
        role: "bot", kind: "options", turnId: event.turnId, requestMessageId: source.id,
        card: {
          title: question ? "Your bot has a question" : "Approval needed", subtitle: summary,
          options: question ? [] : ["Allow", "Deny"], requestId: event.requestId,
          requestType: event.requestType, tool: question ? undefined : event.tool, allowSession: false,
          ...(event.questions ? { questionRequest: { version: 1, questions: event.questions } } : {}),
          superagent: {
            contextId: native.contextId, requestId: event.turnId, ticketId: native.ticketId,
            agentId: native.agentId, callId: native.callId, authorizationVersion: native.authorizationVersion,
          },
        },
      }, command);
      options.attention?.(binding, question ? "question" : "approval", summary);
    } else if (event.type === "runtime.notice") {
      options.store.appendMessage(binding.threadId, {
        role: "bot", kind: "activity", turnId: event.turnId, requestMessageId: source.id,
        tool: { name: redactSecretsInText(event.message).slice(0, 400), ok: true },
      }, command);
    }
    return true;
  };
}
