import type { SuperagentBinding, SuperagentDelivery } from "../shared/superagent.ts";
import { commandReceipt } from "./commands.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store } from "./store.ts";

interface DeliveryOptions {
  store: Pick<Store, "botByThread" | "taskByThread" | "activePath" | "appendMessage">;
  currentContext(binding: SuperagentBinding): boolean;
  onPersist?(delivery: SuperagentDelivery, message: Message): void;
}

export function createSuperagentDelivery(options: DeliveryOptions) {
  return (delivery: SuperagentDelivery): Message => {
    if (!delivery.contextId || !delivery.messageId || !delivery.requestId || typeof delivery.text !== "string"
      || options.store.botByThread(delivery.threadId)?.id !== delivery.botId
      || !options.store.taskByThread(delivery.botId, delivery.threadId) || !options.currentContext(delivery)) {
      throw new Error("The original Super Agent conversation is no longer active");
    }
    const source = options.store.activePath(delivery.threadId).find(message => message.id === delivery.sourceMessageId);
    if (!source || source.role !== "user" || source.kind !== "text" || source.requestCancelled) {
      throw new Error("The original request is no longer available");
    }
    const command = {
      kind: "superagent.delivery",
      key: JSON.stringify([delivery.botId, delivery.threadId, delivery.contextId, delivery.messageId]),
    };
    const previous = commandReceipt<Message>(command.kind, command.key);
    if (previous) return previous.result;
    const final = delivery.purpose === "result" || delivery.purpose === "answer" || delivery.purpose === "reply";
    const message = options.store.appendMessage(delivery.threadId, {
      role: "bot", kind: "text", text: redactSecretsInText(delivery.text),
      turnId: delivery.requestId, requestMessageId: source.id,
      ...(final ? { turnTerminal: true, turnSucceeded: true, turnCompletedAt: Date.now() } : {}),
    }, command);
    options.onPersist?.(delivery, message);
    return message;
  };
}
