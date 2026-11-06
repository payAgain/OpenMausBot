import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { SuperagentDecisionState, SuperagentTaskState } from "../../shared/superagent.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../control-omb.ts";

interface Bot { id: string; threadId: string; busy: boolean; approvalMode: string }
interface Message {
  id: string; role: string; kind: string; text?: string;
  card?: { requestId?: string; answered?: string; expired?: boolean };
}
interface BindingRow { id: string; active: number; needs_recovery: number; next_wake: number; stop_pending: number }
interface RequestRow { request_id: string; revoked: number; status: string; authorization_version: number }

function persisted(dataDir: string, bot: Bot) {
  const db = new DatabaseSync(join(dataDir, "personbot", "official-superagent", "bindings.sqlite"), { readOnly: true });
  try {
    const filter = "b.bot_id=? AND b.thread_id=?";
    return {
      bindings: db.prepare(`SELECT b.id,b.active,b.needs_recovery,b.next_wake,b.stop_pending FROM bindings b WHERE ${filter}`).all(bot.id, bot.threadId) as unknown as BindingRow[],
      requests: db.prepare(`SELECT r.request_id,r.revoked,r.status,r.authorization_version FROM requests r JOIN bindings b ON b.id=r.binding_id WHERE ${filter}`).all(bot.id, bot.threadId) as unknown as RequestRow[],
      tasks: (db.prepare(`SELECT t.value FROM task_state t JOIN bindings b ON b.id=t.binding_id WHERE ${filter}`).all(bot.id, bot.threadId) as { value: string }[]).map(row => JSON.parse(row.value) as SuperagentTaskState),
      decisions: (db.prepare(`SELECT d.value FROM decisions d JOIN bindings b ON b.id=d.binding_id WHERE ${filter}`).all(bot.id, bot.threadId) as { value: string }[]).map(row => JSON.parse(row.value) as SuperagentDecisionState),
    };
  } finally { db.close(); }
}

function nativeChildren(pid: number) {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return row && Number(row[2]) === pid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(row[3]!);
  });
}

