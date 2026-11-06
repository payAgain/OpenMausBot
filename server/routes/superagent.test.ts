import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { SuperagentBinding, SuperagentGateway, SuperagentSnapshot } from "../../shared/superagent.ts";
import type { SuperagentCapabilities } from "../../shared/superagent-capabilities.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createSuperagentRoutes } from "./superagent.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture() {
  const first = { botId: "bot", threadId: "thread", contextId: "old-directory", workspace: "/one", active: true };
  const second = { ...first, contextId: "new-directory", workspace: "/two" };
  const foreign = { botId: "foreign", threadId: "foreign-thread", contextId: "foreign-context", workspace: "/foreign", active: true };
  const snapshot: SuperagentSnapshot = {
    bindings: [first, second, foreign],
    tasks: [
      { ...first, ticketId: "task-a", requestId: "input-a", state: "working", ended: false },
      { ...second, ticketId: "task-b", requestId: "input-b", state: "working", ended: false },
      { ...foreign, ticketId: "foreign-task", requestId: "foreign-input", state: "working" },
    ],
    decisions: [], resources: { activeCalls: 1, queuedCalls: 2, maxConcurrentCalls: 4, inputTokens: 25, outputTokens: 5, unpricedCalls: 1 },
  };
  let live = true;
  let auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const interrupt = vi.fn(async () => {});
  const releaseWorkspace = vi.fn(async () => true);
  const gateway: SuperagentGateway = {
    start: async () => {}, submit: async () => {}, interrupt, respond: async () => false,
    generateText: async () => "", subscribe: () => () => {}, close: async () => {},
    status: () => ({ enabled: true, state: "ready" }), inspect: async () => snapshot, releaseWorkspace,
  };
  const available = (binding: SuperagentBinding) => binding.botId === "bot" && binding.threadId === "thread";
  const options: Parameters<typeof createSuperagentRoutes>[0] = { gateway, live: () => live, available, status: gateway.status };
  const route = createSuperagentRoutes(options);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!await dispatchRoutes([route], { req, res, method: req.method ?? "GET", path: url.pathname, url, auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    first, second, snapshot, gateway, interrupt, releaseWorkspace, options,
    revoke: () => { live = false; },
    member: () => { auth = { kind: "loopback", trust: "service", scopes: ["client"] }; },
    async request<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown) {
      const response = await fetch(base + path, {
        method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as T };
    },
  };
}

it("stops an exact task while conversation Stop spans preserved workspace contexts", async () => {
  const f = await fixture();
  expect((await f.request("/api/personbot/tasks/task-a/stop", "POST")).status).toBe(200);
  expect(f.interrupt).toHaveBeenCalledExactlyOnceWith(f.snapshot.tasks[0], { scope: "task", ticketId: "task-a" });
  f.interrupt.mockClear();
  expect((await f.request("/api/personbot/threads/thread/stop", "POST")).status).toBe(200);
  expect(f.interrupt.mock.calls).toEqual([
    [{ botId: "bot", threadId: "thread" }, { scope: "conversation" }],
  ]);
  expect((await f.request("/api/personbot/tasks/foreign-task/stop", "POST")).status).toBe(404);
});

it("reports supported capabilities and actual resources without exposing unavailable tasks", async () => {
  const f = await fixture();
  const capabilities = (await f.request<SuperagentCapabilities>("/api/personbot/capabilities")).body;
  expect(capabilities.features).toContainEqual(expect.objectContaining({ id: "connected-apps", available: false }));
  expect(capabilities.features).toContainEqual(expect.objectContaining({ id: "background-decisions", available: true }));
  const tasks = (await f.request<Pick<SuperagentSnapshot, "tasks">>("/api/personbot/tasks?threadId=thread")).body.tasks;
  expect(tasks.map((task: { ticketId: string }) => task.ticketId)).toEqual(["task-a", "task-b"]);
  expect((await f.request("/api/personbot/resources")).body).toEqual(f.snapshot.resources);
});

it("requires a current owner and rechecks revocation after asynchronous inspection", async () => {
  const f = await fixture();
  f.member();
  expect((await f.request("/api/personbot/tasks")).status).toBe(403);
  expect((await f.request("/api/personbot/tasks/task-a/stop", "POST")).status).toBe(403);
  expect(f.interrupt).not.toHaveBeenCalled();
  const ended = await fixture();
  ended.gateway.inspect = async () => { ended.revoke(); return ended.snapshot; };
  expect((await ended.request("/api/personbot/tasks/task-a/stop", "POST")).status).toBe(401);
  expect(ended.interrupt).not.toHaveBeenCalled();
});

it("requires an explicit owner reconciliation before releasing an uncertain workspace write window", async () => {
  const f = await fixture();
  const path = "/api/personbot/workspaces/quarantine-a/reconcile";
  expect((await f.request(path, "POST", {})).status).toBe(400);
  expect((await f.request(path, "POST", { acknowledge: "continue" })).status).toBe(400);
  expect(f.releaseWorkspace).not.toHaveBeenCalled();
  expect((await f.request(path, "POST", { acknowledge: "external-processes-reviewed" })).status).toBe(200);
  expect(f.releaseWorkspace).toHaveBeenCalledExactlyOnceWith("quarantine-a");
  const member = await fixture();
  member.member();
  expect((await member.request(path, "POST", { acknowledge: "external-processes-reviewed" })).status).toBe(403);
  expect(member.releaseWorkspace).not.toHaveBeenCalled();
});

it("withholds task usage if the owner session ends while reading the original ledger", async () => {
  const f = await fixture();
  f.options.taskUsage = async () => { f.revoke(); return { inputTokens: 12 }; };
  const result = await f.request("/api/personbot/tasks/task-a/usage");
  expect(result.status).toBe(401);
  expect(result.body).not.toHaveProperty("usage");
});
