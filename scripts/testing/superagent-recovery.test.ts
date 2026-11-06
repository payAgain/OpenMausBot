import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Ticket, Trigger } from "../../packages/personbot-superagent/upstream/src/core/model.ts";
import type { OutboundMessage, ReplyStatus } from "../../packages/personbot-superagent/upstream/src/core/ports.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import {
  launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer,
} from "../control-omb.ts";

interface Bot { id: string; threadId: string; busy?: boolean }
interface Message {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
  requestMessageId?: string;
  card?: { requestId?: string; answered?: unknown; expired?: boolean; dismissed?: boolean };
}
interface BindingRow { id: string; bot_id: string; thread_id: string; context_id: string; active: number }
interface RequestRow { binding_id: string; request_id: string; source_message_id: string; status: string }
interface NativeReceipt extends OutboundMessage { status: ReplyStatus }
interface NativeState { file: string; triggers: Trigger[]; tickets: Ticket[]; outbox: NativeReceipt[] }
interface RuntimeChild { pid: number; parentPid: number; command: string }
interface Evidence {
  scenario: string;
  checks: string[];
  fixture?: VerificationServer["info"];
  bot?: Bot;
  api: unknown[];
  snapshots: Record<string, unknown>;
  error?: string;
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function nativeState(dataDir: string): NativeState[] {
  return files(join(dataDir, "personbot", "official-superagent"))
    .filter(file => file.endsWith("/state/orchestrator.sqlite"))
    .map(file => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = <T>(table: string): T[] =>
          db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(String(row.value)) as T);
        return { file, triggers: rows<Trigger>("trigger"), tickets: rows<Ticket>("ticket"), outbox: rows<NativeReceipt>("outbox") };
      } finally { db.close(); }
    });
}

function bindingState(dataDir: string) {
  const file = join(dataDir, "personbot", "official-superagent", "bindings.sqlite");
  if (!existsSync(file)) return { bindings: [] as BindingRow[], requests: [] as RequestRow[], deliveries: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      bindings: db.prepare("SELECT id, bot_id, thread_id, context_id, active FROM bindings").all() as unknown as BindingRow[],
      requests: db.prepare("SELECT binding_id, request_id, source_message_id, status FROM requests").all() as unknown as RequestRow[],
      deliveries: db.prepare("SELECT * FROM deliveries").all(),
    };
  } finally { db.close(); }
}

function runtimeChildren(parentPid: number): RuntimeChild[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5_000 })
    .split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)
        ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
    });
}

async function withFixture(scenario: string, run: (harness: Awaited<ReturnType<typeof harnessFor>>) => Promise<void>) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined,
    undefined, undefined, [], undefined, undefined, true, true, true);
  const evidenceDir = `${fixture.info.logPath}.official-recovery-${scenario}`;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync("/tmp/personbot-official-recovery-evidence-path.txt", `${evidenceDir}\n`);
  const evidence: Evidence = { scenario, checks: [], fixture: fixture.info, api: [], snapshots: {} };
  let harness: Awaited<ReturnType<typeof harnessFor>> | undefined;
  try {
    harness = await harnessFor(fixture, evidenceDir, evidence);
    await run(harness);
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await harness?.snapshot("final").catch(error => { evidence.snapshots.finalSnapshotError = String(error); });
    if (harness) await harness.close();
    else await fixture.close();
    writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (existsSync(fixture.info.logPath)) writeFileSync(join(evidenceDir, "server.log"), readFileSync(fixture.info.logPath));
    console.info(`Official ${scenario} recovery evidence: ${evidenceDir}`);
  }
}