it.each(["emergency-ask", "thread-ask", "thread-delete", "bulk-delete", "bot-delete", "active-branch"] as const)(
  "revokes background native authority through original %s lifecycle and prevents resurrection without new input",
  async scenario => {
    const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined,
      undefined, undefined, [], undefined, undefined, true, true, true);
    const evidenceDir = `${fixture.info.logPath}.lifecycle-${scenario}`;
    mkdirSync(evidenceDir, { recursive: true });
    const evidence: Record<string, unknown> = { fixture: fixture.info, scenario, api: [], checks: [] };
    let restarted: ChildProcess | undefined;
    const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, expectedStatus?: number): Promise<T> => {
      const response = await fetch(`${fixture.info.url}${path}`, {
        method, headers: { "content-type": "application/json", origin: fixture.info.url },
        signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result: unknown = await response.json();
      if (method !== "GET") (evidence.api as unknown[]).push({ method, path, body, status: response.status, result });
      if (expectedStatus !== undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expectedStatus);
      else if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
      return result as T;
    };
    try {
      const { bot } = await api<{ bot: Bot }>("POST", "/api/bots", { name: `Lifecycle ${scenario}`, memoryUpkeep: false });
      const workspace = join(fixture.info.dataDir, "lifecycle-workspace");
      mkdirSync(workspace);
      const emergency = scenario === "emergency-ask" || scenario === "thread-ask";
      await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false, cwd: workspace,
        approvalMode: emergency ? "full" : "ask", applyToAllThreads: true });
      const messages = async () => (await api<{ messages: Message[] }>("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
      const idle = () => expect.poll(async () => (await api<{ bots: Bot[] }>("GET", "/api/bots?messages=0")).bots.find(row => row.id === bot.id)?.busy,
        { timeout: 30_000, interval: 100 }).toBe(false);
      const post = (text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
      await post(`echo baseline-${scenario}`);
      let baseline: Message | undefined;
      await expect.poll(async () => {
        baseline = (await messages()).find(row => row.role === "bot" && row.kind === "text" && row.text === `baseline-${scenario}`);
        return Boolean(baseline);
      }, { timeout: 30_000, interval: 100 }).toBe(true);
      await idle();
      await post(emergency ? "task attention" : "task background approval");
      await expect.poll(async () => (await messages()).some(row => row.role === "bot" && row.kind === "text"
        && row.text === (emergency ? "Which destination?" : "A file operation needs your approval.")),
      { timeout: 30_000, interval: 100 }).toBe(true);
      await idle();
      await expect.poll(() => persisted(fixture.info.dataDir, bot).tasks.some(task => !task.ended),
        { timeout: 30_000, interval: 100 }).toBe(true);
      if (!emergency) {
        await expect.poll(() => persisted(fixture.info.dataDir, bot).decisions.some(decision => decision.status === "pending"),
          { timeout: 30_000, interval: 100 }).toBe(true);
      }
      const before = persisted(fixture.info.dataDir, bot);
      expect(before.requests.some(request => !request.revoked)).toBe(true);
      expect(before.bindings.some(binding => binding.active)).toBe(true);
      evidence.before = before;
      if (scenario === "active-branch") {
        await api("POST", `/api/bots/${bot.id}/active-branch`, { threadId: bot.threadId, messageId: "missing-message" }, 404);
        expect(persisted(fixture.info.dataDir, bot)).toEqual(before);
        await api("POST", `/api/bots/${bot.id}/active-branch`, { threadId: bot.threadId, messageId: baseline!.id });
      } else if (scenario === "thread-delete") {
        await api("DELETE", `/api/bots/${bot.id}/tasks/${bot.threadId}`);
      } else if (scenario === "bulk-delete") {
        expect(await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [bot.threadId, "missing-thread"] }))
          .toMatchObject({ deleted: [bot.threadId], refused: [{ threadId: "missing-thread", reason: "not-found" }] });
      } else if (scenario === "bot-delete") {
        await api("DELETE", `/api/bots/${bot.id}`);
      } else if (scenario === "thread-ask") {
        await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
      } else {
        await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true });
      }
      const revoked = () => {
        const state = persisted(fixture.info.dataDir, bot);
        return state.requests.every(request => request.revoked && request.status === "stopped")
          && state.tasks.every(task => task.ended)
          && state.decisions.every(decision => decision.status !== "pending")
          && state.bindings.every(binding => !binding.needs_recovery && !binding.stop_pending);
      };
      await expect.poll(revoked, { timeout: 30_000, interval: 100 }).toBe(true);
      const stopped = persisted(fixture.info.dataDir, bot);
      if (!emergency) expect(stopped.bindings.every(binding => !binding.active)).toBe(true);
      for (const request of stopped.requests) {
        const old = before.requests.find(row => row.request_id === request.request_id)!;
        expect(request.authorization_version).toBeGreaterThan(old.authorization_version);
      }
      if (scenario === "active-branch") {
        const decision = before.decisions.find(row => row.status === "pending")!;
        expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: decision.decisionId, behavior: "allow" }))
          .toMatchObject({ outcome: "unavailable" });
      }
      expect(existsSync(join(workspace, "official-approved.txt"))).toBe(false);
      evidence.stopped = stopped;
      (evidence.checks as string[]).push("The original lifecycle route revokes exact persisted grants, invalidates decisions, and ends native tasks after the input turn has completed.");
      await waitForExit(fixture.child, { signal: "SIGTERM", graceMs: 20_000 });
      const env = verificationServerEnvironment(process.env, fixture.info.dataDir,
        Number(new URL(fixture.info.url).port), true, true, true);
      const log = openSync(join(evidenceDir, "restart.log"), "a", 0o600);
      try {
        restarted = spawn(process.execPath, verificationServerArgs(env), {
          cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
        });
      } finally { closeSync(log); }
      await expect.poll(async () => {
        try { return (await api<{ app: string }>("GET", "/api/health")).app; } catch { return null; }
      }, { timeout: 30_000, interval: 100 }).toBe("openmausbot");
      for (let check = 0; check < 12; check += 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        expect(revoked()).toBe(true);
        expect(nativeChildren(restarted.pid!)).toEqual([]);
        expect(existsSync(join(workspace, "official-approved.txt"))).toBe(false);
      }
      evidence.afterRestart = persisted(fixture.info.dataDir, bot);
      (evidence.checks as string[]).push("Restart without any replacement input does not revive stopped/retired native authority, create a native child, or execute the cancelled file operation.");
      if (emergency) {
        expect(persisted(fixture.info.dataDir, bot).bindings.every(binding => !binding.active)).toBe(true);
        await post(`echo continued-${scenario}`);
        await expect.poll(async () => (await messages()).some(row => row.role === "bot" && row.kind === "text"
          && row.text === `continued-${scenario}`), { timeout: 30_000, interval: 100 }).toBe(true);
        await idle();
        const continued = persisted(fixture.info.dataDir, bot);
        const oldIds = new Set(before.bindings.map(binding => binding.id));
        expect(continued.bindings.filter(binding => binding.active)).toHaveLength(1);
        expect(continued.bindings.filter(binding => binding.active).every(binding => !oldIds.has(binding.id))).toBe(true);
        expect(continued.bindings.filter(binding => oldIds.has(binding.id)).every(binding => !binding.active)).toBe(true);
        evidence.continued = continued;
        (evidence.checks as string[]).push("A new input after startup retirement receives a fresh native context and completes; the retired cursor and its grants are never reactivated.");
      }
    } catch (error) {
      evidence.error = String(error);
      throw error;
    } finally {
      writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
      if (existsSync(fixture.info.logPath)) writeFileSync(join(evidenceDir, "server.log"), readFileSync(fixture.info.logPath));
      if (restarted) await waitForExit(restarted, { signal: "SIGTERM", graceMs: 20_000 });
      await fixture.close();
      const pointer = "/tmp/personbot-review-lifecycle-evidence-index.json";
      const previous = existsSync(pointer) ? JSON.parse(readFileSync(pointer, "utf8")) as Record<string, string> : {};
      writeFileSync(pointer, JSON.stringify({ ...previous, [scenario]: evidenceDir }, null, 2));
    }
  }, 120_000,
);
