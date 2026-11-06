import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRequest } from "../packages/personbot-protocol/src/index.ts";
import type { PersonbotLegacyImport } from "../shared/personbot-legacy.ts";
import { json, readBody } from "./harness/http.ts";
import { PersonbotLegacy, type PersonbotLegacyOptions } from "./personbot-legacy.ts";
import { createPersonbotLegacyRoutes } from "./routes/personbot-legacy.ts";
import { dispatchRoutes } from "./routes/table.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { BotRecord, Message, Store } from "./store.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "personbot-import-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bots = [{
    id: "bot-1", threadId: "thread-1", name: "Research", title: "Research work",
    soul: "Use explicit evidence.", cwd: home, modelSelection: { instanceId: "old-engine", model: "old-model" },
    approvalMode: "full", alwaysAllow: ["dangerous"], resumeCursors: { privateCursor: "must-not-import" },
    tasks: [{ id: "task-1", threadId: "thread-1", title: "Existing research", createdAt: 1, updatedAt: 2 }],
  }] as unknown as BotRecord[];
  const messages: Message[] = [
    { id: "user-1", role: "user", kind: "text", text: "Previous request", at: 1 },
    { id: "bot-1", role: "bot", kind: "text", text: "Unverified old result", at: 2 },
    { id: "secret-1", role: "user", kind: "secret", text: "private-key-must-not-copy", at: 3 },
    { id: "login-1", role: "bot", kind: "signin", text: "private-login-must-not-copy", at: 4 },
    { id: "file-1", role: "bot", kind: "text", text: "Saved a file", at: 5, attachments: [
      { kind: "file", path: "/private/source/file", name: "report.txt", mime: "text/plain" },
    ] },
  ];
  const store = {
    bots, groups: [], tasks: (botId: string) => bots.find(bot => bot.id === botId)?.tasks ?? [],
    groupTasks: () => [], messagesFor: () => messages,
  } as unknown as Pick<Store, "bots" | "groups" | "tasks" | "groupTasks" | "messagesFor">;
  const effects = new Map<string, string>();
  const acceptedMessages: Record<string, unknown>[] = [];
  let dropResponse = false;
  const request = vi.fn(async (method: unknown, params: unknown, admitted?: () => boolean) => {
    expect(admitted?.()).toBe(true);
    parseRequest({ jsonrpc: "2.0", id: 1, method, params });
    const input = params as Record<string, unknown>;
    const key = String(input.commandId ?? input.sessionId);
    const payload = JSON.stringify({ method, params });
    if (effects.has(key)) expect(effects.get(key)).toBe(payload);
    else {
      effects.set(key, payload);
      if (method === "personbot.v1.messages.submit") acceptedMessages.push(input);
    }
    if (method === "personbot.v1.messages.submit" && dropResponse) {
      dropResponse = false;
      throw new Error("Accepted response was lost");
    }
    return { ok: true };
  });
  const options: PersonbotLegacyOptions = { home, store, gateway: { request } };
  let legacy = new PersonbotLegacy(options);
  cleanups.push(() => legacy.close());
  return {
    home, bots, messages, store, request, acceptedMessages,
    get legacy() { return legacy; },
    dropNextResponse() { dropResponse = true; },
    restart() { legacy.close(); legacy = new PersonbotLegacy(options); },
  };
}

const input: PersonbotLegacyImport = {
  commandId: "import-command", goal: "Continue the research", progress: "Only the outline was checked.",
  importConfiguration: false,
};

