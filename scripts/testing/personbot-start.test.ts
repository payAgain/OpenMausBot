import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LAUNCHER = join(ROOT, "scripts", "personbot-start.ts");
const BUILT_INDEX = join(ROOT, "dist-personbot", "index.html");
const READY = "OpenMausBot + Super Agent is ready";
const directories: string[] = [];
const launched: ChildProcess[] = [];
const processes = new Set<number>();

function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function environment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: directory, USERPROFILE: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
    SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    LANG: "en_US.UTF-8", TZ: "UTC",
  };
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "personbot-launcher-"));
  directories.push(path);
  return path;
}

function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  launched.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

afterEach(async () => {
  for (const child of launched.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
    await new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
  }
  for (const pid of processes) {
    if (!exited(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  }
  processes.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("documents the dedicated official product build and serve directory", () => {
  const help = execFileSync(process.execPath, [LAUNCHER, "--help"], { cwd: ROOT, env: environment(directory()), encoding: "utf8" });
  expect(help).toContain("pnpm personbot:build");
  expect(help).toContain("--skip-build uses the existing dist-personbot directory");
});

it.skipIf(process.platform === "win32")("interrupts a build and stops both the owned package runner and its stubborn child", async () => {
  const home = directory();
  const marker = join(home, "build-pids.json");
  const ready = join(home, "child-ready");
  const fakePnpm = join(home, "fake-pnpm.mjs");
  writeFileSync(fakePnpm, `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const child = spawn(process.execPath, ['-e', \`
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(process.env.BUILD_CHILD_READY, String(process.pid));
      setInterval(() => {}, 1000);
    \`], {stdio:'ignore', env:process.env});
    writeFileSync(process.env.BUILD_PID_FILE, JSON.stringify({parent:process.pid,child:child.pid,args:process.argv.slice(2)}));
    setInterval(() => {}, 1000);
  `);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore", env: environment(home), detached: true,
  });
  processes.add(unrelated.pid!);
  const app = launch(["--demo", "--build"], {
    ...environment(home), npm_execpath: fakePnpm, BUILD_PID_FILE: marker, BUILD_CHILD_READY: ready,
  });
  await expect.poll(() => existsSync(marker) && existsSync(ready), { timeout: 10_000, interval: 50 }).toBe(true);
  const pids = JSON.parse(readFileSync(marker, "utf8")) as { parent: number; child: number; args: string[] };
  expect(pids.args).toEqual(["personbot:build"]);
  processes.add(pids.parent);
  processes.add(pids.child);
  expect(exited(pids.parent)).toBe(false);
  expect(exited(pids.child)).toBe(false);
  app.child.kill("SIGTERM");
  let exit: Awaited<typeof app.closed> | undefined;
  void app.closed.then(value => { exit = value; });
  await expect.poll(() => exit, { timeout: 8_000, interval: 50 }).toEqual({ code: 0, signal: null });
  await expect.poll(() => exited(pids.parent) && exited(pids.child), { timeout: 3_000, interval: 50 }).toBe(true);
  expect(exited(unrelated.pid!)).toBe(false);
  expect(app.stdout()).toContain("Building Personbot");
  expect(app.stdout()).not.toContain("Personbot is ready");
  writeFileSync("/tmp/personbot-w6-launcher-interruption.json", JSON.stringify({
    checks: ["interrupted build exits cleanly", "owned runner exits", "TERM-ignoring child exits", "unrelated process remains alive"],
    launcherPid: app.child.pid, parentPid: pids.parent, childPid: pids.child, exit,
    parentExited: exited(pids.parent), childExited: exited(pids.child), unrelatedExited: exited(unrelated.pid!),
  }, null, 2));
}, 20_000);

it("reports a fast failed build instead of waiting for a missed exit event", async () => {
  const home = directory();
  const fakePnpm = join(home, "failed-pnpm.mjs");
  writeFileSync(fakePnpm, "process.exit(27);\n");
  const app = launch(["--demo", "--build"], { ...environment(home), npm_execpath: fakePnpm });
  let exit: Awaited<typeof app.closed> | undefined;
  void app.closed.then(value => { exit = value; });
  await expect.poll(() => exit, { timeout: 8_000, interval: 50 }).toEqual({ code: 1, signal: null });
  expect(app.stderr()).toContain("Personbot build failed");
  expect(app.stdout()).not.toContain("Personbot is ready");
});

it.skipIf(process.platform === "win32")("reports a package-runner spawn error without hanging cleanup", async () => {
  const home = directory();
  const app = launch(["--demo", "--build"], { ...environment(home), PATH: join(home, "empty-path") });
  let exit: Awaited<typeof app.closed> | undefined;
  void app.closed.then(value => { exit = value; });
  await expect.poll(() => exit, { timeout: 8_000, interval: 50 }).toEqual({ code: 1, signal: null });
  expect(app.stderr()).toContain("Personbot build could not start");
  expect(app.stderr()).toContain("ENOENT");
});

it.skipIf(!existsSync(BUILT_INDEX) || process.platform === "win32")("serves the dedicated official product build and stops its actual dsh runtime before deleting demo data", async () => {
  const home = directory();
  const app = launch(["--demo", "--skip-build"], environment(home));
  let dataDir: string | undefined;
  let serverPid: number | undefined;
  let runtimePid: number | undefined;
  let evidenceDir: string | undefined;
  let fixtureLog: string | undefined;
  try {
    const deadline = Date.now() + 45_000;
    while (!app.stdout().includes(READY)) {
      const result = await Promise.race([app.closed, delay(100, undefined)]);
      if (result) throw new Error(`Demo exited before ready (${result.code ?? result.signal}).\n${app.stdout()}\n${app.stderr()}`);
      if (Date.now() >= deadline) throw new Error(`Demo did not become ready.\n${app.stdout()}\n${app.stderr()}`);
    }
    const url = /OpenMausBot \+ Super Agent is ready[^\n]*\n(http:\/\/127\.0\.0\.1:\d+)/.exec(app.stdout())?.[1];
    dataDir = /Demo data: ([^\n]+)/.exec(app.stdout())?.[1]?.trim();
    fixtureLog = /Demo log: ([^\n]+)/.exec(app.stdout())?.[1]?.trim();
    expect(url).toBeTruthy();
    expect(dataDir).toBeTruthy();
    expect(fixtureLog).toBeTruthy();
    evidenceDir = join(tmpdir(), "openmausbot-verification-evidence", `personbot-launcher-${Date.now()}-${process.pid}`);
    mkdirSync(evidenceDir, { recursive: true });
    const health = await fetch(`${url}/api/health`).then(response => response.json()) as { pid: number };
    serverPid = health.pid;
    processes.add(serverPid);
    const setup = await fetch(`${url}/api/personbot/setup`).then(response => response.json());
    expect(setup).toMatchObject({ primary: true, credential: { configured: true }, provider: "personbot-fixture" });
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method, headers: { "content-type": "application/json", origin: url! },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    const { bot } = await api("/api/bots", "POST", { name: "Launcher smoke", memoryUpkeep: false }) as { bot: { id: string; threadId: string } };
    await api(`/api/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text: "echo launcher-product-ready" });
    await expect.poll(async () => {
      const page = await api(`/api/threads/${bot.threadId}/messages?limit=100`) as { messages: Array<{ role: string; text?: string }> };
      return page.messages.some(message => message.role === "bot" && message.text?.includes("launcher-product-ready"));
    }, { timeout: 45_000, interval: 100 }).toBe(true);
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
      if (match && Number(match[2]) === serverPid && match[3]!.trim().endsWith("node")) runtimePid = Number(match[1]);
    }
    expect(runtimePid).toBeGreaterThan(1);
    processes.add(runtimePid!);
    const staticResponse = await fetch(`${url}/`);
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toBe(readFileSync(BUILT_INDEX, "utf8"));
    app.child.kill("SIGTERM");
    let exit: Awaited<typeof app.closed> | undefined;
    void app.closed.then(value => { exit = value; });
    await expect.poll(() => exit, { timeout: 20_000, interval: 100 }).toEqual({ code: 0, signal: null });
    await expect.poll(() => exited(serverPid!) && exited(runtimePid!), { timeout: 5_000, interval: 100 }).toBe(true);
    expect(existsSync(dataDir!)).toBe(false);
    writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify({
      checks: ["dedicated dist-personbot original App served", "official Super Agent setup fixture", "original chat completed through official runtime and native dsh", "owned server and runtime stopped", "demo data removed"],
      launcherPid: app.child.pid, serverPid, runtimePid, dataDir, url, exit,
      serverExited: exited(serverPid!), runtimeExited: exited(runtimePid!), dataRemoved: !existsSync(dataDir!),
    }, null, 2));
    writeFileSync("/tmp/personbot-official-launcher-evidence-path.txt", evidenceDir);
  } finally {
    writeFileSync("/tmp/personbot-official-launcher-demo-output.log", `${app.stdout()}\n${app.stderr()}`);
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "launcher.log"), `${app.stdout()}\n${app.stderr()}`);
      if (fixtureLog && existsSync(fixtureLog)) copyFileSync(fixtureLog, join(evidenceDir, "server.log"));
    }
  }
  console.log(`Personbot launcher verification evidence: ${evidenceDir}`);
}, 90_000);

it.skipIf(!existsSync(BUILT_INDEX) || process.platform === "win32")("starts a normal private workspace from the dedicated product build and leaves dsh stopped until setup", async () => {
  const home = directory();
  const probe = createServer();
  await new Promise<void>(resolveListen => probe.listen(0, "127.0.0.1", resolveListen));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
  const personbotHome = join(home, "personbot");
  const probeQuirk = join(home, "empty-group-permission.mjs");
  writeFileSync(probeQuirk, `
    const signal = process.kill.bind(process);
    process.kill = (pid, value) => {
      try { return signal(pid, value); }
      catch (error) {
        if (pid < 0 && value === 0 && error.code === 'ESRCH') {
          throw Object.assign(new Error('kill EPERM after empty group'), {code:'EPERM'});
        }
        throw error;
      }
    };
  `);
  const app = launch(["--skip-build", "--port", String(port), "--home", personbotHome, "--workspace", join(home, "workspace")], {
    ...environment(home), OMB_DATA_DIR: join(home, "legacy-data"), DSH_HOME: join(home, "isolated-dsh"),
    NODE_OPTIONS: `--import=${pathToFileURL(probeQuirk).href}`,
  });
  const deadline = Date.now() + 45_000;
  while (!app.stdout().includes(READY)) {
    const result = await Promise.race([app.closed, delay(100, undefined)]);
    if (result) throw new Error(`Private workspace exited before ready (${result.code ?? result.signal}).\n${app.stdout()}\n${app.stderr()}`);
    if (Date.now() >= deadline) throw new Error(`Private workspace did not become ready.\n${app.stdout()}\n${app.stderr()}`);
  }
  const url = `http://127.0.0.1:${port}`;
  const setupResponse = await fetch(`${url}/api/personbot/setup`);
  expect(setupResponse.status).toBe(200);
  const setup = await setupResponse.json();
  expect(setup).toMatchObject({
    primary: true, revision: 0, provider: "deepseek-official", model: "deepseek-flash",
    credential: { configured: false, source: "missing" }, runtime: { state: "ready" },
  });
  const health = await fetch(`${url}/api/health`).then(response => response.json()) as { pid: number };
  processes.add(health.pid);
  const page = await fetch(`${url}/`).then(response => response.text());
  expect(page).toBe(readFileSync(BUILT_INDEX, "utf8"));
  expect(await fetch(`${url}/api/personbot/status`).then(response => response.json())).toMatchObject({ state: "ready" });
  const children = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")
    .filter(row => Number(/^\s*\d+\s+(\d+)/.exec(row)?.[1]) === health.pid);
  expect(children).toEqual([]);
  app.child.kill("SIGTERM");
  const exit = await Promise.race([app.closed, delay(20_000, undefined, { ref: false })]);
  writeFileSync("/tmp/personbot-official-launcher-normal-exit.json", JSON.stringify({
    exit, stdout: app.stdout(), stderr: app.stderr(),
  }, null, 2));
  expect(exit, `${app.stdout()}\n${app.stderr()}`).toEqual({ code: 0, signal: null });
  expect(exited(health.pid)).toBe(true);
  expect(existsSync(personbotHome)).toBe(true);
  writeFileSync("/tmp/personbot-official-launcher-first-use.json", JSON.stringify({
    checks: ["normal isolated launch serves production UI", "primary mode requires first-use model setup", "no dsh or legacy child automatically launched", "owned server and process group stopped", "normal persistent home retained until test cleanup"],
    launcherPid: app.child.pid, serverPid: health.pid, url, exit, setup, children,
    serverExited: exited(health.pid), homeRetained: existsSync(personbotHome),
  }, null, 2));
}, 90_000);
