import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Ticket, Trigger } from "../../packages/personbot-superagent/upstream/src/core/model.ts";
import { closeBrowserSession } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import {
  launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer,
} from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

interface Message {
  id: string;
  role: string;
  kind: string;
  text?: string;
  card?: { requestId?: string; answered?: boolean; expired?: boolean; dismissed?: boolean };
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function officialState(home: string) {
  return files(join(home, "official-superagent"))
    .filter(file => file.endsWith("/state/orchestrator.sqlite"))
    .map(file => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = <T>(table: string): T[] => db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(String(row.value)) as T);
        return { file, triggers: rows<Trigger>("trigger"), tickets: rows<Ticket>("ticket"), outbox: rows<unknown>("outbox") };
      } finally { db.close(); }
    });
}

function runtimePids(serverPid: number): number[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === serverPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!) ? [Number(match[1])] : [];
  });
}

it("keeps the original App and memory while official Super Agent owns execution and native continuation", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let restarted: ChildProcess | undefined;
  let evidenceDir: string | undefined;
  const checks: string[] = [];
  const evidence: Record<string, unknown> = { checks };
  try {
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" },
      undefined, undefined, [], undefined, undefined, true, true, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.official-superagent`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url, {
      headers: { origin: server.info.url },
      observe: call => {
        if (call.method === "GET") return;
        const calls = (evidence.api ??= []) as unknown[];
        calls.push(call);
      },
    });
    const home = join(server.info.dataDir, "personbot");
    expect(await api("GET", "/api/personbot/status")).toMatchObject({ state: "ready" });
    expect(runtimePids(server.info.pid)).toEqual([]);
    const instances = await api("GET", "/api/instances") as { instances: Array<{ instanceId: string }> };
    expect(instances.instances.map(instance => instance.instanceId)).toEqual(["dsh-superagent"]);
    checks.push("reads do not launch DSH; only the official driver is registered");
    await api("PATCH", "/api/config", { language: "en" });
    const { bot } = await api("POST", "/api/bots", { name: "Official integration", memoryUpkeep: false }) as { bot: { id: string; threadId: string } };
    await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false });
    evidence.bot = bot;
    const page = async (threadId = bot.threadId) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`) as { messages: Message[] }).messages;
    const settled = async () => {
      await expect.poll(async () => {
        const value = await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; busy: boolean }> };
        return value.bots.find(row => row.id === bot.id)?.busy;
      }, { timeout: 60_000, interval: 150 }).toBe(false);
    };
    const send = async (text: string) => {
      const before = new Set((await page()).map(message => message.id));
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
      await expect.poll(async () => (await page()).some(message => !before.has(message.id) && message.role === "bot" && message.kind === "text" && message.text?.trim()),
        { timeout: 60_000, interval: 150 }).toBe(true);
      await settled();
      return (await page()).filter(message => !before.has(message.id));
    };

    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__official-superagent.html",
      title: "Original OpenMausBot · official Super Agent fixture", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-official-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const dismissWelcome = async () => {
      if (!await evaluate("Boolean(document.querySelector('[data-mausbot-welcome-later]'))")) return;
      await run("click", "[data-mausbot-welcome-later]");
      await expect.poll(() => evaluate("Boolean(document.querySelector('[data-mausbot-welcome]'))")).toBe(false);
    };
    await run("set", "viewport", "1440", "1000");
    await run("open", preview.previewUrl);
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-sidebar-bot-row="${bot.id}"]'))`), { timeout: 60_000 }).toBe(true);
    await run("click", `[data-sidebar-bot-row="${bot.id}"]`);
    await expect.poll(() => evaluate(`Boolean(document.querySelector('textarea[aria-label="Message Official integration"]'))`), { timeout: 20_000 }).toBe(true);
    await dismissWelcome();
    expect(await evaluate(`Boolean(document.querySelector('[data-personbot-product], [data-personbot-view]'))`)).toBe(false);
    await run("fill", 'textarea[aria-label="Message Official integration"]', "echo original-ui-official-runtime");
    await run("press", "Enter");
    await expect.poll(async () => (await page()).filter(message => message.role === "bot" && message.kind === "text" && message.text?.includes("original-ui-official-runtime")).length,
      { timeout: 60_000, interval: 200 }).toBe(1);
    await settled();
    await expect.poll(() => evaluate(`document.querySelector('main')?.textContent.includes('original-ui-official-runtime')`), { timeout: 20_000 }).toBe(true);
    await dismissWelcome();
    checks.push("original sidebar, composer and transcript send through official runtime without duplicate worker text");

    await api("PUT", `/api/bots/${bot.id}/memory/file`, { path: "memory/preferences.md", text: "- The person prefers jasmine tea.\n" });
    const recalled = await send("memory jasmine tea");
    expect(JSON.stringify(recalled)).toContain("jasmine tea");
    expect(JSON.stringify(recalled)).toContain("omb.memory");
    checks.push("native memory retrieval reads notes edited through the original memory API");
    await api("PATCH", "/api/config", { profile: { name: "Fixture owner", aboutMe: "The person keeps a green bicycle." } });
    const profile = await send("memory green bicycle");
    expect(JSON.stringify(profile)).toContain("omb.profile");
    expect(JSON.stringify(profile)).toContain("green bicycle");
    await api("PATCH", "/api/config", { profile: { name: "Fixture owner", aboutMe: "The person keeps a blue bicycle." } });
    const editedProfile = await send("memory blue bicycle");
    expect(JSON.stringify(editedProfile)).toContain("omb.profile");
    expect(JSON.stringify(editedProfile)).toContain("blue bicycle");
    checks.push("About me is retrieved live from the original profile and reflects edits within an existing native conversation");
    const remembered = await send("remember The person prefers concise architecture reviews.");
    expect(JSON.stringify(remembered)).toContain("remember");
    const memory = await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`) as { text: string };
    expect(memory.text).toContain("The person prefers concise architecture reviews.");
    const journal = await api("GET", `/api/bots/${bot.id}/memory/journal`) as { entries: Array<{ via: string }> };
    expect(journal.entries.some(entry => entry.via === "superagent-memory.remember")).toBe(true);
    checks.push("remember updates the original MEMORY.md and original memory journal");
    await send("forget concise architecture reviews");
    expect((await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`) as { text: string }).text).not.toContain("The person prefers concise architecture reviews.");
    const forgotten = await send("memory concise architecture reviews");
    expect(JSON.stringify(forgotten).replaceAll("[", "").replaceAll("]", ""))
      .not.toContain("The person prefers concise architecture reviews.");
    checks.push("forget removes the active fact and suppresses historical recall");

    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" });
    await send("task write official-proof.txt");
    await expect.poll(() => existsSync(join(server.info.dataDir, "personbot-workspace", "official-proof.txt")), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(join(server.info.dataDir, "personbot-workspace", "official-proof.txt"), "utf8"))
      .toBe("Official Super Agent worker executed a native DSH file tool.\n");
    const workerMemory = await send("task memory jasmine tea");
    expect(JSON.stringify(workerMemory)).toContain("jasmine tea");
    checks.push("the official Engine starts a real worker that executes native DSH tools and retrieves the same original memory");

    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const pendingDecision = async (text: string) => {
      const before = new Set((await page()).map(message => message.id));
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
      let requestId: string | undefined;
      await expect.poll(async () => {
        requestId = (await page()).findLast(message => !before.has(message.id)
          && message.card?.requestId && !message.card.answered && !message.card.expired && !message.card.dismissed)?.card?.requestId;
        return Boolean(requestId);
      }, { timeout: 45_000, interval: 150 }).toBe(true);
      return requestId!;
    };
    const approvedFile = join(server.info.dataDir, "personbot-workspace", "official-approved.txt");
    const deniedId = await pendingDecision("task approval");
    expect(existsSync(approvedFile)).toBe(false);
    expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: deniedId, behavior: "deny" }))
      .toMatchObject({ outcome: "rejected" });
    await settled();
    expect(existsSync(approvedFile)).toBe(false);
    const allowedId = await pendingDecision("task approval");
    expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: allowedId, behavior: "allow" }))
      .toMatchObject({ outcome: "allowed-once" });
    await expect.poll(() => existsSync(approvedFile), { timeout: 30_000 }).toBe(true);
    await settled();
    const staleAnswer = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: deniedId, behavior: "allow" });
    expect(staleAnswer).toMatchObject({ outcome: "unavailable" });
    checks.push("original approval API denies and allows the exact native request; an old decision cannot approve new work");
    const questionId = await pendingDecision("task question");
    expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: questionId, behavior: "answer", message: "Markdown" }))
      .toMatchObject({ outcome: "answered" });
    await settled();
    checks.push("native user questions round-trip through the original product question card");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "task hold" });
    await expect.poll(() => {
      const state = officialState(home);
      const trigger = state.flatMap(row => row.triggers).findLast(row => row.text === "task hold");
      return state.flatMap(row => row.tickets).some(ticket => !ticket.ended
        && ticket.assignments.some(assignment => assignment.state === "running")
        && ticket.inputs.some(input => input.kind === "trigger" && input.triggerId === trigger?.id && input.readAt != null));
    }, { timeout: 30_000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await settled();
    const afterStop = await send("echo after-official-stop");
    expect(afterStop.filter(message => message.role === "bot" && message.kind === "text" && message.text?.includes("after-official-stop"))).toHaveLength(1);
    checks.push("original Stop cancels native work and the same product conversation accepts a new request");

    const beforeRestart = await page();
    const beforeState = officialState(home);
    evidence.beforeRestartState = beforeState;
    expect(beforeState.length).toBeGreaterThan(0);
    expect(beforeState.flatMap(state => state.triggers).length).toBeGreaterThanOrEqual(7);
    expect(beforeState.flatMap(state => state.tickets).length).toBeGreaterThanOrEqual(1);
    expect(runtimePids(server.info.pid).length).toBeGreaterThan(0);
    expect(files(home).some(file => file.endsWith("/personal.sqlite"))).toBe(false);
    checks.push("the live path persists real upstream triggers/outbox and does not create a parallel personal fact database");
    await waitForExit(server.child, { signal: "SIGTERM", graceMs: 20_000 });
    const env = verificationServerEnvironment(process.env, server.info.dataDir, Number(new URL(server.info.url).port), true, true, true);
    const log = openSync(join(evidenceDir, "restart.log"), "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 45_000 }).toBe("openmausbot");
    expect(await page()).toEqual(beforeRestart);
    const resumed = await send("echo after-official-server-restart");
    expect(resumed.filter(message => message.role === "bot" && message.kind === "text" && message.text?.includes("after-official-server-restart"))).toHaveLength(1);
    const afterState = officialState(home);
    expect(afterState.map(state => state.file)).toEqual(beforeState.map(state => state.file));
    evidence.afterRestartState = afterState;
    checks.push("server restart retains original messages and continues the same official native binding");

    await expect.poll(() => evaluate(`document.querySelector('main')?.textContent.includes('after-official-server-restart')`),
      { timeout: 65_000 }).toBe(true);
    await dismissWelcome();
    const layouts: unknown[] = [];
    for (const width of [1440, 390]) {
      await run("set", "viewport", String(width), "1000");
      await expect.poll(() => evaluate("innerWidth")).toBe(width);
      if (width < 768) {
        await expect.poll(() => evaluate("document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? Infinity"))
          .toBeLessThanOrEqual(1);
      }
      const geometry = await evaluate<{ width: number; page: number; left: number; right: number }>(`(() => {
        const r = document.querySelector('textarea[aria-label="Message Official integration"]').getBoundingClientRect();
        return {width:innerWidth,page:document.documentElement.scrollWidth,left:r.left,right:r.right};
      })()`);
      expect(geometry.page).toBeLessThanOrEqual(width);
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(width + 1);
      layouts.push(geometry);
      await run("screenshot", join(evidenceDir, `original-app-${width}.png`));
    }
    evidence.layouts = layouts;
    evidence.messages = await page();
    checks.push("original desktop and mobile layouts keep their composer within the viewport");
    writeFileSync("/tmp/personbot-official-product-evidence-path.txt", evidenceDir);
  } finally {
    if (evidenceDir) {
      const bot = evidence.bot as { threadId: string } | undefined;
      if (fixture && bot) {
        try {
          evidence.finalPage = await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/messages?limit=200`).then(response => response.json());
          evidence.finalStatus = await fetch(`${fixture.info.url}/api/personbot/status`).then(response => response.json());
          evidence.finalNativeState = officialState(join(fixture.info.dataDir, "personbot"));
          const bindings = new DatabaseSync(join(fixture.info.dataDir, "personbot", "official-superagent", "bindings.sqlite"), { readOnly: true });
          try {
            evidence.finalBindings = bindings.prepare("SELECT * FROM bindings").all();
            evidence.finalRequests = bindings.prepare("SELECT * FROM requests").all();
            evidence.finalDeliveries = bindings.prepare("SELECT * FROM deliveries").all();
          } finally { bindings.close(); }
        } catch {}
      }
      if (browser && browserEnv) {
        try {
          evidence.finalSnapshot = await agentBrowser(browser.binary, browserEnv, ["snapshot", "-i"]);
          await agentBrowser(browser.binary, browserEnv, ["screenshot", join(evidenceDir, "final-app.png")]);
        } catch {}
      }
      writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
      if (fixture && existsSync(fixture.info.logPath)) writeFileSync(join(evidenceDir, "server.log"), readFileSync(fixture.info.logPath));
    }
    if (browser && browserEnv) await closeBrowserSession(browser.binary, browserEnv).catch(() => {});
    await preview?.close();
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM", graceMs: 20_000 }).catch(() => {});
    await fixture?.close();
  }
}, 300_000);
