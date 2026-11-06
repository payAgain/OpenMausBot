import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { PersonbotLegacyDetail, PersonbotLegacyImportResult, PersonbotLegacyList } from "../../shared/personbot-legacy.ts";
import type { PersonbotSetup } from "../../shared/personbot-product.ts";
import type { RuntimeSnapshot } from "../../packages/personbot-projection/src/index.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../control-omb.ts";
import { fixtureApi } from "./preview-fixture.ts";

function probeLegacyUpgrade(base: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), {
      headers: {
        origin: base, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (data: string) => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.once("upgrade", (_res, socket) => { socket.destroy(); reject(new Error(`Legacy viewer upgraded in primary mode: ${path}`)); });
    req.once("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`Legacy viewer probe timed out: ${path}`)));
    req.end();
  });
}

it("switches a saved legacy workspace to dsh with read-only history, idempotent continuation and suspended legacy execution", async () => {
  let fixture: VerificationServer | undefined;
  let restarted: ChildProcess | undefined;
  let evidenceDir: string | undefined;
  const checks: string[] = [];
  const evidence: Record<string, unknown> = { checks };
  try {
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    const api = fixtureApi(server.info.url, { headers: { origin: server.info.url } });
    evidenceDir = `${server.info.logPath}.personbot-cutover`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    expect((await api("GET", "/api/personbot/setup") as PersonbotSetup).primary).toBe(false);
    const created = await api("POST", "/api/bots", { name: "Archived research", soul: "Check evidence before deciding.", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) as { bot: { id: string; threadId: string } };
    const bot = created.bot;
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Saved project research, ready for continuation.", threadId: bot.threadId });
    await expect.poll(async () => {
      const value = await api("GET", "/api/bots") as { bots: Array<{ id: string; busy: boolean }> };
      return value.bots.find(row => row.id === bot.id)?.busy;
    }, { timeout: 20_000 }).toBe(false);
    await api("POST", "/api/routines", {
      name: "Legacy due work", botId: bot.id, prompt: "This must never run after cutover.",
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    });
    await waitForExit(server.child, { signal: "SIGTERM", graceMs: 15_000 });
    const routinePath = join(server.info.dataDir, "routines.json");
    const routines = JSON.parse(readFileSync(routinePath, "utf8")) as {
      routines: Array<{ id: string; name: string; nextRunAt: number; schedule: { at?: number } }>;
      runs: unknown[]; routineRequestReceipts: unknown[];
    };
    const due = routines.routines.find(row => row.name === "Legacy due work");
    expect(due).toBeDefined();
    due!.schedule.at = Date.now() - 5_000;
    due!.nextRunAt = due!.schedule.at;
    const runBase = {
      routineId: due!.id, routineName: due!.name, botId: bot.id, threadId: bot.threadId,
      runOn: "maus", scheduledFor: Date.now() - 60_000, startedAt: Date.now() - 60_000,
      manual: false, createdAt: Date.now() - 60_000,
    };
    routines.runs.push(
      { ...runBase, id: "cutover-running-goal", target: "room-goal", status: "running" },
      { ...runBase, id: "cutover-waiting-run", target: "bot", status: "waiting", waitingSince: Date.now() - 30_000 },
    );
    routines.routineRequestReceipts = [{
      requestId: "cutover-receipt", messageId: "cutover-unanswered-request", botId: bot.id, threadId: bot.threadId,
      action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: due!.id, appliedAt: Date.now(),
    }];
    const routineBytes = JSON.stringify(routines);
    writeFileSync(routinePath, routineBytes);
    const calendarPath = join(server.info.dataDir, "calendar-calls.json");
    const calendarBytes = JSON.stringify({
      version: 1, calls: [{
        id: "cutover-calendar", name: "Archived reminder", description: "Do not migrate on read",
        botIds: [bot.id], schedule: { type: "once", at: Date.now() + 3_600_000 },
        durationMinutes: 10, attachments: [], createdAt: Date.now(), updatedAt: Date.now(),
      }],
    });
    writeFileSync(calendarPath, calendarBytes);
    const oldCalls = existsSync(server.fixtureDumpPath) ? statSync(server.fixtureDumpPath).mtimeMs : 0;
    const restartEnv = verificationServerEnvironment(process.env, server.info.dataDir, Number(new URL(server.info.url).port), true, true);
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const messageDbModule = JSON.stringify(join(repoRoot, "server/message-db.ts"));
    const inspectLegacyState = `
      import {chatFollowups,readThread,closeMessageDb} from ${messageDbModule};
      console.log(JSON.stringify({followups:chatFollowups(),thread:readThread(${JSON.stringify(bot.threadId)},"")}));
      closeMessageDb();
    `;
    const seed = `
      import {saveChatFollowup,settleChatFollowups,appendMessage,closeMessageDb} from ${messageDbModule};
      const ownerId=${JSON.stringify(bot.id)},threadId=${JSON.stringify(bot.threadId)};
      for(const [id,kind] of [["cutover-inflight","bot"],["cutover-pending","bot"],["cutover-aside","aside"]]){
        saveChatFollowup({id,kind,ownerId,threadId,payload:{text:"UNSENT_ARCHIVED_INPUT_"+id}});
      }
      settleChatFollowups(["cutover-inflight"],"dispatching");
      appendMessage(threadId,{id:"cutover-goal-card",at:Date.now(),role:"bot",kind:"text",text:"Goal working: archived work.",
        goalRun:{runId:"cutover-running-goal",goal:"Preserve archived work.",status:"working",
          coordinatorBotId:ownerId,coordinatorName:"Archived research",turnCount:1,maxTurns:10,startedAt:Date.now()}});
      closeMessageDb();
    `;
    const offline = (code: string) => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
      cwd: repoRoot, env: restartEnv, encoding: "utf8", timeout: 10_000,
    }).trim();
    offline(seed);
    const legacyState = JSON.parse(offline(inspectLegacyState)) as {
      followups: unknown[]; thread: { messages: Array<{ id: string; text?: string; goalRun?: { status: string } }> };
    };
    evidence.archivedBefore = legacyState;
    const restartLog = `${server.info.logPath}.primary-restart.log`;
    const log = openSync(restartLog, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(restartEnv), {
        cwd: repoRoot, env: restartEnv, stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    evidence.restartedPid = restarted.pid;
    evidence.restartLog = restartLog;
    await expect.poll(async () => {
      try { return (await api("GET", "/api/personbot/setup") as PersonbotSetup).primary; }
      catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    checks.push("same saved legacy workspace restarted in primary mode without loading its old engine");
    for (const path of [`/api/bots/${bot.id}/messages`, "/api/routines", "/api/config", "/api/workspace-backup/restore"]) {
      const response = await fetch(`${server.info.url}${path}`, {
        method: "POST", headers: { origin: server.info.url, "content-type": "application/json" }, body: "{}",
      });
      expect(response.status, path).toBe(409);
      expect(await response.json()).toMatchObject({ code: "personbot_primary" });
    }
    checks.push("legacy sends, automation changes, configuration writes and unsafe old restore rejected before legacy handlers");
    for (const path of [
      `/api/bots/${bot.id}/browser/stream`, "/api/desktop-viewer/local/shared/websockify",
      "/api/desktop-viewer/vps/fixture/websockify",
    ]) {
      const response = await probeLegacyUpgrade(server.info.url, path);
      expect(response.status, path).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({ code: "personbot_primary" });
    }
    for (const path of [`/api/bots/${bot.id}/browser/live`, "/api/desktop-viewer/local/shared"]) {
      const response = await fetch(new URL(path, server.info.url), { headers: { origin: server.info.url } });
      expect(response.status, path).toBe(409);
    }
    checks.push("bidirectional legacy browser/desktop upgrades and launch-triggering viewer GETs refused before resolving their targets");
    const history = await api("GET", "/api/personbot/legacy") as PersonbotLegacyList;
    expect(history.threads.find(row => row.id === bot.threadId)?.botName).toBe("Archived research");
    const detail = await api("GET", `/api/personbot/legacy/threads/${bot.threadId}`) as PersonbotLegacyDetail;
    expect(detail.messages.some(row => row.text.includes("Saved project research"))).toBe(true);
    expect(detail.messages.some(row => row.text.includes("UNSENT_ARCHIVED_INPUT"))).toBe(false);
    expect(detail.messages.find(row => row.id === "cutover-goal-card")?.text).toContain("Goal working");
    evidence.legacy = detail;
    const imported = {
      commandId: "cutover-owner-import", goal: "Continue the saved research and check its evidence.",
      progress: "The initial research has been collected. Recheck its conclusions before acting.", importConfiguration: true,
    };
    const endpoint = `/api/personbot/legacy/threads/${bot.threadId}/import`;
    const result = await api("POST", endpoint, imported) as PersonbotLegacyImportResult;
    expect(await api("POST", endpoint, imported)).toEqual(result);
    expect(result.sessionId).not.toBe(bot.threadId);
    expect(result.configurationImported).toBe(true);
    const rpc = <T>(method: string, params: object) => api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    await expect.poll(async () => {
      const snapshot = await rpc<RuntimeSnapshot>("personbot.v1.snapshots.get", { sessionId: result.sessionId, limit: 1000 });
      return JSON.stringify(snapshot).includes(imported.progress);
    }, { timeout: 30_000 }).toBe(true);
    const before = await rpc<RuntimeSnapshot>("personbot.v1.snapshots.get", { sessionId: result.sessionId, limit: 1000 });
    evidence.imported = { result, snapshot: before };
    expect(await api("GET", `/api/personbot/legacy/threads/${bot.threadId}`)).toEqual(detail);
    checks.push("old history remains unchanged while confirmed goal/progress create one persistent native dsh conversation with optional role/project settings");
    await delay(1_200);
    expect(existsSync(server.fixtureDumpPath) ? statSync(server.fixtureDumpPath).mtimeMs : 0).toBe(oldCalls);
    expect(readFileSync(routinePath, "utf8")).toBe(routineBytes);
    expect(readFileSync(calendarPath, "utf8")).toBe(calendarBytes);
    checks.push("overdue, running and waiting legacy routines, request receipts and unmigrated calendar records stayed byte-for-byte unchanged without old engine calls");
    const callbackProbe = await fetch(`http://127.0.0.1:${Number(new URL(server.info.url).port) + 1}/hooks/missing`, {
      method: "POST", signal: AbortSignal.timeout(1_000),
    }).then(() => true, () => false);
    expect(callbackProbe).toBe(false);
    checks.push("legacy webhook listener is not running in primary mode");
    await waitForExit(restarted, { signal: "SIGTERM", graceMs: 15_000 });
    restarted = undefined;
    expect(JSON.parse(offline(inspectLegacyState))).toEqual(legacyState);
    expect(readFileSync(routinePath, "utf8")).toBe(routineBytes);
    expect(readFileSync(calendarPath, "utf8")).toBe(calendarBytes);
    checks.push("primary shutdown preserved archived messages, active goal cards and pending/dispatching/aside followups for explicit rollback");
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM", graceMs: 15_000 });
    if (fixture) {
      await fixture.close();
      evidence.temporaryDataRemoved = !existsSync(fixture.info.dataDir);
      expect(evidence.temporaryDataRemoved).toBe(true);
      checks.push("owned servers exited and the disposable workspace was removed");
    }
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Personbot cutover verification evidence: ${evidenceDir}`);
    }
  }
}, 120_000);
