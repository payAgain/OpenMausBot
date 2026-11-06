import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SuperagentBinding, SuperagentTaskUsage, SuperagentUsageTotals } from "../shared/superagent.ts";
import { flushUsageLedger, readUsage, type UsageRow } from "./usage-ledger.ts";

function totalUsage(rows: readonly UsageRow[]): SuperagentUsageTotals {
  const total = {
    calls: rows.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    knownCostUsd: 0, unpricedCalls: 0,
  };
  for (const row of rows) {
    total.inputTokens += row.input;
    total.outputTokens += row.output;
    total.cacheReadTokens += row.cachedInput ?? 0;
    total.cacheWriteTokens += row.cacheWrite ?? 0;
    if (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0) total.unpricedCalls += 1;
    else total.knownCostUsd += row.costUsd;
  }
  return { ...total, costUsd: rows.length && !total.unpricedCalls ? total.knownCostUsd : null };
}

export async function superagentTaskUsage(dataDir: string, task: SuperagentBinding & { ticketId: string }): Promise<SuperagentTaskUsage> {
  await flushUsageLedger(dataDir);
  let firstMonth: string | undefined;
  try {
    firstMonth = readdirSync(join(dataDir, "usage")).filter(name => /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/.test(name)).sort()[0]?.slice(0, 7);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rows = firstMonth ? readUsage(dataDir, {
    from: new Date(`${firstMonth}-01T00:00:00Z`), to: new Date(),
  }).filter(row => row.driverKind === "dsh-superagent"
    && row.botId === task.botId && row.threadId === task.threadId && row.contextId === task.contextId) : [];
  return {
    attribution: "ticket-exclusive",
    ...totalUsage(rows.filter(row => row.ticketId === task.ticketId)),
    shared: {
      botId: task.botId, threadId: task.threadId,
      ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
      attribution: "context-unallocated", exclusive: false, includedInTaskTotal: false,
      ...totalUsage(rows.filter(row => !row.ticketId)),
    },
  };
}
