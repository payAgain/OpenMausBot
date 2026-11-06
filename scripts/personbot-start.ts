import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchVerificationServer, type VerificationServer } from "./control-omb.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    home: { type: "string" },
    workspace: { type: "string" },
    port: { type: "string" },
    build: { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

function newestSource(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "test" && !entry.name.includes(".test."))
    .reduce((latest, entry) => Math.max(latest, newestSource(join(path, entry.name))), stat.mtimeMs);
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface OwnedProcess {
  child: ChildProcess;
  exited: Promise<ProcessExit>;
  group: boolean;
  graceMs: number;
}

function observeChild(child: ChildProcess, group: boolean, graceMs: number): OwnedProcess {
  const exited = new Promise<ProcessExit>(resolveExit => {
    const finish = (result: ProcessExit) => {
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal });
    const onError = (error: Error) => finish({ code: null, signal: null, error });
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) finish({ code: child.exitCode, signal: child.signalCode });
  });
  return { child, exited, group, graceMs };
}

function spawnOwned(command: string, args: string[], options: SpawnOptions, graceMs: number): OwnedProcess {
  const group = process.platform !== "win32";
  return observeChild(spawn(command, args, { ...options, detached: group, windowsHide: true }), group, graceMs);
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      const groups = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
      return groups.split("\n").some(line => {
        const row = /^\s*(\d+)\s+(\S+)/.exec(line);
        return row && Number(row[1]) === pid && !/^[ZX]/.test(row[2]!);
      });
    }
    throw error;
  }
}

async function stopChild(owned: OwnedProcess | undefined): Promise<void> {
  if (!owned) return;
  const { child, group, graceMs } = owned;
  const pid = child.pid;
  if (!pid) {
    await owned.exited;
    return;
  }
  const alive = () => group ? groupExists(pid) : child.exitCode === null && child.signalCode === null;
  const sendGroup = (signal: NodeJS.Signals) => {
    try {
      if (group) process.kill(-pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code === "EPERM" && group && !groupExists(pid)) return;
      throw error;
    }
  };
  if (!alive()) { await owned.exited; return; }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH"
        && !((error as NodeJS.ErrnoException).code === "EPERM" && group && !groupExists(pid))) throw error;
    }
  }
  if (graceMs <= 2_000 || child.exitCode !== null || child.signalCode !== null) sendGroup("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) await delay(25);
  if (alive()) sendGroup("SIGKILL");
  const killedDeadline = Date.now() + 2_000;
  while (alive() && Date.now() < killedDeadline) await delay(25);
  await owned.exited;
  if (alive()) throw new Error("An owned Personbot process group did not stop");
}