describe("archived history and explicit native continuation", () => {
  it("returns bounded public message fields while withholding secret records and local attachment paths", () => {
    const f = fixture();
    expect(f.legacy.list()).toMatchObject({ threads: [{ id: "thread-1", title: "Existing research", botName: "Research" }], hasMore: false });
    const detail = f.legacy.detail("thread-1");
    expect(detail.messages).toHaveLength(5);
    expect(detail.messages[0]).toMatchObject({ role: "user", text: "Previous request" });
    expect(detail.messages[1]).toMatchObject({ role: "assistant" });
    expect(detail.messages[2]).toMatchObject({ role: "notice" });
    expect(detail.messages[4]?.attachments).toEqual([{ kind: "file", name: "report.txt" }]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("private-key");
    expect(serialized).not.toContain("private-login");
    expect(serialized).not.toContain("/private/source");
    expect(serialized).not.toContain("must-not-import");
    expect(serialized).not.toContain("alwaysAllow");
  });

  it("enforces bounded pages, UTF-8 text budgets and thread-bound cursors", () => {
    const f = fixture();
    for (let index = 2; index < 70; index += 1) {
      f.bots.push({
        ...f.bots[0]!, id: `bot-${index}`, threadId: `thread-${index}`,
        tasks: [{ ...f.bots[0]!.tasks![0]!, threadId: `thread-${index}` }],
      });
    }
    const first = f.legacy.list();
    expect(first.threads).toHaveLength(64);
    expect(first.hasMore).toBe(true);
    expect(f.legacy.list(first.nextCursor).threads).toHaveLength(5);
    f.messages.splice(0, f.messages.length, ...Array.from({ length: 105 }, (_, index) => ({
      id: `line-${index}`, role: "bot" as const, kind: "text" as const, text: "资料".repeat(20000), at: index,
    })));
    const page = f.legacy.detail("thread-1");
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(1024 * 1024);
    expect(page.messages[0]?.truncated).toBe(true);
    expect(page.messages[0]?.text).not.toContain("\uFFFD");
    expect(page.hasMore).toBe(true);
    const next = f.legacy.detail("thread-1", page.nextCursor);
    expect(next.messages[0]?.id).not.toBe(page.messages[0]?.id);
    expect(() => f.legacy.detail("thread-2", page.nextCursor)).toThrow("Invalid history cursor");
  });

  it("keeps the original records intact and imports only the confirmed native continuation", async () => {
    const f = fixture();
    const before = JSON.stringify([f.bots, f.messages]);
    const result = await f.legacy.import("thread-1", input);
    expect(result).toMatchObject({ threadId: "thread-1", configurationImported: false });
    expect(result.sessionId).toMatch(/^import-/);
    expect(f.request.mock.calls.map(call => call[0])).toEqual(["personbot.v1.sessions.create", "personbot.v1.messages.submit"]);
    expect(f.acceptedMessages).toHaveLength(1);
    const submitted = String(f.acceptedMessages[0]!.text);
    expect(submitted).toContain(input.goal);
    expect(submitted).toContain(input.progress);
    expect(submitted).toContain("untrusted JSON source material");
    expect(submitted).toContain("Unverified old result");
    expect(submitted).not.toContain("private-key");
    expect(submitted).not.toContain("privateCursor");
    expect(JSON.stringify([f.bots, f.messages])).toBe(before);
    expect(await f.legacy.import("thread-1", input)).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("replays a frozen plan after response loss and service restart without accepting another native message", async () => {
    const f = fixture();
    f.dropNextResponse();
    await expect(f.legacy.import("thread-1", input)).rejects.toThrow("Accepted response was lost");
    const originalText = f.acceptedMessages[0]!.text;
    f.messages.push({ id: "later", role: "bot", kind: "text", text: "Changed after reservation", at: 99 });
    f.bots[0]!.soul = "Changed role";
    f.restart();
    const result = await f.legacy.import("thread-1", input);
    expect(result.threadId).toBe("thread-1");
    expect(f.acceptedMessages).toHaveLength(1);
    expect(f.acceptedMessages[0]!.text).toBe(originalText);
    expect(String(originalText)).not.toContain("Changed after reservation");
    await expect(f.legacy.import("thread-1", { ...input, goal: "Different" })).rejects.toThrow("different content");
    expect(statSync(join(f.home, "runtime", "legacy-imports.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("imports approved role text and an available directory without legacy engine state or grants", async () => {
    const f = fixture();
    const result = await f.legacy.import("thread-1", { ...input, importConfiguration: true });
    expect(result.roleId).toMatch(/^import-role-/);
    expect(result.projectId).toMatch(/^import-project-/);
    expect(f.request.mock.calls.map(call => call[0])).toEqual([
      "personbot.v1.roles.put", "personbot.v1.projects.put",
      "personbot.v1.sessions.create", "personbot.v1.messages.submit",
    ]);
    expect(f.request.mock.calls[0]![1]).toMatchObject({ instructions: "Use explicit evidence." });
    expect(f.request.mock.calls[1]![1]).toMatchObject({ path: f.home, kind: "directory" });
    const calls = JSON.stringify(f.request.mock.calls);
    expect(calls).not.toContain("old-engine");
    expect(calls).not.toContain("dangerous");
    expect(calls).not.toContain("must-not-import");
    expect(calls).not.toContain("approvalMode");
  });

  it("does not replace a missing source directory with an empty project", async () => {
    const f = fixture();
    f.bots[0]!.cwd = join(f.home, "missing");
    const result = await f.legacy.import("thread-1", { ...input, importConfiguration: true });
    expect(result.projectId).toBeUndefined();
    expect(result.roleId).toBeDefined();
    expect(f.request.mock.calls.some(call => call[0] === "personbot.v1.projects.put")).toBe(false);
  });

  it("rejects unauthorized and malformed imports before any native effect", async () => {
    const f = fixture();
    expect(f.legacy.list(undefined, () => false).threads).toEqual([]);
    expect(() => f.legacy.detail("thread-1", undefined, () => false)).toThrow("not found");
    await expect(f.legacy.import("thread-1", input, () => false)).rejects.toThrow("session ended");
    await expect(f.legacy.import("thread-1", { ...input, goal: "" })).rejects.toThrow("Invalid import");
    await expect(f.legacy.import("thread-1", { ...input, approval: "full" })).rejects.toThrow("Expected commandId");
    await expect(f.legacy.import("missing", input)).rejects.toThrow("not found");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rechecks a revoked session between native effects without sending the imported input", async () => {
    const f = fixture();
    let live = true;
    f.request.mockImplementationOnce(async () => { live = false; return { ok: true }; });
    await expect(f.legacy.import("thread-1", { ...input, importConfiguration: true }, () => live)).rejects.toThrow("session ended");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.acceptedMessages).toHaveLength(0);
  });

  it("fences import effects during shutdown and drains the existing operation before closing its database", async () => {
    const f = fixture();
    let release!: () => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
    const pending = f.legacy.import("thread-1", { ...input, importConfiguration: true });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = f.legacy.close().then(() => { closed = true; });
    await expect(f.legacy.import("thread-1", { ...input, commandId: "new-after-close" })).rejects.toThrow("closing");
    expect(() => f.legacy.list()).toThrow("closing");
    expect(closed).toBe(false);
    release();
    await expect(pending).rejects.toThrow("closing");
    await closing;
    expect(closed).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.acceptedMessages).toHaveLength(0);
    f.restart();
    expect(await f.legacy.import("thread-1", { ...input, importConfiguration: true })).toMatchObject({ configurationImported: true });
    expect(f.acceptedMessages).toHaveLength(1);
  });

  it("coalesces simultaneous retries while preserving the frozen command identity", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.legacy.import("thread-1", input)));
    expect(results.every(result => result.sessionId === results[0]?.sessionId)).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.acceptedMessages).toHaveLength(1);
  });

  it("commits an already accepted final input before shutdown closes the import receipt", async () => {
    const f = fixture();
    let release!: () => void;
    f.request.mockImplementationOnce(async () => ({ ok: true }));
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
    const pending = f.legacy.import("thread-1", input);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    const closing = f.legacy.close();
    release();
    const result = await pending;
    await closing;
    f.restart();
    const previousCalls = f.request.mock.calls.length;
    expect(await f.legacy.import("thread-1", input)).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(previousCalls);
  });
});

