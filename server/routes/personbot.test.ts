import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayFrame, GatewayStatus } from "../../packages/personbot-gateway/src/index.ts";
import { ProtocolError } from "../../packages/personbot-protocol/src/index.ts";
import { RuntimeRpcError, type RuntimeHost } from "../../packages/personbot-runtime-host/src/index.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createPersonbotIngress, createPersonbotRoutes, type PersonbotIngressOptions, type PersonbotRouteOptions } from "./personbot.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const admin: RequestAuth = {
  kind: "session", via: "cookie", scopes: ["admin", "client"],
  session: {
    id: "fixture-owner", tokenHash: "0".repeat(64), label: "Fixture owner", scopes: ["admin", "client"],
    createdAt: 0, lastSeenAt: 0, expiresAt: Number.MAX_SAFE_INTEGER,
  },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function fixture() {
  let live = true;
  const listeners = new Set<(frame: GatewayFrame) => void>();
  const revoked = new Set<(id: string) => void>();
  const status: GatewayStatus = {
    enabled: true, state: "ready", workspace: "/fixture/workspace", provider: "fixture", model: "fixture",
  };
  const gateway = {
    status: vi.fn(() => status),
    start: vi.fn(async () => ({} as RuntimeHost)),
    request: vi.fn(async (_method: unknown, _params: unknown, admitted?: () => boolean): Promise<unknown> => {
      if (!admitted?.()) throw new ProtocolError(-32001, "Your session ended");
      return { ok: true };
    }),
    subscribe: vi.fn((listener: (frame: GatewayFrame) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  } satisfies PersonbotRouteOptions["gateway"];
  return {
    gateway, status, listeners, revoked,
    options: {
      gateway,
      live: () => live,
      onRevoked: (listener: (id: string) => void) => {
        revoked.add(listener);
        return () => { revoked.delete(listener); };
      },
    } satisfies PersonbotRouteOptions,
    revoke(id = "fixture-owner") {
      live = false;
      for (const listener of revoked) listener(id);
    },
    emit(frame: GatewayFrame) { for (const listener of listeners) listener(frame); },
  };
}

async function serve(options: PersonbotRouteOptions, auth: RequestAuth = owner) {
  const route = createPersonbotRoutes(options);
  const responses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    responses.add(res);
    res.on("close", () => responses.delete(res));
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await dispatchRoutes([route], {
        req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody,
      });
      if (!handled) json(res, 404, { passed: true });
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 500;
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    responses,
    content(path: string) {
      return fetch(`${base}${path}`);
    },
    async json(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    async stream() {
      const response = await fetch(`${base}/api/personbot/events`, { signal: AbortSignal.timeout(5_000) });
      return { response, reader: response.body!.getReader() };
    },
  };
}

async function streamEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let data = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) return data;
    data += new TextDecoder().decode(part.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function serveIngress(options: PersonbotIngressOptions) {
  const ingress = createPersonbotIngress(options);
  const ownerGate = vi.fn();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await ingress({ req, res, method: req.method ?? "GET", path: url.pathname, json, readBody })) return;
    ownerGate();
    json(res, 403, { error: "Owner authentication required" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ownerGate,
    async send(path: string, options: RequestInit = {}) {
      const response = await fetch(`${base}${path}`, options);
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

describe("personbot source ingress", () => {
  const token = "s".repeat(48);
  const payload = { eventId: "external-event", threadId: "external-thread", text: "External context only" };
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const trigger = {
    id: "trigger", sourceId: "source", ...payload, receivedAt: "2026-11-05T00:00:00.000Z",
    status: "pending", taskIds: [],
  };
  const sourceGateway = () => ({
    status: vi.fn(() => ({ enabled: true, state: "ready", workspace: "/fixture", provider: "fixture", model: "fixture" } as GatewayStatus)),
    ingest: vi.fn(async (_sourceId: unknown, _token: unknown, _payload: unknown): Promise<unknown> => ({ trigger, duplicate: false })),
  });

  it("accepts source Bearer events without an App identity and waits for durable ingestion before replying", async () => {
    const gateway = sourceGateway();
    const committed = deferred<unknown>();
    gateway.ingest.mockReturnValue(committed.promise);
    const release = vi.fn();
    const claimRequest = vi.fn(() => release);
    const server = await serveIngress({ gateway, claimRequest });
    let responded = false;
    const pending = server.send("/api/personbot/sources/source%20name/events", {
      method: "POST", headers, body: JSON.stringify(payload),
    }).then(response => { responded = true; return response; });
    await vi.waitFor(() => expect(gateway.ingest).toHaveBeenCalledWith("source name", token, payload));
    expect(responded).toBe(false);
    expect(release).not.toHaveBeenCalled();
    committed.resolve({ trigger, duplicate: false });
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ trigger, duplicate: false });
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(claimRequest).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(server.ownerGate).not.toHaveBeenCalled();
  });

  it("requires the source bearer and ignores owner cookies, query credentials and alternate owner headers", async () => {
    const gateway = sourceGateway();
    const server = await serveIngress({ gateway });
    for (const extra of [
      {}, { cookie: ["owner", "session"].join("=") }, { "x-openmaus-secret": token },
      { "x-openmaus-owner-token": token }, { authorization: "Basic owner-token" }, { authorization: "Bearer short" },
    ]) {
      const response = await server.send(`/api/personbot/sources/source/events?token=${token}`, {
        method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Invalid source credentials" });
    }
    expect(gateway.status).not.toHaveBeenCalled();
    expect(gateway.ingest).not.toHaveBeenCalled();
    expect(server.ownerGate).not.toHaveBeenCalled();
  });

  it("keeps every other path and method behind the ordinary owner gate", async () => {
    const gateway = sourceGateway();
    const server = await serveIngress({ gateway });
    for (const [method, path] of [
      ["GET", "/api/personbot/sources/source/events"],
      ["POST", "/api/personbot/rpc"],
      ["POST", "/api/personbot/sources/source/events/"],
      ["POST", "/api/personbot/sources/source/events/other"],
      ["POST", "/api/personbot/sources/source/else"],
      ["POST", "/api/personbot/sources/source/nested/events"],
    ]) {
      expect((await server.send(path, { method, headers, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}) })).status).toBe(403);
    }
    expect(server.ownerGate).toHaveBeenCalledTimes(6);
    expect(gateway.status).not.toHaveBeenCalled();
    expect(gateway.ingest).not.toHaveBeenCalled();
  });

  it("validates exact event fields, JSON content and the body budget before touching the runtime", async () => {
    const gateway = sourceGateway();
    const server = await serveIngress({ gateway });
    for (const body of [
      null, [], "event", {}, { ...payload, sourceId: "other" }, { ...payload, token },
      { ...payload, taskId: "injected" }, { ...payload, goal: "injected" }, { ...payload, callbackUrl: "https://example.invalid" },
      { ...payload, eventId: "" }, { ...payload, threadId: 1 }, { ...payload, text: "x".repeat(32_769) },
    ]) {
      expect((await server.send("/api/personbot/sources/source/events", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await server.send("/api/personbot/sources/source/events", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await server.send("/api/personbot/sources/source/events", {
      method: "POST", headers, body: JSON.stringify({ ...payload, text: "x".repeat(41 * 1024) }),
    })).status).toBe(413);
    expect((await server.send("/api/personbot/sources/source/events", {
      method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: JSON.stringify(payload),
    })).status).toBe(415);
    expect(gateway.ingest).not.toHaveBeenCalled();
  });

  it("returns the same public refusal for unknown sources and incorrect tokens, without reflecting failure details", async () => {
    const gateway = sourceGateway();
    gateway.ingest.mockRejectedValue(new RuntimeRpcError(-32001, `source secret ${token}`));
    const server = await serveIngress({ gateway });
    for (const source of ["source", "missing-source"]) {
      const response = await server.send(`/api/personbot/sources/${source}/events`, {
        method: "POST", headers, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Invalid source credentials" });
    }
    const ownerBearer = await server.send("/api/personbot/sources/source/events", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${"o".repeat(48)}`, cookie: ["owner", "session"].join("=") },
      body: JSON.stringify(payload),
    });
    expect(ownerBearer.status).toBe(401);
    expect(ownerBearer.body).toEqual({ error: "Invalid source credentials" });
  });

  it("does not start a disabled gateway, and sanitizes startup, conflict and read failures", async () => {
    const gateway = sourceGateway();
    gateway.status.mockReturnValue({ ...gateway.status(), enabled: false });
    const server = await serveIngress({ gateway });
    const send = () => server.send("/api/personbot/sources/source/events", { method: "POST", headers, body: JSON.stringify(payload) });
    expect((await send()).status).toBe(503);
    expect(gateway.ingest).not.toHaveBeenCalled();
    gateway.status.mockReturnValue({ ...gateway.status(), enabled: true });
    for (const [error, status, message] of [
      [new Error(`startup failure ${token}`), 503, "Source event service is unavailable"],
      [new RuntimeRpcError(-32000, `conflicting data ${token}`), 409, "Source event could not be accepted"],
      [new ProtocolError(-32602, `bad event ${token}`), 400, "Invalid source event"],
    ] as const) {
      gateway.ingest.mockRejectedValue(error);
      expect(await send()).toMatchObject({ status, body: { error: message } });
    }
  });
});

describe("personbot authenticated routes", () => {
  const artifact = {
    id: "published-report", name: "验收报告.md", mediaType: "text/markdown", size: 11,
    sha256: "0".repeat(64), sessionId: "conversation", originSessionId: "conversation", createdAt: "2026-11-05T00:00:00.000Z",
  };

  it("downloads immutable artifact chunks and permits only escaped text for an inline text preview", async () => {
    const f = fixture();
    f.gateway.request.mockImplementation(async (_method, params) => {
      const offset = (params as { offset: number }).offset;
      const part = offset === 0 ? "hello " : "world";
      return { artifact, offset, nextOffset: offset + part.length, eof: offset !== 0, dataBase64: Buffer.from(part).toString("base64") };
    });
    const server = await serve(f.options, admin);
    const download = await server.content("/api/personbot/artifacts/published-report/content");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(await download.text()).toBe("hello world");
    expect(f.gateway.request.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      { method: "personbot.v1.artifacts.read", params: { artifactId: artifact.id, offset: 0, limit: 512 * 1024 } },
      { method: "personbot.v1.artifacts.read", params: { artifactId: artifact.id, offset: 6, limit: 512 * 1024 } },
    ]);
    const preview = await server.content("/api/personbot/artifacts/published-report/content?inline=1");
    expect(preview.headers.get("content-disposition")).toContain("inline;");
    expect(preview.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await preview.text()).toBe("hello world");
  });

  it.each(["text/html", "image/svg+xml"])("never serves %s as an executable inline preview", async (mediaType) => {
    const f = fixture();
    f.gateway.request.mockResolvedValue({
      artifact: { ...artifact, mediaType, size: 0 }, offset: 0, nextOffset: 0, eof: true, dataBase64: "",
    });
    const response = await (await serve(f.options, admin)).content("/api/personbot/artifacts/published-report/content?inline=1");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("rechecks owner admission after every artifact read and returns no bytes after revocation", async () => {
    const f = fixture();
    const release = deferred<void>();
    f.gateway.request.mockImplementation(async (_method, params) => {
      if ((params as { offset: number }).offset === 0) {
        return { artifact, offset: 0, nextOffset: 6, eof: false, dataBase64: Buffer.from("hello ").toString("base64") };
      }
      await release.promise;
      return { artifact, offset: 6, nextOffset: 11, eof: true, dataBase64: Buffer.from("world").toString("base64") };
    });
    const server = await serve(f.options, admin);
    const request = server.content("/api/personbot/artifacts/published-report/content");
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledTimes(2));
    f.revoke();
    release.resolve();
    const response = await request;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Your session ended" });
  });

  it("rejects non-progressing artifact pages and never accepts a filesystem path", async () => {
    const f = fixture();
    f.gateway.request.mockResolvedValue({
      artifact, offset: 0, nextOffset: 0, eof: false, dataBase64: "",
    });
    const server = await serve(f.options, admin);
    expect((await server.content("/api/personbot/artifacts/published-report/content")).status).toBe(503);
    expect((await server.content("/api/personbot/artifacts/content?path=/etc/passwd")).status).toBe(404);
    expect(f.gateway.request).toHaveBeenCalledOnce();
    expect(requiredScope("GET", "/api/personbot/artifacts/published-report/content")).toBe("admin");
  });

  it("passes unrelated paths, rejects unknown personal endpoints, and reads status without starting dsh", async () => {
    const f = fixture();
    const server = await serve(f.options);
    expect(await server.json("/api/else")).toEqual({ status: 404, body: { passed: true } });
    expect(await server.json("/api/personbot/else")).toMatchObject({ status: 404, body: { error: "Unknown Personbot endpoint" } });
    expect(await server.json("/api/personbot/status")).toEqual({ status: 200, body: f.status });
    expect(f.gateway.start).not.toHaveBeenCalled();
    expect(f.gateway.request).not.toHaveBeenCalled();
    for (const [method, path] of [["GET", "/api/personbot/status"], ["GET", "/api/personbot/events"], ["POST", "/api/personbot/rpc"]]) {
      expect(requiredScope(method, path)).toBe("admin");
    }
  });

  it("refuses client sessions, service loopback, and already revoked owners before touching the gateway", async () => {
    const denied: RequestAuth[] = [
      { ...admin, scopes: ["client"], session: { ...admin.session, scopes: ["client"] } },
      { kind: "loopback", trust: "service", scopes: ["client"] },
    ];
    for (const auth of denied) {
      const f = fixture();
      const server = await serve(f.options, auth);
      expect((await server.json("/api/personbot/status")).status).toBe(403);
      expect((await server.json("/api/personbot/rpc", "POST", { method: "personbot.v1.sessions.list", params: {} })).status).toBe(403);
      expect((await server.content("/api/personbot/artifacts/published-report/content")).status).toBe(403);
      expect(f.gateway.status).not.toHaveBeenCalled();
      expect(f.gateway.request).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.revoke();
    expect((await (await serve(f.options, admin)).json("/api/personbot/status")).status).toBe(403);
  });

  it("validates the HTTP body envelope and passes an admission callback with allowed operations", async () => {
    const f = fixture();
    const server = await serve(f.options, admin);
    for (const body of [null, [], "invalid", { method: "personbot.v1.sessions.list", params: {}, arbitrary: true }]) {
      expect((await server.json("/api/personbot/rpc", "POST", body)).status).toBe(400);
    }
    expect(f.gateway.request).not.toHaveBeenCalled();
    expect(await server.json("/api/personbot/rpc", "POST", { method: "personbot.v1.sessions.list", params: {} }))
      .toEqual({ status: 200, body: { ok: true } });
    const [method, params, admitted] = f.gateway.request.mock.calls[0];
    expect(method).toBe("personbot.v1.sessions.list");
    expect(params).toEqual({});
    expect(admitted?.()).toBe(true);
    f.revoke();
    expect(admitted?.()).toBe(false);
  });

  it.each([
    [new ProtocolError(-32600, "invalid envelope"), 400, -32600],
    [new ProtocolError(-32601, "method not allowed"), 400, -32601],
    [new ProtocolError(-32602, "invalid params"), 400, -32602],
    [new RuntimeRpcError(-32000, "decision expired"), 409, -32000],
    [new ProtocolError(-32001, "session ended"), 401, -32001],
    [new Error("runtime unavailable"), 503, undefined],
  ])("maps runtime failure %s to its HTTP response", async (error, status, code) => {
    const f = fixture();
    f.gateway.request.mockRejectedValue(error);
    const server = await serve(f.options);
    const response = await server.json("/api/personbot/rpc", "POST", { method: "personbot.v1.sessions.list", params: {} });
    expect(response).toEqual({ status, body: { error: error.message, ...(code === undefined ? {} : { code }) } });
  });

  it("rejects a mutation when its session is revoked while runtime startup is pending", async () => {
    const f = fixture();
    const release = deferred<void>();
    let admittedAfterStart: boolean | undefined;
    f.gateway.request.mockImplementation(async (_method, _params, admitted) => {
      await release.promise;
      admittedAfterStart = admitted?.();
      if (!admittedAfterStart) throw new ProtocolError(-32001, "Your session ended");
      return { ok: true };
    });
    const server = await serve(f.options, admin);
    const request = server.json("/api/personbot/rpc", "POST", { method: "personbot.v1.messages.submit", params: {} });
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledOnce());
    f.revoke();
    release.resolve();
    expect(await request).toEqual({ status: 401, body: { error: "Your session ended", code: -32001 } });
    expect(admittedAfterStart).toBe(false);
  });

  it("does not open an SSE subscription for a session revoked during startup", async () => {
    const f = fixture();
    const release = deferred<RuntimeHost>();
    f.gateway.start.mockReturnValue(release.promise);
    const server = await serve(f.options, admin);
    const pending = server.stream();
    await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce());
    f.revoke();
    release.resolve({} as RuntimeHost);
    const { response, reader } = await pending;
    expect(response.status).toBe(401);
    expect(JSON.parse(await streamEnd(reader))).toEqual({ error: "Your session ended" });
    expect(f.gateway.subscribe).not.toHaveBeenCalled();
    expect(f.revoked.size).toBe(0);
  });

  it("ends an existing SSE stream immediately when its owner is revoked and removes both listeners", async () => {
    const f = fixture();
    const server = await serve(f.options, admin);
    const { response, reader } = await server.stream();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('"state":"ready"');
    expect(f.listeners.size).toBe(1);
    expect(f.revoked.size).toBe(1);
    f.revoke();
    expect(await streamEnd(reader)).toBe("");
    expect(f.listeners.size).toBe(0);
    expect(f.revoked.size).toBe(0);
  });

  it.each(["failed", "closing"] as const)("closes SSE and releases listeners on gateway %s", async (state) => {
    const f = fixture();
    const server = await serve(f.options, admin);
    const { reader } = await server.stream();
    await reader.read();
    f.emit({ kind: "gateway", ...f.status, state });
    expect(await streamEnd(reader)).toContain(`"state":"${state}"`);
    expect(f.listeners.size).toBe(0);
    expect(f.revoked.size).toBe(0);
  });

  it("disconnects a client whose response buffer exceeds the bounded replay budget", async () => {
    const f = fixture();
    const server = await serve(f.options, admin);
    const { reader } = await server.stream();
    await reader.read();
    const response = [...server.responses][0];
    Object.defineProperty(response, "writableLength", { configurable: true, value: 4 * 1024 * 1024 + 1 });
    f.emit({ kind: "runtime", event: { generation: "fixture", eventSeq: 1, type: "session.event", sessionId: "fixture", payload: {} } });
    expect(await streamEnd(reader)).toBe("");
    expect(f.listeners.size).toBe(0);
    expect(f.revoked.size).toBe(0);
  });
});
