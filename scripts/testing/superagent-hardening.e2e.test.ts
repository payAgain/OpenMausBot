import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { SuperagentDecisionState, SuperagentTaskState } from "../../shared/superagent.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import {
  launchVerificationServer, verificationServerArgs, verificationServerEnvironment,
} from "../control-omb.ts";

interface Bot { id: string; threadId: string; busy: boolean }
interface Message {
  id: string; role: string; kind: string; text?: string; turnId?: string; requestMessageId?: string;
  card?: { requestId?: string; answered?: string; expired?: boolean; dismissed?: boolean; superagent?: { contextId: string; ticketId?: string } };
}

function children(pid: number): number[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return row && Number(row[2]) === pid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(row[3]!) ? [Number(row[1])] : [];
  });
}

async function harness(scenario: string) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined,
    undefined, undefined, [], undefined, undefined, true, true, true);
  const evidenceDir = `${fixture.info.logPath}.review-${scenario}`;
  mkdirSync(evidenceDir, { recursive: true });
  const evidence: Record<string, unknown> = { fixture: fixture.info, scenario, checks: [], api: [] };
  const checks = evidence.checks as string[];
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url }, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (method !== "GET") (evidence.api as unknown[]).push({ method, path, body, status: response.status, result });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  };
  const { bot } = await api<{ bot: Bot }>("POST", "/api/bots", { name: `Review ${scenario}`, memoryUpkeep: false });
  await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false, approvalMode: "ask" });
  const page = async () => (await api<{ messages: Message[] }>("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages;
  const post = (text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  const settled = () => expect.poll(async () => (await api<{ bots: Bot[] }>("GET", "/api/bots?messages=0")).bots.find(row => row.id === bot.id)?.busy,
    { timeout: 45_000, interval: 100 }).toBe(false);
  const echo = async (value: string) => {
    await post(`echo ${value}`);
    await expect.poll(async () => (await page()).filter(row => row.role === "bot" && row.kind === "text" && row.text === value).length,
      { timeout: 45_000, interval: 100 }).toBe(1);
    await settled();
  };
  const tasks = () => api<{ tasks: SuperagentTaskState[]; decisions: SuperagentDecisionState[] }>("GET", `/api/personbot/tasks?threadId=${bot.threadId}`);
  const close = async (beforeCleanup?: () => Promise<void>) => {
    try {
      evidence.messages = await page();
      evidence.lifecycle = await tasks();
      evidence.resources = await api("GET", "/api/personbot/resources");
    } catch (error) { evidence.finalReadError = String(error); }
    writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (existsSync(fixture.info.logPath)) writeFileSync(join(evidenceDir, "server.log"), readFileSync(fixture.info.logPath));
    await beforeCleanup?.();
    await fixture.close();
    const pointer = "/tmp/personbot-review-e2e-evidence-index.json";
    let index: Record<string, string> = {};
    if (existsSync(pointer)) index = JSON.parse(readFileSync(pointer, "utf8")) as Record<string, string>;
    writeFileSync(pointer, JSON.stringify({ ...index, [scenario]: evidenceDir }, null, 2));
  };
  return { fixture, evidenceDir, evidence, checks, api, bot, page, post, settled, echo, tasks, close };
}

it("retains background approval across newer input and directory contexts with exact memory authority and actual original-ledger usage", async () => {
  const h = await harness("background-authority");
  try {
    const cwdA = join(realpathSync(h.fixture.info.dataDir), "workspace-a");
    const cwdB = join(realpathSync(h.fixture.info.dataDir), "workspace-b");
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    await h.api("PATCH", `/api/bots/${h.bot.id}`, { cwd: cwdA });
    await h.echo("first-workspace");
    await h.api("PUT", `/api/bots/${h.bot.id}/memory/file`, { path: "memory/preferences.md", text: "- The person prefers jasmine tea.\n" });
    const before = new Set((await h.page()).map(row => row.id));
    await h.post("probe forget jasmine tea");
    await expect.poll(async () => (await h.page()).some(row => !before.has(row.id) && row.role === "bot" && row.kind === "text"
      && row.text?.includes("Forget needs an explicit direct request")),
      { timeout: 45_000, interval: 100 }).toBe(true);
    await h.settled();
    expect((await h.api<{ text: string }>("GET", `/api/bots/${h.bot.id}/memory/file?path=memory/preferences.md`)).text).toContain("jasmine tea");
    h.checks.push("A real main-agent memory RPC from a non-forget user message is rejected and the original note remains unchanged.");

    await h.post("task background approval");
    await expect.poll(async () => (await h.page()).some(row => row.role === "bot" && row.kind === "text" && row.text === "A file operation needs your approval."),
      { timeout: 45_000, interval: 100 }).toBe(true);
    await h.settled();
    await h.post("echo ordinary-followup");
    let card: Message | undefined;
    await expect.poll(async () => {
      card = (await h.page()).findLast(row => row.card?.requestId && !row.card.answered && !row.card.expired && !row.card.dismissed);
      return Boolean(card);
    }, { timeout: 45_000, interval: 100 }).toBe(true);
    const sameContextDecision = card!.card!.requestId!;
    expect(card!.requestMessageId).toBe((await h.page()).findLast(row => row.role === "user" && row.text === "task background approval")!.id);
    expect(await h.api("POST", `/api/threads/${h.bot.threadId}/respond`, { requestId: sameContextDecision, behavior: "allow" }))
      .toMatchObject({ outcome: "allowed-once" });
    expect((await h.page()).find(row => row.card?.requestId === sameContextDecision)?.card)
      .toMatchObject({ answered: "allow", dismissed: false });
    await expect.poll(() => existsSync(join(cwdA, "official-approved.txt")), { timeout: 30_000, interval: 100 }).toBe(true);
    await h.settled();
    h.checks.push("The official worker requests approval after its input settled; the original card is still visible after a different ordinary input.");

    unlinkSync(join(cwdA, "official-approved.txt"));
    const previousCardIds = new Set((await h.page()).filter(row => row.card?.requestId).map(row => row.card!.requestId));
    await h.post("task background approval");
    await h.settled();
    await h.api("PATCH", `/api/bots/${h.bot.id}`, { cwd: cwdB });
    await h.echo("changed-to-second-workspace");
    await h.echo("continued-second-workspace");
    await expect.poll(async () => {
      card = (await h.page()).findLast(row => row.card?.requestId && !previousCardIds.has(row.card.requestId)
        && !row.card.answered && !row.card.expired && !row.card.dismissed);
      return Boolean(card);
    }, { timeout: 45_000, interval: 100 }).toBe(true);
    const firstTask = (await h.tasks()).tasks.find(task => task.ticketId === card!.card!.superagent?.ticketId)!;
    expect(firstTask).toBeDefined();
    expect(firstTask.workspace).toBe(cwdA);
    const preserved = (await h.tasks()).tasks.find(task => task.ticketId === firstTask.ticketId)!;
    expect(preserved.contextId).toBe(firstTask.contextId);
    expect(preserved.workspace).toBe(cwdA);
    expect(preserved.ended).toBe(false);
    expect(await h.api("POST", `/api/threads/${h.bot.threadId}/respond`, { requestId: card!.card!.requestId, behavior: "allow" }))
      .toMatchObject({ outcome: "allowed-once" });
    await expect.poll(() => existsSync(join(cwdA, "official-approved.txt")), { timeout: 30_000, interval: 100 }).toBe(true);
    expect(existsSync(join(cwdB, "official-approved.txt"))).toBe(false);
    await expect.poll(async () => (await h.page()).some(row => row.role === "bot" && row.kind === "text" && row.text?.startsWith("Background approval result")),
      { timeout: 45_000, interval: 100 }).toBe(true);
    h.checks.push("Changing cwd creates a new context; ordinary continuation there preserves the earlier task, whose exact approval still operates only in its original directory.");

    await h.post("task write second-workspace-proof.txt");
    await expect.poll(() => existsSync(join(cwdB, "second-workspace-proof.txt")), { timeout: 45_000, interval: 100 }).toBe(true);
    await h.settled();
    expect(existsSync(join(cwdA, "second-workspace-proof.txt"))).toBe(false);
    expect(readFileSync(join(cwdB, "second-workspace-proof.txt"), "utf8")).toContain("Official Super Agent worker");
    const totals = await h.api<{ total: { input: number; output: number; unpriced: number } }>("GET", "/api/usage?groupBy=engine");
    expect(totals.total.input).toBeGreaterThan(0);
    expect(totals.total.output).toBeGreaterThan(0);
    expect(totals.total.unpriced).toBeGreaterThan(0);
    const cost = await h.api<{ usage: { calls: number; inputTokens: number; unpricedCalls: number; costUsd: number | null } }>("GET", `/api/personbot/tasks/${firstTask.ticketId}/usage`);
    expect(cost.usage.calls).toBeGreaterThan(0);
    expect(cost.usage.inputTokens).toBeGreaterThan(0);
    expect(cost.usage.unpricedCalls).toBeGreaterThan(0);
    expect(cost.usage.costUsd).toBeNull();
    h.evidence.originalUsage = totals;
    h.evidence.taskUsage = cost;
    h.checks.push("New worker execution uses the new directory; real main/worker token usage reaches the original usage API and task totals retain explicit unpriced cost.");
  } catch (error) {
    h.evidence.error = String(error);
    throw error;
  } finally { await h.close(); }
}, 180_000);

it("automatically wakes an unfinished official binding after server restart without another chat input", async () => {
  const h = await harness("automatic-recovery");
  let restarted: ChildProcess | undefined;
  try {
    await h.post("task hold");
    await expect.poll(async () => (await h.tasks()).tasks.some(task => !task.ended && task.state === "working"),
      { timeout: 45_000, interval: 100 }).toBe(true);
    const previous = await h.tasks();
    const userMessages = (await h.page()).filter(row => row.role === "user");
    await waitForExit(h.fixture.child, { signal: "SIGTERM", graceMs: 20_000 });
    const env = verificationServerEnvironment(process.env, h.fixture.info.dataDir,
      Number(new URL(h.fixture.info.url).port), true, true, true);
    const log = openSync(join(h.evidenceDir, "restart.log"), "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    await expect.poll(async () => {
      try { return (await h.api<{ app: string }>("GET", "/api/health")).app; } catch { return null; }
    }, { timeout: 45_000, interval: 150 }).toBe("openmausbot");
    await expect.poll(() => children(restarted!.pid!).length, { timeout: 45_000, interval: 150 }).toBeGreaterThan(0);
    await expect.poll(async () => {
      const current = await h.tasks();
      return current.tasks.some(task => previous.tasks.some(old => old.ticketId === task.ticketId && old.contextId === task.contextId));
    }, { timeout: 45_000, interval: 150 }).toBe(true);
    expect((await h.page()).filter(row => row.role === "user")).toEqual(userMessages);
    h.evidence.recoveredTasks = await h.tasks();
    h.evidence.restartedChildren = children(restarted!.pid!);
    h.checks.push("Startup recovery launches the exact unfinished native binding without a new user message and preserves its original task identity.");
    await h.api("POST", `/api/personbot/threads/${h.bot.threadId}/stop`);
    await expect.poll(async () => (await h.tasks()).tasks.every(task => task.ended),
      { timeout: 30_000, interval: 100 }).toBe(true);
    h.checks.push("Explicit conversation Stop ends restored tasks without manufacturing another chat request.");
  } catch (error) {
    h.evidence.error = String(error);
    throw error;
  } finally {
    await h.close(async () => {
      if (restarted) await waitForExit(restarted, { signal: "SIGTERM", graceMs: 20_000 });
    });
  }
}, 150_000);