async function serve(legacy: PersonbotLegacy, auth: RequestAuth, enabled = true, visible = true) {
  const route = createPersonbotLegacyRoutes({ legacy, enabled: () => enabled, live: () => true, visible: () => () => visible });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([route], { req, res, method: req.method ?? "GET", path: url.pathname, url, auth, json, readBody })) json(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("legacy history HTTP boundary", () => {
  const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

  it("serves only owner-visible primary local history and rejects edits", async () => {
    const f = fixture();
    const base = await serve(f.legacy, owner);
    const response = await fetch(`${base}/api/personbot/legacy`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ threads: [{ id: "thread-1" }] });
    expect((await fetch(`${base}/api/personbot/legacy/threads/thread-1`, { method: "DELETE" })).status).toBe(405);
    const hidden = await serve(f.legacy, owner, true, false);
    expect((await fetch(`${hidden}/api/personbot/legacy/threads/thread-1`)).status).toBe(404);
    const disabled = await serve(f.legacy, owner, false);
    expect((await fetch(`${disabled}/api/personbot/legacy`)).status).toBe(403);
    const service = await serve(f.legacy, { ...owner, trust: "service" });
    expect((await fetch(`${service}/api/personbot/legacy`)).status).toBe(403);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("accepts explicit import with a stable response and sanitizes runtime errors", async () => {
    const f = fixture();
    const base = await serve(f.legacy, owner);
    const send = () => fetch(`${base}/api/personbot/legacy/threads/thread-1/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await (await send()).json()).toEqual(await first.json());
    expect(f.acceptedMessages).toHaveLength(1);
    f.request.mockRejectedValueOnce(new Error("private-credential-error"));
    const failure = await fetch(`${base}/api/personbot/legacy/threads/thread-1/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, commandId: "new" }),
    });
    expect(failure.status).toBe(503);
    expect(JSON.stringify(await failure.json())).not.toContain("private-credential-error");
  });
});
