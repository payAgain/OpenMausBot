import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { IntegrationSnapshot, TaskRecord, TaskSnapshot, TriggerRecord } from "../../packages/personbot-protocol/src/index.ts";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

function runtimePid(parentPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
}

(enabled ? it : it.skip)("uses authenticated events, schedules, subscriptions and explicit callback recovery through the isolated App", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let callback: Server | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let ownedPid: number | undefined;
  let evidenceDir: string | undefined;
  const callbacks: { payload: Record<string, unknown>; idempotencyKey?: string }[] = [];
  const evidence: Record<string, unknown> = { checks: [] };
  const checked = (name: string) => (evidence.checks as string[]).push(name);
  try {
    callback = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        callbacks.push({ payload: JSON.parse(body) as Record<string, unknown>, idempotencyKey: request.headers["idempotency-key"] as string | undefined });
        if (callbacks.length === 1) { response.destroy(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"received":true}');
      });
    });
    await new Promise<void>((resolve) => callback!.listen(0, "127.0.0.1", resolve));
    const callbackUrl = `http://127.0.0.1:${(callback.address() as { port: number }).port}/callback`;
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.personbot-events`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url);
    const rpc = <T = unknown>(method: string, params: object = {}) => api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    const integrations = () => rpc<IntegrationSnapshot>("personbot.v1.integrations.snapshot");
    const tasks = () => rpc<TaskSnapshot>("personbot.v1.tasks.list");
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots") as { bots: { id: string; defaultBot?: unknown }[] };
    for (const bot of bots.filter((bot) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__personbot-events.html", title: "Isolated Personbot events and channels", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-personbot-events-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const waitFor = async (code: string, expected: unknown = true, timeout = 30_000) => {
      await expect.poll(() => evaluate(code), { timeout, interval: 250 }).toEqual(expected);
    };
    const clickSelector = async (selector: string) => {
      await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center',inline:'nearest'});return true;})()`);
      await waitFor(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return top===e||e.contains(top);})()`);
      await run("click", selector);
    };
    const clickNamed = async (name: string) => {
      const selector = `[data-personbot-view] button`;
      await waitFor(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});return !!b&&!b.disabled;})()`);
      await evaluate(`(() => {document.querySelectorAll('[data-fixture-event-control]').forEach(b=>b.removeAttribute('data-fixture-event-control'));const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});b.setAttribute('data-fixture-event-control','target');return true;})()`);
      await clickSelector('[data-fixture-event-control="target"]');
    };
    const awaitTask = async (id: string, stage: TaskRecord["stage"]) => {
      await expect.poll(async () => (await tasks()).tasks.find((task) => task.id === id), { timeout: 30_000, interval: 250 }).toMatchObject({ stage, stopState: "confirmed" });
      return (await tasks()).tasks.find((task) => task.id === id)!;
    };
    await run("open", `${preview.previewUrl}#personbot`);
    await run("set", "viewport", "1440", "900");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await clickNamed("新会话");
    await waitFor(`Boolean(document.querySelector('textarea[aria-label="发消息给 Personbot"]'))`);
    const originSessionId = await evaluate<string>(`document.querySelector('select[aria-label="Personbot 会话"]').value`);
    ownedPid = runtimePid(server.info.pid);
    evidence.runtimePid = ownedPid;
    evidence.originSessionId = originSessionId;
    await clickSelector("[data-personbot-integrations] > summary");
    await clickNamed("添加来源");
    await run("fill", 'input[aria-label="来源名称"]', "Fixture event source");
    await run("fill", 'textarea[aria-label="新任务目标"]', "task-wait");
    await run("fill", 'textarea[aria-label="事件任务验收标准"]', "fixture:verified evidence\nHuman acceptance remains required");
    await run("fill", 'input[aria-label="结果回调地址"]', callbackUrl);
    expect(await evaluate(`document.querySelector('input[aria-label="启用事件来源"]').checked`)).toBe(false);
    await clickNamed("生成来源令牌");
    const token = await evaluate<string>(`document.querySelector('input[aria-label="本次来源令牌"]').value`);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await evaluate(`(() => {
      const original=window.fetch.bind(window);window.integrationRpcCalls=[];window.dropSource=true;
      window.fetch=async(input,init)=>{const body=String(input)==='/api/personbot/rpc'&&init?.body?JSON.parse(String(init.body)):null;
        const response=await original(input,init);if(body){const {token,...params}=body.params;window.integrationRpcCalls.push({method:body.method,params,hasToken:!!token,status:response.status});}
        if(response.ok&&body?.method==='personbot.v1.sources.put'&&window.dropSource){window.dropSource=false;return Response.json({error:'Fixture dropped accepted source response'},{status:503});}return response;};return true;
    })()`);
    await clickNamed("保存来源");
    await waitFor(`document.querySelector('[data-personbot-view]').innerText.includes('Fixture dropped accepted source response')`);
    await clickNamed("保存来源");
    await waitFor(`!document.querySelector('form[aria-label="事件来源设置"]')`);
    let source = (await integrations()).sources.find((entry) => entry.name === "Fixture event source")!;
    expect(source).toMatchObject({ enabled: false, originSessionId, callbackMode: "at-most-once" });
    const sourceCalls = await evaluate<Array<{ params: unknown; hasToken: boolean }>>(`window.integrationRpcCalls.filter(call=>call.method==='personbot.v1.sources.put')`);
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[0]!.params).toEqual(sourceCalls[1]!.params);
    expect(sourceCalls.every((call) => call.hasToken)).toBe(true);
    expect(await evaluate(`Boolean(document.querySelector('input[aria-label="本次来源令牌"]'))`)).toBe(false);
    expect(await evaluate(`Object.values(localStorage).some(value=>value.includes(${JSON.stringify(token)}))`)).toBe(false);
    expect(JSON.stringify(await integrations())).not.toContain(token);
    evidence.sourceCreateRetry = sourceCalls;
    checked("source starts disabled; cryptographic write-only token is cleared after save; an accepted response loss replays the same source and command");

    await clickNamed("编辑来源：Fixture event source");
    expect(await evaluate(`Boolean(document.querySelector('input[aria-label="本次来源令牌"]'))`)).toBe(false);
    await clickSelector('input[aria-label="启用事件来源"]');
    await clickNamed("保存来源");
    await waitFor(`!document.querySelector('form[aria-label="事件来源设置"]')`);
    source = (await integrations()).sources.find((entry) => entry.id === source.id)!;
    expect(source.enabled).toBe(true);
    expect(await evaluate(`window.integrationRpcCalls.filter(call=>call.method==='personbot.v1.sources.put').at(-1).hasToken`)).toBe(false);
    const ingest = async (eventId: string, text: string, threadId = "build-thread") => {
      const response = await fetch(`${server.info.url}/api/personbot/sources/${encodeURIComponent(source.id)}/events`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ eventId, threadId, text }),
      });
      expect(response.ok).toBe(true);
      return response.json() as Promise<{ trigger: TriggerRecord; duplicate: boolean }>;
    };
    const first = await ingest("event-one", "Fixture build completed; review its report.");
    expect(first.duplicate).toBe(false);
    await expect.poll(async () => (await integrations()).triggers.find((entry) => entry.id === first.trigger.id)?.taskIds.length, { timeout: 30_000 }).toBe(1);
    const taskId = (await integrations()).triggers.find((entry) => entry.id === first.trigger.id)!.taskIds[0]!;
    const waiting = await awaitTask(taskId, "waiting_event");
    const duplicate = await ingest("event-one", "Fixture build completed; review its report.");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.trigger.id).toBe(first.trigger.id);
    expect((await tasks()).tasks).toHaveLength(1);
    expect((await tasks()).executions).toHaveLength(1);
    await clickNamed("最近事件");
    await waitFor(`Boolean(document.querySelector('[data-personbot-trigger="${first.trigger.id}"]'))`);
    await clickNamed("查看事件任务：task-wait");
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, waiting.workerSessionId);
    await run("select", 'select[aria-label="Personbot 会话"]', originSessionId);
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, originSessionId);
    checked("authenticated webhook creates one durable task; duplicate replay creates neither a second task nor execution; event links open its native worker");

    await expect.poll(async () => (await integrations()).deliveries.find((entry) => entry.taskId === taskId)?.state, { timeout: 30_000 }).toBe("uncertain");
    const uncertain = (await integrations()).deliveries.find((entry) => entry.taskId === taskId)!;
    await clickNamed("回调回执");
    await waitFor(`document.querySelector('[data-personbot-delivery="${uncertain.id}"]')?.textContent.includes('送达情况不明确')`);
    await clickNamed("手动重试回调");
    expect(await evaluate(`document.querySelector('[data-personbot-delivery="${uncertain.id}"]').textContent.includes('再次发送可能产生重复结果')`)).toBe(true);
    expect(callbacks).toHaveLength(1);
    await run("screenshot", join(evidenceDir, "callback-uncertain-confirmation.png"));
    await clickNamed("确认重试，可能重复");
    await expect.poll(async () => (await integrations()).deliveries.find((entry) => entry.id === uncertain.id)?.state, { timeout: 30_000 }).toBe("delivered");
    expect(callbacks).toHaveLength(2);
    expect(callbacks[1]!.payload).toEqual(callbacks[0]!.payload);
    checked("ambiguous non-idempotent callback stops automatically; explicit duplicate-risk confirmation retries the same immutable payload");

    await clickNamed("订阅");
    await clickNamed("添加订阅");
    await run("fill", 'input[aria-label="订阅事件线程"]', "alias-thread");
    await run("select", 'select[aria-label="接收事件的任务"]', taskId);
    await clickNamed("保存订阅");
    await waitFor(`!document.querySelector('form[aria-label="事件订阅设置"]')`);
    expect((await integrations()).subscriptions.some((entry) => entry.threadId === "alias-thread" && entry.taskId === taskId && entry.enabled)).toBe(true);
    await ingest("event-two", "Alias thread supplies the final external evidence.", "alias-thread");
    const reviewed = await awaitTask(taskId, "awaiting_review");
    expect(reviewed.workerSessionId).toBe(waiting.workerSessionId);
    expect(reviewed.currentExecutionId).not.toBe(waiting.currentExecutionId);
    expect(reviewed.lifecycle).toBe("open");
    expect((await tasks()).tasks).toHaveLength(1);
    expect((await tasks()).executions).toHaveLength(2);
    checked("same-origin manual thread subscription wakes the existing waiting task in its persistent worker; report still waits for human acceptance");

    await clickNamed("定时");
    await clickNamed("添加定时");
    await run("fill", 'input[aria-label="定时名称"]', "Fixture one-shot");
    await run("fill", 'input[aria-label="定时事件线程"]', "scheduled-thread");
    await run("fill", 'textarea[aria-label="定时事件内容"]', "Gather evidence from the scheduled local fixture.");
    const initialLocal = await evaluate<string>(`document.querySelector('input[aria-label="首次执行时间"]').value`);
    const pastLocal = `${Number(initialLocal.slice(0, 4)) - 1}${initialLocal.slice(4)}`;
    await evaluate(`(() => {document.querySelector('input[aria-label="首次执行时间"]').scrollIntoView({block:'center',inline:'nearest'});return true;})()`);
    const dateControls = await run("snapshot", "-i");
    const yearControls = Object.entries(dateControls.refs as Record<string, { name?: string; role?: string }>)
      .filter(([, control]) => control.role === "spinbutton" && /年|year/i.test(control.name ?? ""));
    expect(yearControls).toHaveLength(1);
    await run("click", `@${yearControls[0]![0]}`);
    await run("press", "ArrowDown");
    await run("press", "Tab");
    await waitFor(`document.querySelector('input[aria-label="首次执行时间"]').value`, pastLocal);
    const expectedRunAt = await evaluate<string>(`new Date(${JSON.stringify(pastLocal)}).toISOString()`);
    expect(await evaluate(`document.querySelector('input[aria-label="启用事件定时"]').checked`)).toBe(false);
    await clickSelector('input[aria-label="启用事件定时"]');
    await clickNamed("保存定时");
    await waitFor(`!document.querySelector('form[aria-label="事件定时设置"]')`);
    expect(await evaluate<string>(`window.integrationRpcCalls.find(call=>call.method==='personbot.v1.schedules.put').params.runAt`)).toBe(expectedRunAt);
    await expect.poll(async () => (await integrations()).triggers.find((entry) => entry.threadId === "scheduled-thread")?.taskIds.length, { timeout: 30_000 }).toBe(1);
    const scheduleSnapshot = await integrations();
    const schedule = scheduleSnapshot.schedules.find((entry) => entry.name === "Fixture one-shot")!;
    expect(schedule).toMatchObject({ enabled: false });
    expect(schedule.nextRunAt).toBeUndefined();
    const scheduledTaskId = scheduleSnapshot.triggers.find((entry) => entry.threadId === "scheduled-thread")!.taskIds[0]!;
    await awaitTask(scheduledTaskId, "waiting_event");
    await expect.poll(async () => (await integrations()).deliveries.every((entry) => entry.state === "delivered"), { timeout: 30_000 }).toBe(true);
    checked("owner-created one-shot schedule produces a durable event and native task, then disables itself after firing");

    const beforeReload = await integrations();
    const beforeTasks = await tasks();
    await run("reload");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, originSessionId);
    expect(await integrations()).toEqual(beforeReload);
    expect((await tasks()).tasks).toEqual(beforeTasks.tasks);
    await clickSelector("[data-personbot-integrations] > summary");
    checked("reload restores sources, subscriptions, completed one-shot schedule, event receipts and callback decisions without duplicate work");

    const geometry: unknown[] = [];
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "900");
      await waitFor("innerWidth", width);
      if (width < 768) await expect.poll(() => evaluate<number>(`document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? 0`), { timeout: 10_000 }).toBeLessThanOrEqual(0);
      await clickNamed("来源");
      await evaluate(`(() => {document.querySelector('[aria-label="Personbot 对话"]').scrollTop=0;return true;})()`);
      const boundsCode = `(() => ({page:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('[data-personbot-view] input,[data-personbot-view] select,[data-personbot-view] textarea,[data-personbot-view] button')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};})}))()`;
      const listing = await evaluate<{ page: number; controls: { left: number; right: number }[] }>(boundsCode);
      expect(listing.page).toBeLessThanOrEqual(width);
      for (const control of listing.controls) { expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(width + 1); }
      await run("screenshot", join(evidenceDir, `personbot-events-${width}.png`));
      await clickNamed("定时");
      await clickNamed("添加定时");
      await run("fill", 'input[aria-label="重复间隔分钟"]', "2");
      await evaluate(`(() => {document.querySelector('form[aria-label="事件定时设置"]').scrollIntoView({block:'start',inline:'nearest'});return true;})()`);
      const form = await evaluate<{ page: number; controls: { left: number; right: number }[] }>(boundsCode);
      expect(form.page).toBeLessThanOrEqual(width);
      for (const control of form.controls) { expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(width + 1); }
      await run("screenshot", join(evidenceDir, `personbot-event-schedule-${width}.png`));
      geometry.push({ width, listing, form });
      await clickNamed("取消编辑");
    }
    evidence.geometry = geometry;
    evidence.integrations = await integrations();
    evidence.tasks = await tasks();
    evidence.callbacks = callbacks;
    evidence.console = await run("console");
    expect(((evidence.console as { messages?: { type?: string }[] }).messages ?? []).filter((message) => message.type === "error")).toEqual([]);
    checked("1440, 768 and 390 widths keep event listings, schedule forms and main composer within the viewport; console has no errors");
    expect(JSON.stringify(evidence)).not.toContain(token);
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    if (browser && browserEnv && evidenceDir) {
      await agentBrowser(browser.binary, browserEnv, ["eval", `(() => {document.querySelectorAll('[aria-label="本次来源令牌"]').forEach(e=>e.value='[REDACTED]');return true;})()`]).catch(() => {});
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
      if (callback) {
        callback.closeAllConnections();
        await new Promise<void>((resolve, reject) => callback!.close((error) => error ? reject(error) : resolve()));
      }
      if (ownedPid) await expect.poll(() => {
        try { process.kill(ownedPid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }, { timeout: 10_000 }).toBe(true);
      if (fixture) expect(existsSync(fixture.info.dataDir)).toBe(false);
      checked("owned fixture runtime/browser/server/callback service exited and disposable data was removed");
    } finally {
      if (evidenceDir) {
        writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(`Personbot Events App verification evidence: ${evidenceDir}`);
      }
    }
  }
}, 360_000);
