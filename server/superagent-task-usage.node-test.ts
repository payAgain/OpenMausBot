import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSuperagentUsage } from "./superagent-usage.ts";
import { superagentTaskUsage } from "./superagent-task-usage.ts";

test("reports a task's actual original-ledger usage without mixing contexts or treating unpriced calls as free", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "superagent-task-cost-"));
  const binding = { botId: "bot", threadId: "thread", contextId: "context", ticketId: "task" };
  try {
    const usage = createSuperagentUsage({ dataDir });
    const call = {
      ...binding, type: "usage" as const, requestId: "request", agentId: "worker", role: "worker" as const,
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 5,
    };
    await usage.handle({ ...call, usageId: "known", costUsd: 0.25 });
    await usage.handle({ ...call, usageId: "unpriced", inputTokens: 50, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 2 });
    await usage.handle({ ...call, usageId: "foreign-context", contextId: "other", costUsd: 99 });
    await usage.handle({ ...call, usageId: "other-task", ticketId: "other-task", costUsd: 99 });
    await usage.handle({ ...call, usageId: "known", costUsd: 0.25 });
    assert.deepEqual(await superagentTaskUsage(dataDir, binding), {
      attribution: "ticket-exclusive",
      calls: 2, inputTokens: 150, outputTokens: 30, cacheReadTokens: 30, cacheWriteTokens: 7,
      knownCostUsd: 0.25, unpricedCalls: 1, costUsd: null,
      shared: {
        botId: binding.botId, threadId: binding.threadId, contextId: binding.contextId,
        attribution: "context-unallocated", exclusive: false, includedInTaskTotal: false,
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        knownCostUsd: 0, unpricedCalls: 0, costUsd: null,
      },
    });
    assert.deepEqual(await superagentTaskUsage(dataDir, { ...binding, ticketId: "no-calls" }), {
      attribution: "ticket-exclusive",
      calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      knownCostUsd: 0, unpricedCalls: 0, costUsd: null,
      shared: {
        botId: binding.botId, threadId: binding.threadId, contextId: binding.contextId,
        attribution: "context-unallocated", exclusive: false, includedInTaskTotal: false,
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        knownCostUsd: 0, unpricedCalls: 0, costUsd: null,
      },
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("shows shared main overhead without allocating it repeatedly to tickets or dropping cache-write tokens", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "superagent-task-attribution-"));
  const binding = { botId: "bot", threadId: "thread", contextId: "context" };
  try {
    const usage = createSuperagentUsage({ dataDir });
    const call = {
      ...binding, type: "usage" as const, requestId: "one-input-creates-two-tickets", agentId: "worker",
      role: "worker" as const, inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 5,
    };
    await usage.handle({ ...call, usageId: "ticket-first", ticketId: "first", costUsd: 0.25 });
    await usage.handle({ ...call, usageId: "ticket-second", ticketId: "second", costUsd: 0.75 });
    const main = {
      ...call, role: "master" as const, agentId: "main", inputTokens: 30, outputTokens: 8,
      cacheReadTokens: 7, cacheWriteTokens: 3,
    };
    await usage.handle({ ...main, usageId: "shared-known", costUsd: 0.5 });
    await usage.handle({ ...main, usageId: "shared-unpriced", inputTokens: 20, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 4 });
    await usage.handle({ ...main, usageId: "shared-other-request", requestId: "a-later-input", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1, costUsd: 0.25 });
    await usage.handle({ ...main, usageId: "foreign-main-context", contextId: "other-context", costUsd: 99 });
    await usage.handle({ ...main, usageId: "foreign-main-thread", threadId: "other-thread", costUsd: 99 });
    await usage.handle({ ...main, usageId: "foreign-main-bot", botId: "other-bot", costUsd: 99 });
    const first = await superagentTaskUsage(dataDir, { ...binding, ticketId: "first" });
    const second = await superagentTaskUsage(dataDir, { ...binding, ticketId: "second" });
    assert.equal(first.attribution, "ticket-exclusive");
    assert.equal(second.attribution, "ticket-exclusive");
    assert.equal(first.calls, 1);
    assert.equal(first.costUsd, 0.25);
    assert.equal(second.calls, 1);
    assert.equal(second.costUsd, 0.75);
    assert.equal(first.cacheWriteTokens, 5);
    assert.deepEqual(first.shared, {
      ...binding,
      attribution: "context-unallocated", exclusive: false, includedInTaskTotal: false,
      calls: 3, inputTokens: 60, outputTokens: 15, cacheReadTokens: 9, cacheWriteTokens: 8,
      knownCostUsd: 0.75, unpricedCalls: 1, costUsd: null,
    });
    assert.deepEqual(first.shared, second.shared);
    assert.equal(first.calls + second.calls, 2);
    assert.equal(first.inputTokens + second.inputTokens, 200);
    assert.equal(first.knownCostUsd + second.knownCostUsd, 1);
    const noTicket = await superagentTaskUsage(dataDir, { ...binding, ticketId: "no-ticket-calls" });
    assert.equal(noTicket.calls, 0);
    assert.equal(noTicket.costUsd, null);
    assert.deepEqual(noTicket.shared, first.shared);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("keeps each attribution bucket's known and unknown prices independent", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "superagent-task-price-scopes-"));
  const binding = { botId: "bot", threadId: "thread", contextId: "context", ticketId: "task" };
  try {
    const usage = createSuperagentUsage({ dataDir });
    const call = {
      ...binding, type: "usage" as const, requestId: "request", agentId: "worker", role: "worker" as const,
      inputTokens: 10, outputTokens: 2,
    };
    await usage.handle({ ...call, usageId: "exclusive-unpriced" });
    await usage.handle({
      ...call, usageId: "shared-priced", role: "master", agentId: "main", ticketId: undefined,
      costUsd: 0.125, cacheWriteTokens: 4,
    });
    const result = await superagentTaskUsage(dataDir, binding);
    assert.equal(result.unpricedCalls, 1);
    assert.equal(result.knownCostUsd, 0);
    assert.equal(result.costUsd, null);
    assert.equal(result.shared.unpricedCalls, 0);
    assert.equal(result.shared.knownCostUsd, 0.125);
    assert.equal(result.shared.costUsd, 0.125);
    assert.equal(result.shared.cacheWriteTokens, 4);
    assert.equal(result.shared.includedInTaskTotal, false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