async function availablePort(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolvePort, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolvePort);
    });
  } catch {
    throw new Error(`Port ${port} is already in use. Stop the previous server or choose --port PORT.`);
  } finally {
    if (probe.listening) await new Promise<void>((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
  }
}

async function main(): Promise<void> {
  if (values.help) {
    console.log(`Personbot — personal dsh workspace

pnpm personbot:start                       build if needed, then serve the App
pnpm personbot:start --demo                isolated demo, no API key required
pnpm personbot:start --port 8809           choose a different local port
pnpm personbot:start --home /path/to/home --workspace /path/to/project

Open the printed URL. Configure the model in the existing App settings on first use.
pnpm personbot:build checks the source and builds the App into dist-personbot.
--build forces that build; --skip-build uses the existing dist-personbot directory.
Ctrl-C closes the owned server and dsh runtime. Demo data is deleted on exit.
The source runtime requires Node.js 24+ and the locked pnpm dependencies.`);
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Personbot requires Node.js 24 or newer.");
  if (values.build && values["skip-build"]) throw new Error("Choose either --build or --skip-build.");
  if (values.demo && (values.home || values.workspace)) throw new Error("The demo always uses a disposable home and workspace.");
  const port = Number(values.port ?? process.env.OMB_PORT ?? 8799);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("Port must be an integer from 1024 to 65534.");
  const require = createRequire(new URL("../packages/personbot-superagent/package.json", import.meta.url));
  const expectedVersion = (require("./package.json") as { dependencies: Record<string, string> }).dependencies["@deepseek-ai/dsh"];
  let installed: { version: string };
  try { installed = require("@deepseek-ai/dsh/package.json") as { version: string }; }
  catch { throw new Error("Dependencies are missing. Run pnpm install --frozen-lockfile first."); }
  if (installed.version !== expectedVersion) throw new Error(`Expected dsh ${expectedVersion}; run pnpm install --frozen-lockfile.`);
  const staticDir = join(root, "dist-personbot");
  const index = join(staticDir, "index.html");
  if (values["skip-build"] && !existsSync(index)) throw new Error("No dist-personbot frontend build exists. Run pnpm personbot:build.");
  const needsBuild = !existsSync(index) || values.build || (
    !values["skip-build"] && Math.max(...["src", "shared", "packages", "index.html", "vite.config.ts", "package.json", "pnpm-lock.yaml"]
      .map(path => newestSource(join(root, path)))) > statSync(index).mtimeMs
  );
  let owned: OwnedProcess | undefined;
  let fixture: VerificationServer | undefined;
  let interrupted = false;
  const controller = new AbortController();
  let finishSignal: () => void = () => {};
  const signal = new Promise<void>(resolveSignal => { finishSignal = resolveSignal; });
  const interrupt = () => { interrupted = true; controller.abort(); finishSignal(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (needsBuild) {
      console.log("Building Personbot…");
      const pnpm = process.env.npm_execpath;
      owned = pnpm
        ? spawnOwned(process.execPath, [pnpm, "personbot:build"], { cwd: root, stdio: "inherit" }, 2_000)
        : spawnOwned(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["personbot:build"], { cwd: root, stdio: "inherit" }, 2_000);
      const result = await Promise.race([owned.exited, signal.then(() => null)]);
      if (interrupted) return;
      if (result?.error) throw new Error(`Personbot build could not start: ${result.error.message}`);
      if (result?.code !== 0) throw new Error("Personbot build failed. See the diagnostics above.");
      await stopChild(owned);
      owned = undefined;
    }
    if (!existsSync(index)) throw new Error("No dist-personbot frontend build exists. Run pnpm personbot:build.");
    let url: string;
    if (values.demo) {
      const demoEnv = { ...process.env, ...(values.port ? { OMB_TEST_PORTS: `${port}-${port + 1}` } : {}) };
      fixture = await launchVerificationServer(demoEnv, controller.signal, undefined, undefined, undefined, undefined, [], undefined, staticDir, true, true, true);
      owned = observeChild(fixture.child, false, 15_000);
      url = fixture.info.url;
      console.log(`Demo data: ${fixture.info.dataDir}\nDemo log: ${fixture.info.logPath}`);
    } else {
      await availablePort(port);
      const env = {
        ...process.env, PERSONBOT_ENABLED: "1", PERSONBOT_PRIMARY: "1", PERSONBOT_SUPERAGENT: "1", OMB_STATIC_DIR: staticDir, OMB_PORT: String(port),
        ...(values.home ? { PERSONBOT_HOME: resolve(values.home) } : {}),
        ...(values.workspace ? { PERSONBOT_WORKSPACE: resolve(values.workspace) } : {}),
      };
      owned = spawnOwned(process.execPath, ["--experimental-strip-types", join(root, "server", "dev-server.ts")], {
        cwd: root, env, stdio: "inherit",
      }, 15_000);
      const server = owned;
      url = `http://127.0.0.1:${port}`;
      const started = Date.now();
      for (;;) {
        if (interrupted) return;
        const exited = await Promise.race([server.exited, Promise.resolve(undefined)]);
        if (exited) throw new Error(exited.error ? `Personbot server could not start: ${exited.error.message}` : "Personbot server exited before it was ready.");
        try {
          const response = await fetch(`${url}/api/health`, { headers: { origin: url }, signal: AbortSignal.timeout(1_000) });
          const health = await response.json() as { pid?: number };
          if (response.ok && health.pid === server.child.pid) break;
        } catch {}
        if (Date.now() - started > 60_000) throw new Error("Personbot server did not become ready within 60 seconds.");
        await Promise.race([delay(200), signal]);
      }
    }
    if (interrupted) return;
    console.log(`\nOpenMausBot + Super Agent is ready${values.demo ? " · isolated demo" : ""}\n${url}\nConfigure the model in App settings. Ctrl-C stops this server.\n`);
    await Promise.race([
      signal,
      owned!.exited.then(result => {
        if (result.error) throw new Error(`Personbot server could not start: ${result.error.message}`);
        if (result.code !== 0 && !interrupted) throw new Error(`Personbot server exited (${result.code ?? result.signal ?? "unknown"}).`);
      }),
    ]);
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    await (fixture ? fixture.close() : stopChild(owned));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
