import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { TaskRecord, TaskSnapshot } from "../../packages/personbot-protocol/src/index.ts";
import type { RuntimeSnapshot } from "../../packages/personbot-projection/src/index.ts";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

function runtimePid(parentPid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  for (const line of processes.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!)) return Number(match[1]);
  }
  return undefined;
}

(enabled ? it : it.skip)("runs persistent supervised tasks through the isolated App while keeping main chat available", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let ownedPid: number | undefined;
  let evidenceDir: string | undefined;
  const evidence: Record<string, unknown> = { checks: [] };
  const checked = (name: string) => (evidence.checks as string[]).push(name);
  try {
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, undefined, [], undefined, undefined, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.personbot-tasks`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url);
    const rpc = <T = unknown>(method: string, params: object = {}) => api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    const tasks = () => rpc<TaskSnapshot>("personbot.v1.tasks.list");
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots") as { bots: { id: string; defaultBot?: unknown }[] };
    for (const bot of bots.filter((bot) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__personbot-tasks.html", title: "Isolated Personbot task supervision", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-personbot-tasks-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const waitFor = async (code: string, expected: unknown = true, timeout = 30_000) => {
      await expect.poll(() => evaluate(code), { timeout, interval: 250 }).toEqual(expected);
    };
    const clickNamed = async (name: string, role = "button") => {
      let ref: string | undefined;
      await expect.poll(async () => {
        const snapshot = await run("snapshot", "-i");
        const matches = Object.entries(snapshot.refs as Record<string, { name?: string; role?: string }> ?? {})
          .filter(([, value]) => value.name === name && value.role === role);
        if (matches.length === 1) ref = `@${matches[0]![0]}`;
        return matches.length;
      }, { timeout: 15_000, interval: 250 }).toBe(1);
      if (role === "button") await evaluate(`(() => {
        const buttons=[...document.querySelectorAll('button')].filter(button=>button.getAttribute('aria-label')===${JSON.stringify(name)}||button.textContent.trim()===${JSON.stringify(name)});
        if(buttons.length===1)buttons[0].scrollIntoView({block:'center',inline:'nearest'});return true;
      })()`);
      await run("click", ref!);
    };
    const clickTask = async (taskId: string, name: string) => {
      const selector = `[data-personbot-task="${taskId}"]`;
      await evaluate(`(() => {
        const card=document.querySelector(${JSON.stringify(selector)});if(!card)throw Error('Task card missing');card.open=true;
        const buttons=[...card.querySelectorAll('button')].filter(button=>button.textContent.trim()===${JSON.stringify(name)});
        if(buttons.length!==1)throw Error('Task control missing or ambiguous: '+${JSON.stringify(name)});
        document.querySelectorAll('[data-fixture-task-control]').forEach(button=>button.removeAttribute('data-fixture-task-control'));
        buttons[0].setAttribute('data-fixture-task-control','target');
        buttons[0].scrollIntoView({block:'center',inline:'nearest'});return true;
      })()`);
      await waitFor(`(() => {const button=document.querySelector('[data-fixture-task-control="target"]');if(button.disabled)return false;const r=button.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return top===button||button.contains(top);})()`);
      await run("click", '[data-fixture-task-control="target"]');
    };
    const readTask = async (id: string) => (await tasks()).tasks.find((task) => task.id === id);
    const awaitTask = async (id: string, stage: TaskRecord["stage"]) => {
      await expect.poll(async () => (await readTask(id))?.stage, { timeout: 30_000, interval: 250 }).toBe(stage);
      if (["paused", "waiting_event", "awaiting_review"].includes(stage)) {
        await expect.poll(async () => (await readTask(id))?.stopState, { timeout: 30_000, interval: 250 }).toBe("confirmed");
      }
      await waitFor(`document.querySelector('[data-personbot-task-status="${id}"]')?.textContent.includes(${JSON.stringify({
        queued: "等待执行", working: "执行中", waiting_event: "等待唤醒", waiting_person: "等待你的决定", awaiting_review: "等待验收", paused: "已暂停", blocked: "需要核对", failed: "执行失败",
      }[stage])})`);
    };
    const createTask = async (goal: string, retry = false) => {
      await clickNamed("新任务");
      await run("fill", 'textarea[aria-label="任务目标"]', goal);
      await run("fill", 'textarea[aria-label="任务完成条件"]', "提供隔离验收证据\n提交结构化报告");
      await run("fill", 'textarea[aria-label="任务上下文"]', "仅使用当前 fixture 的临时目录，不访问个人数据。");
      await clickNamed("创建并执行任务");
      if (retry) {
        await waitFor(`document.querySelector('[data-personbot-view]')?.innerText.includes('Fixture dropped accepted task response')`);
        await clickNamed("创建并执行任务");
      }
      await waitFor(`!document.querySelector('form[aria-label="创建长期任务"]')`);
      let id = "";
      await expect.poll(async () => {
        const matches = (await tasks()).tasks.filter((task) => task.goal === goal);
        if (matches.length === 1) id = matches[0]!.id;
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await waitFor(`Boolean(document.querySelector('[data-personbot-task="${id}"]'))`);
      return id;
    };
    await run("open", `${preview.previewUrl}#personbot`);
    await run("set", "viewport", "1440", "900");
    await waitFor("innerWidth", 1440);
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await clickNamed("新会话");
    await waitFor(`Boolean(document.querySelector('textarea[aria-label="发消息给 Personbot"]'))`);
    const originSessionId = await evaluate<string>(`document.querySelector('select[aria-label="Personbot 会话"]').value`);
    ownedPid = runtimePid(server.info.pid);
    evidence.originSessionId = originSessionId;
    evidence.runtimePid = ownedPid;
    await evaluate(`(() => {
      const original=window.fetch.bind(window);window.taskRpcCalls=[];window.dropTaskCreate=true;window.dropTaskAccept=false;
      window.fetch=async(input,init)=>{
        const body=String(input)==='/api/personbot/rpc'&&init?.body?JSON.parse(String(init.body)):null;
        const response=await original(input,init);if(body)window.taskRpcCalls.push({...body,status:response.status});
        if(response.ok&&body?.method==='personbot.v1.tasks.create'&&window.dropTaskCreate){window.dropTaskCreate=false;return Response.json({error:'Fixture dropped accepted task response'},{status:503});}
        if(response.ok&&body?.method==='personbot.v1.tasks.control'&&body.params.action==='accept'&&window.dropTaskAccept){window.dropTaskAccept=false;return Response.json({error:'Fixture dropped accepted control response'},{status:503});}
        return response;
      };return true;
    })()`);

    const holdId = await createTask("task-hold", true);
    await awaitTask(holdId, "working");
    const holding = (await readTask(holdId))!;
    await run("fill", 'textarea[aria-label="发消息给 Personbot"]', "echo main-chat-during-task");
    await run("press", "Enter");
    await waitFor(`Boolean([...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].find(row=>row.textContent.includes('main-chat-during-task')))`);
    await waitFor(`document.querySelector('[aria-label="Personbot 执行状态"]')?.textContent.includes('等待输入')`);
    expect((await readTask(holdId))?.stage).toBe("working");
    const createCalls = await evaluate<Array<{ params: unknown }>>(`window.taskRpcCalls.filter(call=>call.method==='personbot.v1.tasks.create')`);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]!.params).toEqual(createCalls[0]!.params);
    evidence.createRetry = createCalls;
    checked("lost accepted task creation retries the same identities; main chat responds while independent worker runs");

    await clickTask(holdId, "查看任务会话");
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, holding.workerSessionId);
    expect(await evaluate(`Boolean(document.querySelector('textarea[aria-label="发消息给 Personbot"]'))`)).toBe(false);
    expect(await evaluate(`Boolean(document.querySelector('button[aria-label="停止 Personbot 当前会话"]'))`)).toBe(false);
    await clickTask(holdId, "暂停任务");
    await awaitTask(holdId, "paused");
    await expect.poll(async () => (await tasks()).executions.find((entry) => entry.id === holding.currentExecutionId)?.status, { timeout: 30_000 }).toBe("ended");
    await clickTask(holdId, "继续任务");
    await awaitTask(holdId, "working");
    const resumed = (await readTask(holdId))!;
    expect(resumed.workerSessionId).toBe(holding.workerSessionId);
    expect(resumed.currentExecutionId).not.toBe(holding.currentExecutionId);
    const workerLog = await rpc<RuntimeSnapshot>("personbot.v1.snapshots.get", { sessionId: resumed.workerSessionId, fromSeq: 0, limit: 1000 });
    expect(workerLog.logs[0]!.events.filter((event) => event.type === "user/message"
      && (event.data as { source?: { kind?: string } }).source?.kind === "user"
      && JSON.stringify(event.data).includes("PERSONBOT_TASK=")).length).toBe(2);
    evidence.pauseResume = {
      sessionId: resumed.workerSessionId, firstExecutionId: holding.currentExecutionId,
      resumedExecutionId: resumed.currentExecutionId, history: workerLog.logs[0],
    };
    await clickTask(holdId, "终止任务");
    await expect.poll(async () => (await readTask(holdId))?.lifecycle, { timeout: 30_000 }).toBe("cancelled");
    await clickTask(holdId, "返回来源会话");
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, originSessionId);
    checked("worker view prevents bypass; pause/resume creates a new execution in the same native context; termination persists");

    const reviewId = await createTask("task-review");
    await awaitTask(reviewId, "awaiting_review");
    const review = (await readTask(reviewId))!;
    expect(review.lifecycle).toBe("open");
    expect(review.report?.evidence).toEqual(["fixture:verified"]);
    await run("set", "viewport", "1440", "1100");
    await waitFor("innerHeight", 1100);
    await evaluate(`(() => {const card=document.querySelector('[data-personbot-task="${reviewId}"]');card.open=true;card.scrollIntoView({block:'start',inline:'nearest'});return true;})()`);
    await run("screenshot", join(evidenceDir, "task-awaiting-review.png"));
    await evaluate("window.dropTaskAccept=true");
    await clickTask(reviewId, "验收通过");
    await waitFor(`document.querySelector('[data-personbot-view]')?.innerText.includes('Fixture dropped accepted control response')`);
    await expect.poll(async () => (await readTask(reviewId))?.lifecycle, { timeout: 30_000 }).toBe("completed");
    checked("structured worker report only requests review; explicit human acceptance completes the task even if its response is lost");

    const questionId = await createTask("task-question");
    await awaitTask(questionId, "waiting_person");
    await clickTask(questionId, "查看任务会话");
    await waitFor(`Boolean(document.querySelector('[data-personbot-question]'))`);
    await clickNamed("Markdown", "radio");
    await clickNamed("提交回答");
    await awaitTask(questionId, "awaiting_review");
    await clickTask(questionId, "返回来源会话");
    checked("independent worker questions are answered through native decision cards and resume the report path");

    const waitId = await createTask("task-wait");
    await awaitTask(waitId, "waiting_event");
    const waiting = (await readTask(waitId))!;
    await clickTask(waitId, "继续任务");
    await awaitTask(waitId, "awaiting_review");
    const continued = (await readTask(waitId))!;
    expect(continued.workerSessionId).toBe(waiting.workerSessionId);
    expect(continued.currentExecutionId).not.toBe(waiting.currentExecutionId);
    await expect.poll(async () => (await tasks()).updates.every((update) => update.delivered), { timeout: 30_000 }).toBe(true);
    checked("event waiting yields without a model polling loop; explicit continuation reuses worker history and durable outbox receipts settle");
    const sourceBeforeInput = await rpc<RuntimeSnapshot>("personbot.v1.snapshots.get", { sessionId: originSessionId, fromSeq: 0, limit: 1000 });
    expect(sourceBeforeInput.logs[0]!.events.filter((event) => event.type === "user/message"
      && (event.data as { source?: { kind?: string } }).source?.kind === "personbot-supervisor")).toEqual([]);
    await run("fill", 'textarea[aria-label="发消息给 Personbot"]', "echo task-results-delivered");
    await run("press", "Enter");
    await waitFor(`Boolean([...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].find(row=>row.textContent.includes('task-results-delivered')))`);
    await waitFor(`document.querySelectorAll('[data-personbot-notice="personbot-task-result"]').length > 0`);
    checked("outbox leaves the main model asleep; the next human input consumes attributed result notices visible in the source transcript");
    const beforeReload = await tasks();
    evidence.rpcCallsBeforeReload = await evaluate("window.taskRpcCalls");
    await run("reload");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await waitFor(`document.querySelectorAll('[data-personbot-task]').length`, beforeReload.tasks.length);
    expect((await tasks()).tasks).toEqual(beforeReload.tasks);
    checked("reload restores task status, executions, reports and result delivery receipts");

    const geometry: unknown[] = [];
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "900");
      await waitFor("innerWidth", width);
      if (width < 768) {
        await expect.poll(() => evaluate<number>(`document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? 0`),
          { timeout: 10_000, interval: 100 }).toBeLessThanOrEqual(0);
        expect(await evaluate<boolean>(`document.querySelector('[data-personbot-view] h1').getBoundingClientRect().left >= document.querySelector('button[aria-label="Open bot list"]').getBoundingClientRect().right + 4`)).toBe(true);
      }
      await evaluate(`(() => {document.querySelectorAll('[data-personbot-task]').forEach(card=>card.open=true);document.querySelector('[aria-label="Personbot 对话"]').scrollTop=0;return true;})()`);
      const layout = await evaluate<{ width: number; page: number; view: { left: number; right: number }; composer: { left: number; right: number }; tasks: { left: number; right: number }; buttons: { left: number; right: number }[] }>(`(() => {
        const bounds=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};};
        return {width:innerWidth,page:document.documentElement.scrollWidth,view:bounds(document.querySelector('[data-personbot-view]')),
          composer:bounds(document.querySelector('textarea[aria-label="发消息给 Personbot"]')),tasks:bounds(document.querySelector('[aria-label="Personbot 长期任务"]')),
          buttons:[...document.querySelectorAll('[data-personbot-task] button')].map(bounds)};
      })()`);
      expect(layout.page).toBeLessThanOrEqual(width);
      for (const element of [layout.view, layout.composer, layout.tasks, ...layout.buttons]) {
        expect(element.left).toBeGreaterThanOrEqual(-1);
        expect(element.right).toBeLessThanOrEqual(width + 1);
      }
      geometry.push(layout);
      await run("screenshot", join(evidenceDir, `personbot-tasks-${width}.png`));
    }
    evidence.geometry = geometry;
    evidence.snapshot = await tasks();
    evidence.rpcCalls = await evaluate("window.taskRpcCalls ?? []");
    evidence.console = await run("console");
    const errors = ((evidence.console as { messages?: { type?: string }[] }).messages ?? []).filter((entry) => entry.type === "error");
    expect(errors).toEqual([]);
    checked("desktop, tablet and phone keep task controls inside the viewport and the main composer usable with four tasks");
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
      if (ownedPid) await expect.poll(() => {
        try { process.kill(ownedPid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }, { timeout: 10_000 }).toBe(true);
      if (fixture) expect(existsSync(fixture.info.dataDir)).toBe(false);
      checked("fixture browser/server/runtime exited and disposable data was removed");
    } finally {
      if (evidenceDir) {
        writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(`Personbot Task App verification evidence: ${evidenceDir}`);
      }
    }
  }
}, 360_000);
