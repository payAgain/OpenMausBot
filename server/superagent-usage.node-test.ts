import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createSuperagentUsage, type SuperagentUsageEvent } from "./superagent-usage.ts";
import {
  appendUsage, appendUsageOnce, flushUsageLedger, readUsage, summarizeUsage, usageCsv, usageFileFor, usageRowKey,
  type UsageRow,
} from "./usage-ledger.ts";

let directory: string;
const now = new Date("2026-11-06T07:00:00.000Z");
const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-30T23:59:59Z") };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "omb-native-usage-")); });
afterEach(async () => {
  await flushUsageLedger(directory);
  rmSync(directory, { recursive: true, force: true });
});

function usage(overrides: Partial<SuperagentUsageEvent> = {}): SuperagentUsageEvent {
  return {
    type: "usage", botId: "original-bot", threadId: "original-thread", contextId: "native-context",
    usageId: "call-master", requestId: "original-request", agentId: "official-master",
    role: "master", provider: "deepseek-official", model: "deepseek-flash",
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40,
    ...overrides,
  };
}

test("books main, worker and upkeep native calls into the original private ledger and original summaries", async () => {
  const booked: UsageRow[] = [];
  const projector = createSuperagentUsage({
    dataDir: directory, now: () => now, bot: () => ({ name: "Scout", section: "Engineering" }),
    onBooked: row => { booked.push(row); },
  });
  const main = { ...usage(), prompt: "this private message must never enter the ledger" };
  assert.equal((await projector.handle(main)).newlyBooked, true);
  assert.equal((await projector.handle(usage({
    usageId: "call-worker", role: "worker", agentId: "official-worker", ticketId: "official-ticket",
    inputTokens: 60, outputTokens: 8, cacheReadTokens: 12, cacheWriteTokens: 7, costUsd: 0.01,
  }))).newlyBooked, true);
  assert.equal((await projector.handle(usage({
    usageId: "call-upkeep", role: "upkeep", agentId: "upkeep-agent", requestId: "upkeep-request",
    botId: "", threadId: "", contextId: undefined, inputTokens: 30, outputTokens: 4, cacheReadTokens: undefined, costUsd: 0.002,
  }))).newlyBooked, true);
  const rows = readUsage(directory, range);
  assert.equal(rows.length, 3);
  assert.equal(booked.length, 3);
  assert.deepEqual(rows[0], {
    at: now.toISOString(), usageId: "call-master", botId: "original-bot", threadId: "original-thread",
    botName: "Scout", instanceId: "dsh-superagent", driverKind: "dsh-superagent", model: "deepseek-flash",
    provider: "deepseek-official", input: 100, output: 20, cachedInput: 40, costUsd: null,
    trigger: { kind: "owner" }, section: "Engineering", turnId: "original-request", requestId: "original-request",
    agentId: "official-master", agentRole: "master", usageStatus: "complete", contextId: "native-context",
  });
  assert.equal(rows[1]!.ticketId, "official-ticket");
  assert.equal(rows[1]!.cacheWrite, 7);
  assert.equal(rows[1]!.costSource, "reported");
  assert.deepEqual(rows[2]!.trigger, { kind: "helper", job: "memory-upkeep" });
  assert.equal(rows[2]!.botId, "__superagent_upkeep__");
  assert.equal(rows[2]!.botName, "Super Agent memory upkeep");
  assert.equal(rows[2]!.threadId, "superagent-upkeep");
  assert.equal(rows[2]!.contextId, undefined);
  const summary = summarizeUsage(rows, "engine");
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0]!.key, "engine:dsh-superagent");
  assert.equal(summary.total.turns, 3);
  assert.equal(summary.total.input, 190);
  assert.equal(summary.total.output, 32);
  assert.equal(summary.total.cachedInput, 52);
  assert.equal(summary.total.unpriced, 1);
  assert.equal(summary.total.costUsd, 0.012);
  assert.equal(summarizeUsage(rows, "user").groups.find(group => group.key === "helper")?.turns, 1);
  assert.match(usageCsv(rows), /deepseek-flash,dsh-superagent,This computer,100,20,40,,,/);
  const path = usageFileFor(directory, now);
  assert.doesNotMatch(readFileSync(path, "utf8"), /private message|prompt|sourceMessageId/);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "usage")).mode & 0o777, 0o700);
  }
});

