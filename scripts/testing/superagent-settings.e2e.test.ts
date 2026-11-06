import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SuperagentSnapshot } from "../../shared/superagent.ts";
import { closeBrowserSession } from "../../server/browser-engine.ts";
import { launchVerificationServer, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

it("shows real host quarantine in the original Settings and requires explicit reconciliation at desktop, tablet and phone widths", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browser: Awaited<ReturnType<typeof ensureUiBrowser>> | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  let evidenceDir: string | undefined;
  const evidence: Record<string, unknown> = { checks: [], layouts: [], api: [] };
  const checks = evidence.checks as string[];
  try {
    browser = await ensureUiBrowser(process.env);
    fixture = await launchVerificationServer(process.env, undefined, undefined,
      { binaryPath: browser.binary, executablePath: browser.chrome ?? "" },
      undefined, undefined, [], undefined, undefined, true, true, true);
    const server = fixture;
    evidenceDir = `${server.info.logPath}.review-settings`;
    mkdirSync(evidenceDir, { recursive: true });
    evidence.fixture = server.info;
    const api = fixtureApi(server.info.url, {
      headers: { origin: server.info.url },
      observe: call => { if (call.method !== "GET") (evidence.api as unknown[]).push(call); },
    });
    await api("PATCH", "/api/config", { language: "zh" });
    const { bot } = await api("POST", "/api/bots", { name: "运行时设置验收", memoryUpkeep: false }) as { bot: { id: string; threadId: string } };
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", memoryUpkeep: false });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "task background approval" });
    await expect.poll(async () => {
      const state = await api("GET", `/api/personbot/tasks?threadId=${bot.threadId}`) as SuperagentSnapshot;
      return state.decisions.some(item => item.status === "pending");
    }, { timeout: 45_000, interval: 100 }).toBe(true);
    const native = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match && Number(match[2]) === server.info.pid && /[/\\]dsh[/\\]lib[/\\]bin\.js/.test(match[3]!) ? [Number(match[1])] : [];
    });
    expect(native).toHaveLength(1);
    process.kill(native[0]!, "SIGKILL");
    await expect.poll(async () => (await api("GET", "/api/personbot/resources") as SuperagentSnapshot["resources"])
      .quarantinedWorkspaces?.length, { timeout: 20_000, interval: 100 }).toBe(1);
    evidence.quarantineBefore = await api("GET", "/api/personbot/resources");
    checks.push("A real native SIGKILL while an official worker holds a write window produces persistent host quarantine.");

    preview = await mountPreview(server, {
      entry: "/scripts/testing/threads-preview.tsx", route: "/__superagent-settings.html",
      title: "原设置 · Super Agent 资源与隔离验收", logLevel: "warn",
    });
    browserEnv = sessionEnv({ home: server.info.dataDir, session: `omb-review-settings-${new URL(server.info.url).port}`, chrome: browser.chrome });
    const run = (...args: string[]) => agentBrowser(browser!.binary, browserEnv!, args);
    const evaluate = async <T = unknown>(code: string): Promise<T> => (await run("eval", code)).result as T;
    await run("set", "viewport", "1440", "1000");
    await run("open", `${preview.previewUrl}?connect=keys`);
    await expect.poll(() => evaluate("Boolean(document.querySelector('[data-superagent-resources]'))"), { timeout: 45_000 }).toBe(true);
    if (await evaluate("Boolean(document.querySelector('[data-mausbot-welcome-later]'))")) {
      await run("click", "[data-mausbot-welcome-later]");
    }
    await expect.poll(() => evaluate("document.querySelector('[data-superagent-resources]')?.textContent.includes('此目录的写入已隔离')"),
      { timeout: 20_000 }).toBe(true);
    for (const width of [1440, 768, 390]) {
      await run("set", "viewport", String(width), "1000");
      await evaluate("document.querySelector('[data-superagent-resources]').scrollIntoView({block:'center'}); true");
      const layout = await evaluate<{ viewport: number; documentWidth: number; left: number; right: number; text: string }>(
        "(() => { const el=document.querySelector('[data-superagent-resources]'); const r=el.getBoundingClientRect(); return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,text:el.textContent}; })()");
      expect(layout.documentWidth).toBeLessThanOrEqual(width + 1);
      expect(layout.left).toBeGreaterThanOrEqual(-1);
      expect(layout.right).toBeLessThanOrEqual(width + 1);
      expect(layout.text).toContain("模型调用");
      (evidence.layouts as unknown[]).push(layout);
      await run("screenshot", join(evidenceDir, `original-settings-${width}.png`));
    }
    checks.push("The original Settings shows actual resources and quarantine at 1440, 768 and 390 pixels without horizontal overflow.");
    await evaluate("Array.from(document.querySelectorAll('[data-superagent-resources] button')).find(el=>el.textContent==='检查后解除隔离').click(); true");
    await expect.poll(() => evaluate("document.querySelector('[role=alertdialog]')?.textContent.includes('解除工作目录写入隔离？')")).toBe(true);
    expect(await evaluate("document.activeElement?.textContent")).toBe("取消");
    await run("screenshot", join(evidenceDir, "reconcile-confirmation-390.png"));
    await run("press", "Escape");
    expect(await evaluate("Boolean(document.querySelector('[data-superagent-resources]'))")).toBe(true);
    await expect.poll(() => evaluate("Boolean(document.querySelector('[role=alertdialog]'))")).toBe(false);
    expect((await api("GET", "/api/personbot/resources") as SuperagentSnapshot["resources"]).quarantinedWorkspaces).toHaveLength(1);
    checks.push("The existing confirmation dialog focuses Cancel; Escape preserves the quarantine.");
    await evaluate("Array.from(document.querySelectorAll('[data-superagent-resources] button')).find(el=>el.textContent==='检查后解除隔离').click(); true");
    await evaluate("Array.from(document.querySelectorAll('[role=alertdialog] button')).find(el=>el.textContent==='已检查，解除隔离').click(); true");
    await expect.poll(async () => (await api("GET", "/api/personbot/resources") as SuperagentSnapshot["resources"])
      .quarantinedWorkspaces?.length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => evaluate("Boolean(document.querySelector('[role=alertdialog]'))")).toBe(false);
    evidence.quarantineAfter = await api("GET", "/api/personbot/resources");
    checks.push("Explicit owner confirmation reaches the real reconcile endpoint and removes the exact quarantine.");
    writeFileSync("/tmp/personbot-review-settings-evidence-path.txt", evidenceDir);
  } finally {
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
      if (fixture && existsSync(fixture.info.logPath)) writeFileSync(join(evidenceDir, "server.log"), readFileSync(fixture.info.logPath));
    }
    if (browser && browserEnv) await closeBrowserSession(browserEnv.AGENT_BROWSER_SESSION!, browserEnv, browser.binary).catch(() => {});
    await preview?.close();
    await fixture?.close();
  }
}, 120_000);
