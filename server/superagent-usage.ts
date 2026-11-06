import type { SuperagentBinding, SuperagentUsage } from "../shared/superagent.ts";
import { appendUsageOnce, type UsageRow, type UsageTrigger } from "./usage-ledger.ts";

export type SuperagentUsageEvent = SuperagentBinding & SuperagentUsage & { type: "usage" };

export interface SuperagentUsageOptions {
  dataDir: string;
  bot?: (id: string) => { name: string; section?: string } | null | undefined;
  trigger?: (event: SuperagentUsageEvent) => UsageTrigger | undefined;
  /** Runs only after a new original-ledger row is durably stored; duplicate delivery cannot add task counters twice. */
  onBooked?: (row: UsageRow, event: SuperagentUsageEvent) => void | Promise<void>;
  now?: () => Date;
}

const ID = /^[\w.:/-]{1,512}$/;

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`Invalid native usage ${field}`);
  return value;
}

function tokens(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid native usage ${field}`);
  return value;
}

/** Projects actual native calls into the original usage ledger, including background workers and tool-free upkeep. */
export function createSuperagentUsage(options: SuperagentUsageOptions) {
  return {
    async handle(event: SuperagentUsageEvent): Promise<{ newlyBooked: boolean; row: UsageRow }> {
      if (!event || event.type !== "usage" || !["master", "worker", "upkeep"].includes(event.role)) {
        throw new TypeError("Invalid native usage event");
      }
      const usageId = identity(event.usageId, "usageId");
      const requestId = identity(event.requestId, "requestId");
      const agentId = identity(event.agentId, "agentId");
      const helper = event.role === "upkeep";
      const botId = helper ? "__superagent_upkeep__" : identity(event.botId, "botId");
      const threadId = helper ? "superagent-upkeep" : identity(event.threadId, "threadId");
      const bot = helper ? undefined : options.bot?.(botId);
      const costUsd = typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0 ? event.costUsd : null;
      const row: UsageRow = {
        at: (options.now?.() ?? new Date()).toISOString(),
        usageId, botId, threadId,
        botName: helper ? "Super Agent memory upkeep" : bot?.name ?? botId,
        instanceId: "dsh-superagent", driverKind: "dsh-superagent",
        model: event.model?.slice(0, 256) || "unknown",
        ...(event.provider ? { provider: event.provider.slice(0, 256) } : {}),
        input: tokens(event.inputTokens, "inputTokens"), output: tokens(event.outputTokens, "outputTokens"),
        ...(event.cacheReadTokens !== undefined ? { cachedInput: tokens(event.cacheReadTokens, "cacheReadTokens") } : {}),
        ...(event.cacheWriteTokens !== undefined ? { cacheWrite: tokens(event.cacheWriteTokens, "cacheWriteTokens") } : {}),
        costUsd, ...(costUsd !== null ? { costSource: "reported" as const } : {}),
        trigger: helper ? { kind: "helper", job: "memory-upkeep" } : options.trigger?.(event) ?? { kind: "owner" },
        ...(bot?.section ? { section: bot.section } : {}),
        turnId: requestId, requestId, agentId, agentRole: event.role, usageStatus: "complete",
        ...(event.ticketId ? { ticketId: identity(event.ticketId, "ticketId") } : {}),
        ...(event.contextId ? { contextId: identity(event.contextId, "contextId") } : {}),
      };
      const newlyBooked = await appendUsageOnce(options.dataDir, row);
      if (newlyBooked) await options.onBooked?.(row, event);
      return { newlyBooked, row };
    },
  };
}
