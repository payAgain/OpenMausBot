import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { IntegrationStore } from "../../packages/personbot-integrations/src/index.ts";
import type { ExecutionRecord, ScheduleRecord, TaskRecord, TriggerRecord } from "../../packages/personbot-protocol/src/index.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../control-omb.ts";
import { fixtureApi } from "./preview-fixture.ts";

function ownedRuntimePid(parentPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
}

function hasExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function expectExited(pid: number): Promise<void> {
  await expect.poll(() => hasExited(pid), { timeout: 10_000, interval: 100 }).toBe(true);
}

function rows<T>(path: string, table: "tasks" | "executions" | "schedules" | "triggers"): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)) as T);
  } finally {
    db.close();
  }
}

it("starts a due native schedule after server restart without opening the App or issuing runtime RPC", async () => {
  let fixture: VerificationServer | undefined;
  let restarted: ChildProcess | undefined;
  let originalRuntimePid: number | undefined;
  let restartedRuntimePid: number | undefined;
  let evidenceDir: string | undefined;
  const token = randomUUID().repeat(2);
  const checks: string[] = [];
  const evidence: Record<string, unknown> = { checks, postRestartHttpRequests: 0 };
  try {
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.personbot-background`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url, {
      headers: { origin: server.info.url },
      observe: call => ((evidence.initialOwnerRequests ??= []) as unknown[]).push(call),
    });
    const rpc = <T = unknown>(method: string, params: object = {}) => api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    await rpc("personbot.v1.sessions.create", { sessionId: "main", conversationId: "main" });
    await rpc("personbot.v1.sources.put", {
      commandId: "create-background-source", sourceId: "background-source",
      name: "Background restart fixture", originSessionId: "main", enabled: true,
      goal: "task-ready", criteria: ["fixture:verified evidence"], token, callbackMode: "idempotent",
    });
    const scheduleParams = {
      scheduleId: "background-once", sourceId: "background-source", name: "Background one-shot",
      threadId: "background-thread", text: "Inspect this local scheduled context", enabled: true,
    };
    const future = await rpc<ScheduleRecord>("personbot.v1.schedules.put", {
      ...scheduleParams, commandId: "create-future-schedule", runAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const runtimeDir = join(server.info.dataDir, "personbot", "runtime");
    const supervisorPath = join(runtimeDir, "supervisor.sqlite");
    const integrationsPath = join(runtimeDir, "integrations.sqlite");
    expect(rows<TaskRecord>(supervisorPath, "tasks")).toEqual([]);
    originalRuntimePid = ownedRuntimePid(server.info.pid);
    if (process.platform !== "win32") expect(originalRuntimePid).toBeGreaterThan(1);
    evidence.originalRuntimePid = originalRuntimePid;
    await waitForExit(server.child, { signal: "SIGTERM", graceMs: 15_000 });
    await expectExited(server.info.pid);
    if (originalRuntimePid) await expectExited(originalRuntimePid);
    expect(existsSync(server.info.dataDir)).toBe(true);
    checks.push("original owned server and dsh runtime exited while the temporary data remained");

    const offline = new IntegrationStore(integrationsPath);
    try {
      const due = offline.putSchedule({
        ...scheduleParams, commandId: "make-schedule-due-offline", expectedRevision: future.revision,
        runAt: new Date(Date.now() - 5_000).toISOString(),
      });
      expect(due.revision).toBe(future.revision + 1);
      evidence.offlineSchedule = due;
    } finally {
      offline.close();
    }
    checks.push("a new revision made the existing one-shot schedule due while all owned processes were stopped");

    const restartLogPath = `${server.info.logPath}.background-restart.log`;
    const env = verificationServerEnvironment(process.env, server.info.dataDir, Number(new URL(server.info.url).port), true);
    expect(env.HOME).toBe(server.info.dataDir);
    expect(env.PERSONBOT_HOME).toBe(join(server.info.dataDir, "personbot"));
    expect(env.PERSONBOT_FIXTURE).toBe("1");
    evidence.restart = { home: env.HOME, personbotHome: env.PERSONBOT_HOME, workspace: env.PERSONBOT_WORKSPACE, logPath: restartLogPath };
    const log = openSync(restartLogPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    expect(restarted.pid).toBeGreaterThan(1);
    evidence.restartedServerPid = restarted.pid;
    const snapshot = () => ({
      tasks: rows<TaskRecord>(supervisorPath, "tasks"),
      executions: rows<ExecutionRecord>(supervisorPath, "executions"),
      schedules: rows<ScheduleRecord>(integrationsPath, "schedules"),
      triggers: rows<TriggerRecord>(integrationsPath, "triggers"),
    });
    // From this point onwards the test only observes SQLite and owned processes.
    // A lazy gateway would leave this schedule untouched and fail this assertion.
    await expect.poll(() => {
      expect(restarted!.exitCode).toBeNull();
      expect(restarted!.signalCode).toBeNull();
      const value = snapshot();
      return value.tasks.length === 1 && value.tasks[0]?.stage === "awaiting_review"
        && value.tasks[0]?.stopState === "confirmed" && value.tasks[0]?.lifecycle === "open";
    }, { timeout: 45_000, interval: 200 }).toBe(true);
    const first = snapshot();
    expect(first.executions).toHaveLength(1);
    expect(first.triggers).toHaveLength(1);
    expect(first.triggers[0]).toMatchObject({ sourceId: scheduleParams.sourceId, threadId: scheduleParams.threadId, status: "delivered", taskIds: [first.tasks[0]!.id] });
    expect(first.tasks[0]?.report?.evidence).toEqual(["fixture:verified"]);
    expect(first.schedules).toHaveLength(1);
    expect(first.schedules[0]).toMatchObject({ id: scheduleParams.scheduleId, enabled: false });
    expect(first.schedules[0]?.nextRunAt).toBeUndefined();
    restartedRuntimePid = ownedRuntimePid(restarted.pid!);
    if (process.platform !== "win32") expect(restartedRuntimePid).toBeGreaterThan(1);
    evidence.restartedRuntimePid = restartedRuntimePid;
    evidence.completedSnapshot = first;
    checks.push("restarted server eagerly launched its owned dsh runtime with no App, RPC, webhook or health request");
    checks.push("the due one-shot created exactly one task, execution and delivered trigger, then disabled itself");
    checks.push("the native worker supplied evidence and stopped at human review with confirmed execution stop");
    await delay(1_250);
    const second = snapshot();
    expect(second.tasks.map(row => row.id)).toEqual(first.tasks.map(row => row.id));
    expect(second.executions.map(row => row.id)).toEqual(first.executions.map(row => row.id));
    expect(second.triggers.map(row => row.id)).toEqual(first.triggers.map(row => row.id));
    evidence.stableSnapshot = second;
    checks.push("another scheduler interval created no duplicate task, execution or trigger");
  } catch (error) {
    evidence.error = (error instanceof Error ? error.stack ?? error.message : String(error)).replaceAll(token, "[redacted]");
    throw error;
  } finally {
    try {
      await waitForExit(restarted, { signal: "SIGTERM", graceMs: 15_000 });
      if (restarted?.pid) await expectExited(restarted.pid);
      if (restartedRuntimePid) await expectExited(restartedRuntimePid);
      if (fixture) {
        await waitForExit(fixture.child, { signal: "SIGTERM", graceMs: 15_000 });
        if (originalRuntimePid) await expectExited(originalRuntimePid);
        await fixture.close();
        expect(existsSync(fixture.info.dataDir)).toBe(false);
        evidence.temporaryDataRemoved = true;
        checks.push("both owned server/runtime pairs exited before the fixture removed its temporary data");
      }
    } finally {
      if (evidenceDir) {
        writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        writeFileSync(join(evidenceDir, "verification.log"), `${checks.join("\n")}\n${evidence.error ?? ""}\n`);
        console.log(`Personbot background verification evidence: ${evidenceDir}`);
      }
    }
  }
}, 120_000);