async function harnessFor(fixture: VerificationServer, evidenceDir: string, evidence: Evidence) {
  let restarted: ChildProcess | undefined;
  let owner = fixture.child;
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (method !== "GET") evidence.api.push({ method, path, body, status: response.status, result });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const { bot } = await api<{ bot: Bot }>("POST", "/api/bots", { name: `Official recovery ${evidence.scenario}`, memoryUpkeep: false });
  evidence.bot = bot;
  await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false, approvalMode: "ask" });
  const page = async () => (await api<{ messages: Message[] }>("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages;
  const settled = () => expect.poll(async () => {
    const value = await api<{ bots: Bot[] }>("GET", "/api/bots?messages=0");
    return value.bots.find(row => row.id === bot.id)?.busy;
  }, { timeout: 45_000, interval: 150 }).toBe(false);
  const post = (text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  const texts = async (text: string) => (await page()).filter(row => row.role === "bot" && row.kind === "text" && row.text === text);
  const snapshot = async (name: string) => {
    evidence.snapshots[name] = {
      messages: await page(), native: nativeState(fixture.info.dataDir), bindings: bindingState(fixture.info.dataDir),
      status: await api("GET", "/api/personbot/status"), children: owner.pid ? runtimeChildren(owner.pid) : [],
    };
  };
  const restart = async () => {
    const oldPid = owner.pid!;
    await waitForExit(owner, { signal: "SIGTERM", graceMs: 20_000 });
    expect(runtimeChildren(oldPid)).toEqual([]);
    const env = verificationServerEnvironment(process.env, fixture.info.dataDir,
      Number(new URL(fixture.info.url).port), true, true, true);
    const log = openSync(join(evidenceDir, "restart.log"), "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
      owner = restarted;
    } finally { closeSync(log); }
    await expect.poll(async () => {
      if (owner.exitCode !== null || owner.signalCode !== null) throw new Error("Restarted fixture exited; see restart.log");
      try { return (await api<{ app?: string }>("GET", "/api/health")).app; } catch { return null; }
    }, { timeout: 45_000, interval: 150 }).toBe("openmausbot");
  };
  return {
    fixture, evidenceDir, evidence, bot, api, page, settled, post, texts, snapshot, restart,
    state: () => nativeState(fixture.info.dataDir),
    bindings: () => bindingState(fixture.info.dataDir),
    serverPid: () => owner.pid!,
    close: async () => {
      if (restarted) await waitForExit(restarted, { signal: "SIGTERM", graceMs: 20_000 });
      await fixture.close();
    },
  };
}

it("delivers real official attention and the clarified result once through the original conversation across restart", async () => {
  await withFixture("attention", async h => {
    await h.post("task attention");
    await expect.poll(async () => (await h.texts("Which destination?")).length,
      { timeout: 45_000, interval: 150 }).toBe(1);
    await h.settled();
    const attentionState = h.state();
    const ticket = attentionState.flatMap(row => row.tickets).find(row => row.title === "attention");
    expect(ticket?.attention?.question).toBe("Which destination?");
    expect(ticket?.assignments.some(row => row.report?.state === "blocked")).toBe(true);
    const origin = attentionState.flatMap(row => row.triggers).find(row => row.id === ticket?.origin.triggerId)!;
    expect(origin.text).toBe("task attention");
    expect(typeof origin.meta.requestId).toBe("string");
    const originMessage = (await h.page()).find(row => row.role === "user" && row.text === "task attention")!;
    expect(h.bindings().requests.find(row => row.request_id === origin.meta.requestId)?.source_message_id).toBe(originMessage.id);
    await h.snapshot("attention");
    h.evidence.checks.push("A real official blocked worker report reaches the original thread as one attention message and releases its busy turn.");

    await h.post("attention answer Mars");
    await expect.poll(async () => (await h.texts("Official attention result: Mars")).length,
      { timeout: 45_000, interval: 150 }).toBe(1);
    await h.settled();
    const clarifiedState = h.state();
    const clarification = clarifiedState.flatMap(row => row.triggers).find(row => row.text === "attention answer Mars")!;
    expect(clarification.meta.requestId).not.toBe(origin.meta.requestId);
    const completed = clarifiedState.flatMap(row => row.tickets).find(row => row.id === ticket!.id)!;
    expect(completed.inputs.some(row => row.kind === "trigger" && row.triggerId === clarification.id)).toBe(true);
    expect(completed.assignments.some(row => row.report?.summary === "Official attention result: Mars")).toBe(true);
    const receipts = clarifiedState.flatMap(row => row.outbox).filter(row => row.ticketId === ticket!.id);
    expect(receipts.filter(row => row.purpose === "attention")).toHaveLength(1);
    expect(receipts.filter(row => row.purpose === "result" && row.text === "Official attention result: Mars")).toHaveLength(1);
    expect(receipts.find(row => row.purpose === "result")?.channel.address.requestId).toBe(origin.meta.requestId);
    expect((await h.texts("Official attention result: Mars"))[0]?.turnId).toBe(clarification.meta.requestId);
    const originalBinding = h.bindings().bindings.find(row => row.bot_id === h.bot.id && row.thread_id === h.bot.threadId)!;
    expect(h.bindings().requests.filter(row => row.binding_id === originalBinding.id)).toHaveLength(2);
    await h.snapshot("clarified");
    h.evidence.checks.push("A different owner request continues the same native ticket and delivers its final result to the original thread exactly once.");

    const beforeRestart = await h.page();
    await h.restart();
    expect(await h.page()).toEqual(beforeRestart);
    await h.post("echo after-attention-restart");
    await expect.poll(async () => (await h.page()).filter(row => row.role === "bot" && row.kind === "text"
      && row.text?.includes("after-attention-restart")).length, { timeout: 45_000, interval: 150 }).toBe(1);
    await h.settled();
    expect(await h.texts("Which destination?")).toHaveLength(1);
    expect(await h.texts("Official attention result: Mars")).toHaveLength(1);
    expect(h.state().map(row => row.file)).toEqual(clarifiedState.map(row => row.file));
    expect(h.bindings().bindings.find(row => row.id === originalBinding.id)?.active).toBe(1);
    await h.snapshot("restarted");
    h.evidence.checks.push("The same isolated server data preserves original messages and native identity after restart, without replaying attention or result.");
  });
}, 200_000);

it("expires a real pending native approval after exact child failure and lets original Stop cancel its recovered task", async () => {
  await withFixture("crash", async h => {
    await h.post("task approval");
    let pending: Message | undefined;
    await expect.poll(async () => {
      pending = (await h.page()).findLast(row => row.card?.requestId && !row.card.answered && !row.card.expired && !row.card.dismissed);
      return Boolean(pending);
    }, { timeout: 45_000, interval: 150 }).toBe(true);
    const decisionId = pending!.card!.requestId!;
    const priorState = h.state();
    const ticket = priorState.flatMap(row => row.tickets).find(row => row.title === "approval")!;
    expect(ticket).toBeDefined();
    const approvalFile = join(h.fixture.info.dataDir, "personbot-workspace", "official-approved.txt");
    expect(existsSync(approvalFile)).toBe(false);
    const children = runtimeChildren(h.serverPid());
    expect(children).toHaveLength(1);
    const exactChild = children[0]!;
    await h.snapshot("pendingApproval");
    expect(runtimeChildren(h.serverPid())).toEqual([exactChild]);
    process.kill(exactChild.pid, "SIGKILL");
    await expect.poll(() => runtimeChildren(h.serverPid()).some(row => row.pid === exactChild.pid),
      { timeout: 15_000, interval: 150 }).toBe(false);
    await h.settled();
    await expect.poll(async () => {
      const card = (await h.page()).find(row => row.id === pending!.id)?.card;
      return Boolean(card?.expired || card?.dismissed);
    },
      { timeout: 15_000, interval: 150 }).toBe(true);
    expect(await h.api("POST", `/api/threads/${h.bot.threadId}/respond`, { requestId: decisionId, behavior: "allow" }))
      .toMatchObject({ outcome: "unavailable" });
    expect(existsSync(approvalFile)).toBe(false);
    await h.snapshot("childCrashed");
    h.evidence.checks.push("SIGKILL targets the fixture server's exact native child; original busy clears and its old approval expires and cannot be answered.");

    await h.api("POST", `/api/bots/${h.bot.id}/interrupt`, { threadId: h.bot.threadId });
    const request = h.bindings().requests.find(row => row.source_message_id ===
      priorState.flatMap(row => row.triggers).find(row => row.id === ticket.origin.triggerId)?.meta.sourceMessageId)!;
    await expect.poll(() => h.bindings().requests.find(row => row.request_id === request.request_id)?.status,
      { timeout: 15_000, interval: 150 }).toBe("stopped");
    await expect.poll(() => h.state().flatMap(row => row.tickets).find(row => row.id === ticket.id)?.ended,
      { timeout: 30_000, interval: 150 }).toMatchObject({ by: "human", outcome: "stopped" });
    const binding = h.bindings().bindings.find(row => row.bot_id === h.bot.id && row.thread_id === h.bot.threadId)!;
    await h.post("echo after-native-crash-stop");
    await expect.poll(async () => (await h.texts("after-native-crash-stop")).length,
      { timeout: 45_000, interval: 150 }).toBe(1);
    await h.settled();
    expect((await h.page()).filter(row => row.card?.requestId && !row.card.answered && !row.card.expired && !row.card.dismissed)).toHaveLength(0);
    expect(existsSync(approvalFile)).toBe(false);
    expect(h.bindings().bindings.filter(row => row.bot_id === h.bot.id && row.thread_id === h.bot.threadId)).toEqual([binding]);
    await h.snapshot("stoppedAndRetried");
    h.evidence.checks.push("Original Stop reaches the persisted native task after the active driver turn has cleared; the same binding accepts new work without a stale approval.");

    const beforeRestart = await h.page();
    await h.restart();
    expect(await h.page()).toEqual(beforeRestart);
    await h.post("echo after-crash-server-restart");
    await expect.poll(async () => (await h.texts("after-crash-server-restart")).length,
      { timeout: 45_000, interval: 150 }).toBe(1);
    await h.settled();
    expect(await h.texts("after-native-crash-stop")).toHaveLength(1);
    expect((await h.page()).filter(row => row.card?.requestId && !row.card.answered && !row.card.expired && !row.card.dismissed)).toHaveLength(0);
    expect(existsSync(approvalFile)).toBe(false);
    expect(h.state().flatMap(row => row.tickets).find(row => row.id === ticket.id)?.ended).toMatchObject({ by: "human", outcome: "stopped" });
    expect(h.bindings().bindings.find(row => row.id === binding.id)?.active).toBe(1);
    await h.snapshot("restarted");
    h.evidence.checks.push("A server restart preserves the human-stopped ticket and original messages; subsequent input retains the native binding and executes once.");
  });
}, 220_000);
