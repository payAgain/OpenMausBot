import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayStatus } from "../../packages/personbot-gateway/src/index.ts";
import { json, readBody } from "../harness/http.ts";
import { PersonbotSettings } from "../personbot-settings.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "./table.ts";
import { createPersonbotSetupRoutes } from "./personbot-setup.ts";

const directories: string[] = [];
const servers: Server[] = [];
const key = "fixture-model-settings-secret-never-reflect";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(primary = true) {
  const home = mkdtempSync(join(tmpdir(), "personbot-setup-route-"));
  directories.push(home);
  const settings = new PersonbotSettings({ home, workspace: join(home, "workspace"), env: {} });
  let live = true;
  let auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const status: GatewayStatus = { enabled: true, state: "stopped", workspace: join(home, "workspace"), provider: "deepseek-official", model: "deepseek-flash" };
  const route = createPersonbotSetupRoutes({ settings, gateway: { status: () => status }, primary, live: () => live });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!await dispatchRoutes([route], { req, res, method: req.method ?? "GET", path: url.pathname, url, auth, json, readBody })) {
      json(res, 404, { error: "Not found" });
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    settings,
    status,
    revoke: () => { live = false; },
    member: () => { auth = { kind: "loopback", trust: "service", scopes: ["client"] }; },
    async request(method = "GET", body?: unknown, path = "/api/personbot/setup") {
      const response = await fetch(`${base}${path}`, {
        method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

describe("Personbot setup owner routes", () => {
  it("reads initial setup without launching dsh and only reports write-only credential presence after save", async () => {
    const app = await fixture();
    const before = await app.request();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ primary: true, revision: 0, runtime: { state: "stopped" }, credential: { configured: false, source: "missing" } });
    expect(before.headers.get("cache-control")).toBe("no-store");
    const input = { commandId: "save", expectedRevision: 0, model: "deepseek-v4-pro", apiKey: key };
    expect(await app.request("POST", input)).toMatchObject({ status: 200, body: { revision: 1, duplicate: false, restartRequired: false } });
    expect(await app.request("POST", input)).toMatchObject({ status: 200, body: { revision: 1, duplicate: true } });
    const after = await app.request();
    expect(after.body).toMatchObject({ model: "deepseek-v4-pro", revision: 1, credential: { configured: true, source: "saved" }, runtime: { state: "stopped" } });
    expect(JSON.stringify(after.body)).not.toContain(key);
  });

  it("enforces owner access and current session before reading or saving settings", async () => {
    const app = await fixture();
    app.member();
    expect((await app.request()).status).toBe(403);
    expect((await app.request("POST", { commandId: "save", expectedRevision: 0, model: "deepseek-flash", apiKey: key })).status).toBe(403);
    const ended = await fixture();
    ended.revoke();
    expect((await ended.request()).status).toBe(403);
    expect((await ended.request("POST", { commandId: "save", expectedRevision: 0, model: "deepseek-flash", apiKey: key })).status).toBe(403);
  });

  it("lets current legacy members discover the shell without revealing settings or granting writes", async () => {
    const app = await fixture(false);
    app.settings.save({ commandId: "owner-save", expectedRevision: 0, model: "deepseek-v4-pro", apiKey: key });
    app.member();
    expect(await app.request()).toMatchObject({ status: 200, body: { primary: false } });
    expect((await app.request()).body).toEqual({ primary: false });
    expect((await app.request("POST", { commandId: "member-save", expectedRevision: 1, model: "deepseek-flash" })).status).toBe(403);
    app.revoke();
    expect((await app.request()).status).toBe(403);
  });

  it("rejects malformed, oversized and stale settings without reflecting credentials", async () => {
    const app = await fixture();
    for (const input of [
      { commandId: "bad", expectedRevision: 0, model: "deepseek-flash", apiKey: key, arbitrary: key },
      { commandId: "large", expectedRevision: 0, model: "deepseek-flash", apiKey: key.repeat(1000) },
      { commandId: "stale", expectedRevision: 7, model: "deepseek-flash", apiKey: key },
    ]) {
      const response = await app.request("POST", input);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).not.toContain(key);
    }
    expect((await app.request("DELETE")).status).toBe(405);
    expect((await app.request("GET", undefined, "/api/personbot/not-setup")).status).toBe(404);
  });
});
