import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { PersonbotSetup } from "../../shared/personbot-product.ts";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

function ownedRuntimePid(parentPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
}

(enabled ? it : it.skip)("opens the finished primary product, continues archived work and keeps native task and chat controls usable", async () => {
  let fixture: VerificationServer | undefined;
  let restarted: ChildProcess | undefined;
  let preview: MountedPreview | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let runtimePid: number | undefined;
  let evidenceDir: string | undefined;
  const evidence: Record<string, unknown> = { checks: [] };
  const checked = (value: string) => (evidence.checks as string[]).push(value);
  try {
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    const api = fixtureApi(server.info.url, { headers: { origin: server.info.url } });
    evidenceDir = `${server.info.logPath}.personbot-product`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const old = (await api("POST", "/api/bots", {
      name: "Prior research", soul: "Check sources before giving a conclusion.",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    })).bot as { id: string; threadId: string };
    await api("POST", `/api/bots/${old.id}/messages`, { text: "Collected references for the personal research project.", threadId: old.threadId });
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === old.id)?.busy, { timeout: 20_000 }).toBe(false);
    await waitForExit(server.child, { signal: "SIGTERM", graceMs: 15_000 });
    const env = verificationServerEnvironment(process.env, server.info.dataDir, Number(new URL(server.info.url).port), true, true);
    const restartLog = `${server.info.logPath}.primary-ui.log`;
    const log = openSync(restartLog, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    evidence.restartedServerPid = restarted.pid;
    evidence.restartLog = restartLog;
    await expect.poll(async () => {
      try { return (await api("GET", "/api/personbot/setup") as PersonbotSetup).primary; }
      catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__personbot-product.html", title: "Personbot product verification", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    console.log(`Personbot Product preview: ${preview.previewUrl}`);
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-product-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const waitFor = (code: string, expected: unknown = true, timeout = 30_000) =>
      expect.poll(() => evaluate(code), { timeout, interval: 250 }).toEqual(expected);
    const clickNamed = async (name: string) => {
      let target = "";
      await expect.poll(async () => {
        const value = await run("snapshot", "-i");
        const refs = value.refs as Record<string, { name?: string; role?: string }> | undefined;
        const matches = Object.entries(refs ?? {}).filter(([, ref]) => ref.name === name && ref.role === "button");
        if (matches.length === 1) target = `@${matches[0]![0]}`;
        return matches.length;
      }, { timeout: 15_000 }).toBe(1);
      await run("click", target);
    };
    const navigate = async (page: string) => {
      if (await evaluate(`innerWidth <= 900`)) await clickNamed("打开 Personbot 导航");
      await run("click", `[data-personbot-nav="${page}"]`);
    };
    await run("open", preview.previewUrl);
    await waitFor(`!!document.querySelector('[data-personbot-product]')`);
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    expect(await evaluate(`!!document.querySelector('[data-sidebar-nav], [data-app-loading]')`)).toBe(false);
    checked("root App opens directly into Personbot primary shell without legacy providers, onboarding or engine UI");
    await clickNamed("新会话");
    await waitFor(`!!document.querySelector('textarea[aria-label="发消息给 Personbot"]')`);
    const sessionId = await evaluate<string>(`document.querySelector('select[aria-label="Personbot 会话"]').value`);
    evidence.sessionId = sessionId;
    const send = async (text: string) => { await run("fill", 'textarea[aria-label="发消息给 Personbot"]', text); await run("press", "Enter"); };
    await send("echo product-native-ready");
    await waitFor(`[...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].some(row=>row.textContent.includes('product-native-ready'))`);
    runtimePid = ownedRuntimePid(restarted.pid!);
    evidence.runtimePid = runtimePid;
    checked("new conversation and reply execute through the real native dsh fixture");

    await run("fill", 'textarea[aria-label="发消息给 Personbot"]', "echo retained-draft");
    await navigate("setup");
    await waitFor(`!!document.querySelector('[aria-label="Personbot 模型设置"]')`);
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.productCalls = [];
      window.productDropSettings = true;
      window.productDropImport = true;
      window.fetch = async (input, init) => {
        const path = String(input);
        const watched = init?.method === 'POST' && (path === '/api/personbot/setup' || /\\/legacy\\/threads\\/[^/]+\\/import$/.test(path));
        const body = watched ? JSON.parse(String(init.body)) : undefined;
        const response = await original(input, init);
        if (watched) window.productCalls.push({path,body,status:response.status});
        if (response.ok && watched && (path === '/api/personbot/setup' ? window.productDropSettings : window.productDropImport)) {
          if (path === '/api/personbot/setup') window.productDropSettings = false; else window.productDropImport = false;
          return Response.json({error:'Fixture dropped accepted response'}, {status:503});
        }
        return response;
      };
      return true;
    })()`);
    await clickNamed("保存模型设置");
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Fixture dropped accepted response')`);
    await clickNamed("保存模型设置");
    await waitFor(`[...document.querySelectorAll('[role="status"]')].some(row=>row.textContent.includes('已保存'))`);
    const settingsCalls = await evaluate<Array<{ body: object }>>(`window.productCalls.filter(call=>call.path === '/api/personbot/setup')`);
    expect(settingsCalls).toHaveLength(2);
    expect(settingsCalls[0]!.body).toEqual(settingsCalls[1]!.body);
    await navigate("chat");
    await waitFor(`document.querySelector('textarea[aria-label="发消息给 Personbot"]')?.value`, "echo retained-draft");
    await run("click", 'textarea[aria-label="发消息给 Personbot"]');
    await run("press", "Enter");
    await waitFor(`[...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].some(row=>row.textContent.includes('retained-draft'))`);
    checked("model settings replay the same accepted command after response loss; navigating settings keeps the original chat draft");

    await navigate("tasks");
    await clickNamed("新任务");
    await run("fill", 'textarea[aria-label="任务目标"]', "task-ready");
    await run("fill", 'textarea[aria-label="任务完成条件"]', "fixture:verified evidence");
    await clickNamed("创建并执行任务");
    await waitFor(`document.querySelector('[data-personbot-task-status]')?.textContent.includes('等待验收')`, true, 45_000);
    await clickNamed("查看任务会话");
    await waitFor(`document.querySelector('[data-personbot-section]')?.getAttribute('data-personbot-section')`, "chat");
    await waitFor(`!!document.querySelector('[data-personbot-task] button')`);
    await clickNamed("验收通过");
    await waitFor(`document.querySelector('[data-personbot-task-status]')?.textContent.includes('已验收完成')`);
    checked("long-running task creates an independent worker, navigation opens its native history and human acceptance remains explicit");
    await navigate("integrations");
    await waitFor(`!!document.querySelector('[data-personbot-integrations][open]')`);
    await clickNamed("定时");
    await navigate("personal");
    await waitFor(`!!document.querySelector('[data-personbot-personal][open]')`);
    await clickNamed("记忆");
    await clickNamed("添加记忆");
    await run("fill", 'input[aria-label="记忆名称"]', "Report language");
    await run("fill", 'textarea[aria-label="记忆内容"]', "Use Chinese for project reports.");
    await clickNamed("保存记忆");
    await waitFor(`document.querySelector('[data-personbot-memory]')?.textContent.includes('Use Chinese for project reports.')`);
    checked("projects, memory and event management open in dedicated work areas rather than above every chat");

    await navigate("legacy");
    await waitFor(`!!document.querySelector('[data-personbot-legacy-thread="${old.threadId}"]')`);
    await run("click", `[data-personbot-legacy-thread="${old.threadId}"]`);
    await waitFor(`document.querySelector('[data-personbot-legacy-messages]')?.textContent.includes('Collected references')`);
    await clickNamed("导入并继续");
    await run("fill", 'textarea[aria-label="导入后的目标"]', "Review the collected research evidence.");
    await run("fill", 'textarea[aria-label="已确认的进展"]', "References are collected; verify the claims before any external action.");
    await clickNamed("创建 dsh 会话并继续");
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Fixture dropped accepted response')`);
    await clickNamed("创建 dsh 会话并继续");
    await waitFor(`document.querySelector('[data-personbot-section]')?.getAttribute('data-personbot-section')`, "chat");
    await waitFor(`[...document.querySelectorAll('[data-personbot-message][data-role="user"]')].some(row=>row.textContent.includes('References are collected'))`);
    const importCalls = await evaluate<Array<{ body: object }>>(`window.productCalls.filter(call=>call.path.endsWith('/import'))`);
    expect(importCalls).toHaveLength(2);
    expect(importCalls[0]!.body).toEqual(importCalls[1]!.body);
    evidence.importCommands = importCalls;
    checked("read-only archived conversation imports confirmed goal/progress once, including accepted response loss and retry");
    await run("select", 'select[aria-label="Personbot 会话"]', sessionId);
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, sessionId);
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "900");
      await navigate("chat");
      await waitFor(`document.querySelector('[data-personbot-section]')?.getAttribute('data-personbot-section')`, "chat");
      const layout = await evaluate<{ page: number; controls: Array<{ left: number; right: number }> }>(`(() => ({
        page: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('[data-personbot-product] button, [data-personbot-product] select, [data-personbot-product] textarea')].filter(el=>el.getClientRects().length).map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))
      }))()`);
      expect(layout.page).toBeLessThanOrEqual(width + 1);
      expect(layout.controls.every((box) => box.left >= -1 && box.right <= width + 1)).toBe(true);
      await run("screenshot", join(evidenceDir, `personbot-product-${width}.png`));
      await navigate("setup");
      await run("screenshot", join(evidenceDir, `personbot-model-settings-${width}.png`));
      (evidence.layouts ??= [] as unknown[]);
      (evidence.layouts as unknown[]).push({ width, layout });
    }
    await run("reload");
    await waitFor(`!!document.querySelector('[aria-label="Personbot 模型设置"]')`);
    await navigate("chat");
    await waitFor(`[...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].some(row=>row.textContent.includes('retained-draft'))`);
    evidence.console = await run("console");
    expect(((evidence.console as { messages?: Array<{ type?: string }> }).messages ?? []).filter((message) => message.type === "error")).toEqual([]);
    checked("responsive primary shell and settings pass1440/768/390, refresh recovers native history and browser console has0errors");
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    if (browser && browserEnv && evidenceDir) {
      await agentBrowser(browser.binary, browserEnv, ["screenshot", join(evidenceDir, "failure.png")]).catch(() => {});
      evidence.failureSnapshot = await agentBrowser(browser.binary, browserEnv, ["snapshot"]).catch(() => null);
      evidence.console = await agentBrowser(browser.binary, browserEnv, ["console"]).catch(() => null);
    }
    throw error;
  } finally {
    if (browser && browserEnv) await closeBrowserSession(browser.binary, browserEnv);
    await preview?.close();
    await waitForExit(restarted, { signal: "SIGTERM", graceMs: 15_000 });
    await fixture?.close();
    if (runtimePid) await expect.poll(() => {
      try { process.kill(runtimePid!, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }, { timeout: 10_000 }).toBe(true);
    if (fixture) {
      evidence.temporaryDataRemoved = !existsSync(fixture.info.dataDir);
      expect(evidence.temporaryDataRemoved).toBe(true);
    }
    checked("owned browser, old and primary servers, dsh runtime exited; disposable data removed");
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Personbot Product App verification evidence: ${evidenceDir}`);
    }
  }
}, 360_000);