test("concurrent retries of the same native usage ID book task counters and cost only once", async () => {
  let input = 0;
  let cost = 0;
  const projector = createSuperagentUsage({
    dataDir: directory, now: () => now,
    onBooked: row => { input += row.input; cost += row.costUsd ?? 0; },
  });
  const event = usage({ role: "worker", agentId: "worker", ticketId: "task", costUsd: 0.02 });
  const results = await Promise.all(Array.from({ length: 20 }, () => projector.handle(event)));
  assert.equal(results.filter(result => result.newlyBooked).length, 1);
  assert.equal(input, 100);
  assert.equal(cost, 0.02);
  assert.equal(readUsage(directory, range).length, 1);
  const another = await projector.handle(usage({ usageId: "call-second", costUsd: 0.03 }));
  assert.equal(another.newlyBooked, true);
  assert.equal(new Set(readUsage(directory, range).map(usageRowKey)).size, 2);
  assert.equal(summarizeUsage(readUsage(directory, range), "bot").total.costUsd, 0.05);
});

test("a fresh process recognizes a synced ledger row after callback acknowledgement is lost, even across months", async () => {
  let failedHook = 0;
  const projector = createSuperagentUsage({
    dataDir: directory, now: () => new Date("2026-10-31T23:59:59.000Z"),
    onBooked: () => { failedHook++; throw new Error("simulated crash after append before callback acknowledgement"); },
  });
  const event = usage({ usageId: "call-lost-ack", costUsd: 0.04 });
  await assert.rejects(projector.handle(event), /simulated crash/);
  assert.equal(failedHook, 1);
  assert.equal(readUsage(directory, range).length, 1);
  const source = `
    const {createSuperagentUsage} = await import(process.argv[1]);
    let hooks = 0;
    const projector = createSuperagentUsage({dataDir:process.argv[2],now:()=>new Date('2026-11-06T07:00:00Z'),onBooked:()=>{hooks++;}});
    const result = await projector.handle(JSON.parse(process.argv[3]));
    console.log(JSON.stringify({newlyBooked:result.newlyBooked,hooks}));
  `;
  const output = execFileSync(process.execPath, [
    "--input-type=module", "-e", source, new URL("./superagent-usage.ts", import.meta.url).href, directory, JSON.stringify(event),
  ], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { newlyBooked: false, hooks: 0 });
  const rows = readUsage(directory, range);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.at, "2026-10-31T23:59:59.000Z");
  assert.equal(rows[0]!.costUsd, 0.04);
  assert.equal(existsSync(usageFileFor(directory, now)), false);
});

test("a failed durable append rejects for gateway retry while legacy logging still handles write failure", async () => {
  const blocked = join(directory, "blocked");
  writeFileSync(blocked, "not a directory");
  let hooks = 0;
  const projector = createSuperagentUsage({ dataDir: blocked, now: () => now, onBooked: () => { hooks++; } });
  await assert.rejects(projector.handle(usage()));
  assert.equal(hooks, 0);
  const row: Omit<UsageRow, "at"> = {
    botId: "b", botName: "b", threadId: "t", instanceId: "old", driverKind: "old",
    model: "old", input: 1, output: 1, costUsd: null, trigger: { kind: "owner" },
  };
  assert.equal(await appendUsage(blocked, row), false);
  rmSync(blocked);
  assert.equal((await projector.handle(usage())).newlyBooked, true);
  assert.equal((await projector.handle(usage())).newlyBooked, false);
  assert.equal(hooks, 1);
  await flushUsageLedger(blocked);
  assert.equal(readUsage(blocked, range).length, 1);
});

test("native append separates a torn trailing line and rejects invalid metrics without fabricated cost", async () => {
  const projector = createSuperagentUsage({ dataDir: directory, now: () => now });
  await projector.handle(usage());
  appendFileSync(usageFileFor(directory, now), '{"at":"2026-11-06');
  await projector.handle(usage({ usageId: "call-after-torn", costUsd: Number.NaN }));
  const rows = readUsage(directory, range);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.costUsd === null && row.costSource === undefined));
  assert.equal(summarizeUsage(rows, "bot").total.unpriced, 2);
  assert.equal(summarizeUsage(rows, "bot").total.costUsd, null);
  for (const event of [
    usage({ usageId: "bad input", inputTokens: 100 }),
    usage({ usageId: "invalid-negative", inputTokens: -1 }),
    usage({ usageId: "invalid-fraction", outputTokens: 1.5 }),
    usage({ usageId: "invalid-cache", cacheReadTokens: Number.NaN }),
  ]) await assert.rejects(projector.handle(event));
  assert.equal(readUsage(directory, range).length, 2);
  const first = rows[0]!;
  assert.equal(await appendUsageOnce(directory, first), false);
  assert.equal(await appendUsage(directory, first), true);
});
