import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ArtifactSnapshot, PersonalSnapshot, TaskRecord, TaskSnapshot } from "../../packages/personbot-protocol/src/index.ts";
import type { RuntimeSnapshot } from "../../packages/personbot-projection/src/index.ts";
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

(enabled ? it : it.skip)("uses personal projects, roles, memories, immutable artifacts and task supplements through the isolated App", async () => {
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
    evidenceDir = `${server.info.logPath}.personbot-personal`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url);
    const rpc = <T = unknown>(method: string, params: object = {}) => api("POST", "/api/personbot/rpc", { method, params }) as Promise<T>;
    const personal = () => rpc<PersonalSnapshot>("personbot.v1.personal.snapshot");
    const tasks = () => rpc<TaskSnapshot>("personbot.v1.tasks.list");
    const artifacts = () => rpc<ArtifactSnapshot>("personbot.v1.artifacts.list");
    const status = await api("GET", "/api/personbot/status") as { workspace: string };
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots") as { bots: { id: string; defaultBot?: unknown }[] };
    for (const bot of bots.filter((bot) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__personbot-personal.html", title: "Isolated Personbot personal system", logLevel: "warn",
    });
    evidence.previewUrl = preview.previewUrl;
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-personbot-personal-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    const waitFor = async (code: string, expected: unknown = true, timeout = 30_000) => {
      await expect.poll(() => evaluate(code), { timeout, interval: 250 }).toEqual(expected);
    };
    const clickSelector = async (selector: string) => {
      await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing control');element.scrollIntoView({block:'center',inline:'nearest'});return true;})()`);
      await waitFor(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return top===e||e.contains(top);})()`);
      await run("click", selector);
    };
    const clickNamed = async (name: string, role = "button") => {
      let ref: string | undefined;
      await expect.poll(async () => {
        const state = await run("snapshot", "-i");
        const matches = Object.entries(state.refs as Record<string, { name?: string; role?: string }> ?? {})
          .filter(([, value]) => value.name === name && value.role === role);
        if (matches.length === 1) ref = `@${matches[0]![0]}`;
        return matches.length;
      }, { timeout: 15_000, interval: 250 }).toBe(1);
      if (role === "button") {
        await waitFor(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});return !!b&&!b.disabled;})()`);
        await evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});b?.scrollIntoView({block:'center',inline:'nearest'});return true;})()`);
      }
      await run("click", ref!);
    };
    const send = async (text: string) => {
      await waitFor(`document.querySelector('button[aria-label="停止 Personbot 当前会话"]')?.disabled===false`);
      const before = await evaluate<number>(`document.querySelectorAll('[data-personbot-message][data-role="assistant"]').length`);
      await run("fill", 'textarea[aria-label="发消息给 Personbot"]', text);
      await run("press", "Enter");
      await waitFor(`document.querySelectorAll('[data-personbot-message][data-role="assistant"]').length > ${before}`);
      await waitFor(`document.querySelector('[aria-label="Personbot 执行状态"]')?.textContent.includes('等待输入')`);
      return evaluate<string>(`[...document.querySelectorAll('[data-personbot-message][data-role="assistant"]')].at(-1).textContent`);
    };
    const readTask = async (id: string) => (await tasks()).tasks.find((task) => task.id === id);
    const awaitTask = async (id: string, stage: TaskRecord["stage"]) => {
      await expect.poll(async () => (await readTask(id))?.stage, { timeout: 30_000, interval: 250 }).toBe(stage);
      if (stage === "awaiting_review") await expect.poll(async () => (await readTask(id))?.stopState, { timeout: 30_000 }).toBe("confirmed");
    };
    await run("open", `${preview.previewUrl}#personbot`);
    await run("set", "viewport", "1440", "900");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await clickSelector("[data-personbot-personal] > summary");
    await clickNamed("添加项目");
    await run("fill", 'input[aria-label="项目名称"]', "Fixture writing project");
    await run("fill", 'input[aria-label="项目目录"]', status.workspace);
    await evaluate(`(() => {
      const original=window.fetch.bind(window);window.personalRpcCalls=[];window.dropProject=true;
      window.fetch=async(input,init)=>{const body=String(input)==='/api/personbot/rpc'&&init?.body?JSON.parse(String(init.body)):null;const response=await original(input,init);if(body)window.personalRpcCalls.push({...body,status:response.status});if(response.ok&&body?.method==='personbot.v1.projects.put'&&window.dropProject){window.dropProject=false;return Response.json({error:'Fixture dropped accepted project response'},{status:503});}return response;};
      window.createdObjectUrls=[];window.revokedObjectUrls=[];
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=(blob)=>{const url=create(blob);window.createdObjectUrls.push(url);return url;};
      URL.revokeObjectURL=(url)=>{window.revokedObjectUrls.push(url);return revoke(url);};return true;
    })()`);
    await clickNamed("保存项目");
    await waitFor(`document.querySelector('[data-personbot-view]').innerText.includes('Fixture dropped accepted project response')`);
    await clickNamed("保存项目");
    await waitFor(`!document.querySelector('form[aria-label="项目设置"]')`);
    const project = (await personal()).projects.find((entry) => entry.name === "Fixture writing project")!;
    expect(project).toBeDefined();
    const projectCalls = await evaluate<Array<{ params: unknown }>>(`window.personalRpcCalls.filter(call=>call.method==='personbot.v1.projects.put')`);
    expect(projectCalls).toHaveLength(2);
    expect(projectCalls[1]!.params).toEqual(projectCalls[0]!.params);
    await clickNamed("角色");
    await clickNamed("添加角色");
    await run("fill", 'input[aria-label="角色名称"]', "Fixture reviewer");
    await run("fill", 'textarea[aria-label="角色说明"]', "ROLE_FIXTURE_REVIEWER: quote the current project memory.");
    await clickNamed("保存角色");
    await waitFor(`!document.querySelector('form[aria-label="角色设置"]')`);
    const role = (await personal()).roles.find((entry) => entry.name === "Fixture reviewer")!;
    await clickSelector("[data-personbot-personal] > summary");
    await clickSelector("header details > summary");
    await run("select", 'select[aria-label="新会话项目"]', project.id);
    await run("select", 'select[aria-label="新会话角色"]', role.id);
    await clickNamed("新会话");
    await waitFor(`Boolean(document.querySelector('textarea[aria-label="发消息给 Personbot"]'))`);
    const sessionId = await evaluate<string>(`document.querySelector('select[aria-label="Personbot 会话"]').value`);
    ownedPid = runtimePid(server.info.pid);
    evidence.runtimePid = ownedPid;
    evidence.sessionId = sessionId;
    const bound = (await rpc<RuntimeSnapshot>("personbot.v1.snapshots.get")).sessions.find((entry) => entry.sessionId === sessionId)!;
    expect(bound).toMatchObject({ projectId: project.id, roleId: role.id, roleRevision: role.revision, cwd: project.path });
    await waitFor(`document.querySelector('[data-personbot-session-binding]').textContent.includes('Fixture reviewer')`);
    checked("project creation survives a lost accepted response; chosen project and frozen role bind the new native session");

    await clickSelector("[data-personbot-personal] > summary");
    await clickNamed("记忆");
    await clickNamed("添加记忆");
    await run("select", 'select[aria-label="记忆范围"]', "project");
    await run("select", 'select[aria-label="记忆所属项目"]', project.id);
    await run("fill", 'input[aria-label="记忆名称"]', "report-format");
    await run("fill", 'textarea[aria-label="记忆内容"]', "FORMAT_ORIGINAL");
    await clickNamed("保存记忆");
    await waitFor(`!document.querySelector('form[aria-label="记忆设置"]')`);
    const originalContext = await send("context");
    expect(originalContext).toContain("FORMAT_ORIGINAL");
    expect(originalContext).toContain("ROLE_FIXTURE_REVIEWER");
    await clickNamed("纠正记忆");
    await run("fill", 'textarea[aria-label="记忆内容"]', "FORMAT_CORRECTED");
    await clickNamed("保存记忆");
    await waitFor(`!document.querySelector('form[aria-label="记忆设置"]')`);
    const correctedContext = await send("context");
    expect(correctedContext).toContain("FORMAT_CORRECTED");
    expect(correctedContext).not.toContain("FORMAT_ORIGINAL");
    evidence.contexts = { originalContext, correctedContext };
    checked("project memory correction persists and the next actual native model call receives only its current active value");

    await send(`memory-propose ${JSON.stringify({ scope: "personal", key: "delivery-style", value: "PROPOSAL_REQUIRES_CONFIRMATION" })}`);
    await expect.poll(async () => (await personal()).memories.some((memory) => memory.key === "delivery-style" && memory.status === "proposed"), { timeout: 30_000 }).toBe(true);
    await waitFor(`document.querySelector('[data-personbot-personal]').innerText.includes('PROPOSAL_REQUIRES_CONFIRMATION')`);
    const beforeConfirm = await send("context");
    expect(beforeConfirm).not.toContain("PROPOSAL_REQUIRES_CONFIRMATION");
    await clickNamed("确认记忆");
    await expect.poll(async () => (await personal()).memories.find((memory) => memory.key === "delivery-style")?.status, { timeout: 30_000 }).toBe("active");
    const afterConfirm = await send("context");
    expect(afterConfirm).toContain("PROPOSAL_REQUIRES_CONFIRMATION");
    await evaluate(`(() => {document.querySelector('[data-personbot-personal]').scrollIntoView({block:'start',inline:'nearest'});return true;})()`);
    await run("screenshot", join(evidenceDir, "memory-confirmed.png"));
    checked("agent memory proposals remain inactive until explicit user confirmation in the App");
    await clickSelector("[data-personbot-personal] > summary");
    await clickSelector("header details > summary");

    const originalBytes = '<script>window.fixtureExecuted=true</script>\nOriginal immutable report\n';
    writeFileSync(join(status.workspace, "report.md"), originalBytes);
    writeFileSync(join(status.workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"));
    await clickSelector("[data-personbot-artifacts] > summary");
    const publish = async (path: string, name: string) => {
      await clickNamed("发布文件");
      await run("fill", 'input[aria-label="产物文件路径"]', path);
      await run("fill", 'input[aria-label="产物显示名称"]', name);
      await clickNamed("保存产物快照");
      await waitFor(`!document.querySelector('form[aria-label="发布产物"]')`);
      return (await artifacts()).artifacts.find((artifact) => artifact.name === name)!;
    };
    const report = await publish("report.md", "Fixture report.md");
    await clickNamed("预览产物：Fixture report.md");
    await waitFor(`document.querySelector('[data-personbot-artifact-preview]')?.textContent.includes('Original immutable report')`);
    expect(await evaluate(`window.fixtureExecuted ?? false`)).toBe(false);
    expect(await evaluate(`document.querySelector('[data-personbot-artifact-preview] script')===null`)).toBe(true);
    await evaluate(`(() => {document.querySelector('[data-personbot-artifacts]').scrollIntoView({block:'start',inline:'nearest'});return true;})()`);
    await run("screenshot", join(evidenceDir, "artifact-preview.png"));
    writeFileSync(join(status.workspace, "report.md"), "Changed source after publication\n");
    const download = await evaluate<{ status: number; disposition: string; text: string }>(`(async()=>{const a=document.querySelector('[data-personbot-artifact="${report.id}"] a[download]');const r=await fetch(a.href);return {status:r.status,disposition:r.headers.get('content-disposition'),text:await r.text()};})()`);
    expect(download.status).toBe(200);
    expect(download.disposition).toContain("attachment;");
    expect(download.text).toBe(originalBytes);
    await clickNamed("预览产物：Fixture report.md");
    const image = await publish("pixel.png", "Fixture pixel.png");
    await clickNamed("预览产物：Fixture pixel.png");
    await waitFor(`(() => {const image=document.querySelector('[data-personbot-artifact="${image.id}"] img');return !!image&&image.complete&&image.naturalWidth===1;})()`);
    await clickNamed("预览产物：Fixture pixel.png");
    await waitFor(`window.createdObjectUrls.length===1&&window.revokedObjectUrls.includes(window.createdObjectUrls[0])`);
    evidence.objectUrlLifecycle = await evaluate(`({created:window.createdObjectUrls,revoked:window.revokedObjectUrls})`);
    evidence.download = download;
    checked("App publishes immutable file bytes, escapes text markup, previews a safe raster and downloads the original snapshot after source changes");
    await clickSelector("[data-personbot-artifacts] > summary");

    await clickNamed("新任务");
    await run("fill", 'textarea[aria-label="任务目标"]', "task-supplement");
    await run("fill", 'textarea[aria-label="任务完成条件"]', "Receive supplement in the same worker and report it");
    await clickNamed("创建并执行任务");
    let taskId = "";
    await expect.poll(async () => {
      const task = (await tasks()).tasks.find((entry) => entry.goal === "task-supplement");
      taskId = task?.id ?? "";
      return !!task;
    }, { timeout: 30_000 }).toBe(true);
    await awaitTask(taskId, "waiting_person");
    const firstTask = (await readTask(taskId))!;
    await clickSelector(`[data-personbot-task="${taskId}"] > summary`);
    await run("fill", `textarea[aria-label="补充任务说明：task-supplement"]`, "SUPPLEMENT_STAYS_WITH_ORIGINAL_WORKER");
    await clickNamed("发送补充说明");
    await expect.poll(async () => (await readTask(taskId))?.messages?.some((message) => message.text === "SUPPLEMENT_STAYS_WITH_ORIGINAL_WORKER"), { timeout: 30_000 }).toBe(true);
    await clickNamed("查看任务会话");
    await waitFor(`Boolean(document.querySelector('[data-personbot-question]'))`);
    await clickNamed("Markdown", "radio");
    await clickNamed("提交回答");
    await awaitTask(taskId, "awaiting_review");
    const supplementedTask = (await readTask(taskId))!;
    expect(supplementedTask.workerSessionId).toBe(firstTask.workerSessionId);
    expect(supplementedTask.currentExecutionId).toBe(firstTask.currentExecutionId);
    expect(supplementedTask.report?.summary).toContain("SUPPLEMENT_STAYS_WITH_ORIGINAL_WORKER");
    expect(supplementedTask.workspace?.path).not.toBe(status.workspace);
    expect(supplementedTask.workspace?.sourcePath).toBe(project.path);
    evidence.supplement = { firstTask, supplementedTask };
    await clickNamed("返回来源会话");
    checked("supplement reaches the original independent worker and execution; task output directory is separate from the project source");

    const beforeReload = { personal: await personal(), artifacts: await artifacts(), tasks: await tasks() };
    await run("reload");
    await waitFor(`document.querySelector('[aria-label="Personbot 连接状态"]')?.textContent.includes('已连接')`, true, 60_000);
    await waitFor(`document.querySelector('select[aria-label="Personbot 会话"]').value`, sessionId);
    expect(await personal()).toEqual(beforeReload.personal);
    expect(await artifacts()).toEqual(beforeReload.artifacts);
    expect((await tasks()).tasks).toEqual(beforeReload.tasks.tasks);
    const restoredContext = await send("context");
    expect(restoredContext).toContain("FORMAT_CORRECTED");
    expect(restoredContext).not.toContain("FORMAT_ORIGINAL");
    checked("reload restores fixed session binding, corrected memories, task messages and immutable artifact records");

    const geometry: unknown[] = [];
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "900");
      await waitFor("innerWidth", width);
      if (width < 768) await expect.poll(() => evaluate<number>(`document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? 0`), { timeout: 10_000 }).toBeLessThanOrEqual(0);
      await evaluate(`(() => {document.querySelector('[data-personbot-personal]').open=true;document.querySelector('[data-personbot-artifacts]').open=true;document.querySelector('[aria-label="Personbot 对话"]').scrollTop=0;return true;})()`);
      const layout = await evaluate<{ page: number; controls: { left: number; right: number }[] }>(`(() => ({page:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('[data-personbot-view] input,[data-personbot-view] select,[data-personbot-view] textarea,[data-personbot-view] button')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};})}))()`);
      expect(layout.page).toBeLessThanOrEqual(width);
      for (const control of layout.controls) {
        expect(control.left).toBeGreaterThanOrEqual(-1);
        expect(control.right).toBeLessThanOrEqual(width + 1);
      }
      geometry.push({ width, ...layout });
      await run("screenshot", join(evidenceDir, `personbot-personal-${width}.png`));
    }
    evidence.geometry = geometry;
    evidence.personal = await personal();
    evidence.artifacts = await artifacts();
    evidence.tasks = await tasks();
    evidence.console = await run("console");
    expect(((evidence.console as { messages?: { type?: string }[] }).messages ?? []).filter((message) => message.type === "error")).toEqual([]);
    checked("1440, 768 and 390 widths keep personal setup, artifact actions, task controls and the main composer inside the viewport; console has no errors");
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
      checked("owned fixture runtime/browser/server exited and disposable data was removed");
    } finally {
      if (evidenceDir) {
        writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(`Personbot Personal App verification evidence: ${evidenceDir}`);
      }
    }
  }
}, 360_000);
