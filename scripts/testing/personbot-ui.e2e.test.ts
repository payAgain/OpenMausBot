import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot } from "../../packages/personbot-projection/src/index.ts";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping Personbot UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

describe("the isolated Personbot fixture environment", () => {
  const ambient = {
    PERSONBOT_ENABLED: "1", PERSONBOT_FIXTURE: "1", PERSONBOT_HOME: "/personal/home",
    PERSONBOT_WORKSPACE: "/personal/workspace", PERSONBOT_PROVIDER: "live-provider",
    PERSONBOT_MODEL: "live-model", DSH_HOME: "/personal/dsh", DEEPSEEK_API_KEY: "personal-key",
  };
  const dataDir = join("/tmp", "omb-personbot-environment");

  it("disables Personbot unless a programmatic fixture explicitly enables it", () => {
    const env = verificationServerEnvironment(ambient, dataDir, 9100);
    expect(env.PERSONBOT_ENABLED).toBe("0");
    for (const key of Object.keys(ambient).filter(key => key !== "PERSONBOT_ENABLED")) expect(env).not.toHaveProperty(key);
    expect(verificationServerEnvironment(ambient, dataDir, 9100, "1" as unknown as boolean).PERSONBOT_ENABLED).toBe("0");
  });

  it("pins the fake model and confines both runtime data and work to the disposable home", () => {
    const env = verificationServerEnvironment(ambient, dataDir, 9100, true);
    expect(env).toMatchObject({
      HOME: dataDir, PERSONBOT_ENABLED: "1", PERSONBOT_FIXTURE: "1",
      PERSONBOT_HOME: join(dataDir, "personbot"), PERSONBOT_WORKSPACE: join(dataDir, "personbot-workspace"),
      PERSONBOT_PROVIDER: "personbot-fixture", PERSONBOT_MODEL: "fixture", OMB_TEST_SEALED_PATH: "1",
    });
    expect(env).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(env).not.toHaveProperty("DSH_HOME");
  });
});

function ownedRuntimePid(parentPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  for (const line of processes.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
}

(enabled ? it : it.skip)("uses the App entry for native dsh chat, decisions, stop, recovery and responsive layouts", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let runtimePid: number | undefined;
  let evidenceDir: string | undefined;
  const evidence: Record<string, unknown> = { checks: [] };
  const checked = (name: string) => (evidence.checks as string[]).push(name);
  try {
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.personbot`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url);
    const rpc = <T = unknown>(method: string, params: object = {}) =>
      api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    expect(await api("GET", "/api/personbot/status")).toMatchObject({
      enabled: true, state: "stopped", provider: "personbot-fixture", model: "fixture",
      workspace: join(server.info.dataDir, "personbot-workspace"),
    });
    checked("status reads do not launch dsh");
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; defaultBot?: unknown }> };
    for (const bot of bots.filter(bot => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__personbot.html",
      title: "Isolated Personbot verification", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-personbot-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const waitFor = async (code: string, expected: unknown = true, timeout = 30_000) => {
      await expect.poll(() => evaluate(code), { timeout, interval: 250 }).toEqual(expected);
    };
    const clickNamed = async (name: string, role = "button") => {
      let target: string | undefined;
      await expect.poll(async () => {
        const snapshot = await run("snapshot", "-i");
        const refs = snapshot.refs as Record<string, { name?: string; role?: string }> | undefined;
        const matches = Object.entries(refs ?? {}).filter(([, ref]) => ref.name === name && ref.role === role);
        if (matches.length === 1) target = `@${matches[0]![0]}`;
        return matches.length;
      }, { timeout: 15_000, interval: 250 }).toBe(1);
      await run("click", target!);
    };
    const transcript = () => evaluate<Array<{ id: string; role: string | null; text: string }>>(
      `[...document.querySelectorAll('[data-personbot-message]')].map(row => ({id:row.getAttribute('data-personbot-message'),role:row.getAttribute('data-role'),text:row.innerText}))`,
    );
    const idle = () => waitFor(`!document.querySelector('[aria-label="Personbot 执行状态"]')?.textContent.includes('执行中') && !document.querySelector('[data-personbot-approval], [data-personbot-question]')`);
    const send = async (text: string) => {
      await run("fill", 'textarea[aria-label="发消息给 Personbot"]', text);
      await run("press", "Enter");
    };
    await run("open", preview.previewUrl);
    await waitFor(`Boolean(document.querySelector('[data-sidebar-nav="personbot"]'))`);
    await run("click", '[data-sidebar-nav="personbot"]');
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await clickNamed("新会话");
    await waitFor(`Boolean(document.querySelector('textarea[aria-label="发消息给 Personbot"]'))`);
    const sessionId = await evaluate<string>(`document.querySelector('select[aria-label="Personbot 会话"]').value`);
    expect(sessionId).toMatch(/^[\w-]+$/);
    evidence.sessionId = sessionId;
    const snapshot = () => rpc<RuntimeSnapshot>("personbot.v1.snapshots.get", { sessionId, fromSeq: 0, limit: 1000 });
    runtimePid = ownedRuntimePid(server.info.pid);
    if (process.platform !== "win32") expect(runtimePid).toBeGreaterThan(1);
    evidence.runtimePid = runtimePid;
    checked("visible App entry creates a native dsh session");

    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.personbotRpcCalls = [];
      window.personbotDropOnce = true;
      window.fetch = async (input, init) => {
        const body = String(input) === '/api/personbot/rpc' && init?.body ? JSON.parse(String(init.body)) : null;
        const response = await original(input, init);
        if (body) window.personbotRpcCalls.push({...body,status:response.status});
        if (body?.method === 'personbot.v1.messages.submit' && window.personbotDropOnce) {
          window.personbotDropOnce = false;
          return Response.json({error:'Fixture dropped the accepted send response'}, {status:503});
        }
        return response;
      };
      return true;
    })()`);
    const echo = "w2-browser-echo";
    await send(`echo ${echo}`);
    await waitFor(`document.querySelector('textarea[aria-label="发消息给 Personbot"]')?.value`, `echo ${echo}`);
    await waitFor(`document.querySelector('[data-personbot-view]')?.innerText.includes('Fixture dropped the accepted send response')`);
    await clickNamed("发送给 Personbot");
    await waitFor(`document.querySelector('textarea[aria-label="发消息给 Personbot"]')?.value`, "");
    await expect.poll(async () => (await transcript()).filter(row => row.role === "assistant" && row.text.includes(echo)).length, { timeout: 30_000 }).toBe(1);
    await idle();
    const sendCalls = await evaluate<Array<{ params: Record<string, unknown> }>>(
      `window.personbotRpcCalls.filter(call => call.method === 'personbot.v1.messages.submit')`,
    );
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]!.params).toEqual(sendCalls[1]!.params);
    expect((await transcript()).filter(row => row.role === "user" && row.text.includes(echo))).toHaveLength(1);
    checked("a lost accepted send response retries the same IDs without duplicate user or assistant rows");

    const deniedPath = join(server.info.dataDir, "personbot-workspace", "denied.txt");
    await send("approve denied.txt");
    await waitFor(`Boolean(document.querySelector('[data-personbot-approval]'))`);
    expect(existsSync(deniedPath)).toBe(false);
    await run("screenshot", join(evidenceDir, "approval-pending.png"));
    await clickNamed("拒绝");
    await idle();
    expect(existsSync(deniedPath)).toBe(false);
    checked("rejecting an approval prevents the fixture file effect");

    const approvedPath = join(server.info.dataDir, "personbot-workspace", "approved.txt");
    await send("approve approved.txt");
    await waitFor(`Boolean(document.querySelector('[data-personbot-approval]'))`);
    expect(existsSync(approvedPath)).toBe(false);
    await clickNamed("允许一次");
    await expect.poll(() => existsSync(approvedPath), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(approvedPath, "utf8")).toBe("approved by personbot fixture\n");
    await idle();
    await evaluate(`[...document.querySelectorAll('[data-personbot-tool]')].forEach(tool => {tool.open=true;}); true`);
    await waitFor(`document.querySelector('[data-personbot-view]')?.innerText.includes('"written":true') || document.querySelector('[data-personbot-view]')?.innerText.includes('"written": true')`);
    checked("allow once executes the native tool and renders correlated arguments and result");

    await send("question");
    await waitFor(`Boolean(document.querySelector('[data-personbot-question]'))`);
    await clickNamed("Markdown", "radio");
    await clickNamed("提交回答");
    await idle();
    await expect.poll(async () => {
      const current = await snapshot();
      return current.logs.flatMap(log => log.events).some(event => event.type === "tool/result" && JSON.stringify(event.data).includes("Markdown"));
    }, { timeout: 30_000 }).toBe(true);
    checked("native user questions accept the selected answer and clear the pending card");

    await send("hold");
    await waitFor(`document.querySelector('[aria-label="Personbot 执行状态"]')?.textContent.includes('执行中')`);
    await clickNamed("停止 Personbot 当前会话");
    await idle();
    await waitFor(`document.querySelector('[aria-label="Personbot 执行状态"]')?.textContent.includes('已停止')`);
    checked("Stop confirms cancellation of the selected native session");
    const beforeReload = await transcript();
    const durable = await snapshot();
    expect(durable.pending).toEqual([]);
    expect(durable.sessions[0]?.status).toBe("closed");
    expect(new Set(beforeReload.map(row => row.id)).size).toBe(beforeReload.length);
    evidence.snapshot = durable;
    evidence.rpcCalls = await evaluate("window.personbotRpcCalls");
    evidence.transcriptBeforeReload = beforeReload;
    await run("reload");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await expect.poll(transcript, { timeout: 30_000 }).toEqual(beforeReload);
    checked("reload restores the native transcript with no duplicate rows or expired pending decisions");

    if (runtimePid) {
      expect(ownedRuntimePid(server.info.pid)).toBe(runtimePid);
      process.kill(runtimePid, "SIGKILL");
      await expect.poll(async () => {
        try { return (await snapshot()).generation !== durable.generation; }
        catch { return false; }
      }, { timeout: 30_000, interval: 250 }).toBe(true);
      await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
      await expect.poll(transcript, { timeout: 30_000 }).toEqual(beforeReload);
      runtimePid = ownedRuntimePid(server.info.pid);
      expect(runtimePid).toBeGreaterThan(1);
      evidence.restartedRuntimePid = runtimePid;
      await send("echo after-runtime-restart");
      await expect.poll(async () => (await transcript()).filter(row => row.role === "assistant" && row.text.includes("after-runtime-restart")).length,
        { timeout: 30_000 }).toBe(1);
      await idle();
      checked("owned runtime crash reconnects to the same native history and accepts one new turn");
    }

    const geometry: unknown[] = [];
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "900");
      await waitFor("innerWidth", width);
      await waitFor(`(() => {const el=document.querySelector('[aria-label="Personbot 对话"]');return el.scrollHeight-el.scrollTop-el.clientHeight<3;})()`);
      if (width < 768) {
        await expect.poll(() => evaluate<number>(`document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? 0`),
          { timeout: 10_000, interval: 100 }).toBeLessThanOrEqual(0);
        expect(await evaluate<boolean>(`document.querySelector('[data-personbot-view] h1').getBoundingClientRect().left >= document.querySelector('button[aria-label="Open bot list"]').getBoundingClientRect().right + 4`)).toBe(true);
      }
      const layout = await evaluate<{ width: number; page: number; view: { left: number; right: number }; composer: { left: number; right: number }; send: { left: number; right: number } }>(`(() => {
        const bounds = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right};};
        return {width:innerWidth,page:document.documentElement.scrollWidth,view:bounds('[data-personbot-view]'),
          composer:bounds('textarea[aria-label="发消息给 Personbot"]'),send:bounds('button[aria-label="发送给 Personbot"]')};
      })()`);
      expect(layout.page).toBeLessThanOrEqual(width);
      for (const element of [layout.view, layout.composer, layout.send]) {
        expect(element.left).toBeGreaterThanOrEqual(-1);
        expect(element.right).toBeLessThanOrEqual(width + 1);
      }
      geometry.push(layout);
      await run("screenshot", join(evidenceDir, `personbot-${width}.png`));
    }
    evidence.geometry = geometry;
    await api("PATCH", "/api/config", { onboarding: { completedAt: "", version: 0 } });
    await evaluate(`localStorage.removeItem("omb-email-gate")`);
    await run("open", `${preview.previewUrl}?onboarding=1#personbot`);
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    expect(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`)).toBe(false);
    expect(await evaluate(`document.querySelector('select[aria-label="Personbot 会话"]').value`)).toBe(sessionId);
    checked("native entry remains usable before legacy engine onboarding is completed");
    const consoleResult = await run("console");
    const errors = (consoleResult.messages as Array<{ type?: string }> | undefined ?? []).filter(message => message.type === "error");
    evidence.console = consoleResult;
    expect(errors).toEqual([]);
    checked("desktop, tablet and phone layouts keep the transcript and controls inside the viewport");
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    if (browser && browserEnv && evidenceDir) {
      await agentBrowser(browser.binary, browserEnv, ["screenshot", join(evidenceDir, "failure.png")]).catch(() => {});
      evidence.failureSnapshot = await agentBrowser(browser.binary, browserEnv, ["snapshot"]).catch(() => null);
      evidence.console = await agentBrowser(browser.binary, browserEnv, ["console"]).catch(() => null);
    }
    throw error;
  } finally {
    try {
      if (browser && browserEnv) await closeBrowserSession(browser.binary, browserEnv);
      await preview?.close();
      await fixture?.close();
      if (runtimePid) {
        await expect.poll(() => {
          try { process.kill(runtimePid!, 0); return false; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }, { timeout: 10_000 }).toBe(true);
        checked("fixture shutdown also terminates its owned dsh child");
      }
    } finally {
      if (evidenceDir) {
        writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(`Personbot App verification evidence: ${evidenceDir}`);
      }
    }
  }
}, 360_000);
