import type { PersonbotLegacy } from "../personbot-legacy.ts";
import { PersonbotLegacyError } from "../personbot-legacy.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PersonbotLegacyRouteOptions {
  legacy: PersonbotLegacy;
  enabled(): boolean;
  live(auth: RequestAuth): boolean;
  visible?(auth: RequestAuth): (threadId: string) => boolean;
}

export function createPersonbotLegacyRoutes(options: PersonbotLegacyRouteOptions): RouteHandler {
  return async ({ req, res, method, path, url, auth, json, readBody }) => {
    if (path !== "/api/personbot/legacy" && !path.startsWith("/api/personbot/legacy/")) return PASS;
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (!options.enabled() || !ownerOrAdmin(auth) || !options.live(auth)) {
      return json(res, 403, { error: "Archived history requires the local Personbot owner's access" });
    }
    const visible = options.visible?.(auth) ?? (() => true);
    try {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (path === "/api/personbot/legacy" && method === "GET") return json(res, 200, options.legacy.list(cursor, visible));
      const match = /^\/api\/personbot\/legacy\/threads\/([^/]+)(\/import)?$/.exec(path);
      if (!match) return json(res, 404, { error: "Unknown archived history endpoint" });
      const threadId = decodeURIComponent(match[1]!);
      if (!threadId || threadId.length > 256 || threadId.includes("\0")) throw new PersonbotLegacyError(400, "Invalid archived thread identity");
      if (!match[2] && method === "GET") return json(res, 200, options.legacy.detail(threadId, cursor, visible));
      if (match[2] && method === "POST") {
        const body: unknown = await readBody(req, 40 * 1024);
        const result = await options.legacy.import(threadId, body, () => options.live(auth), visible);
        return json(res, 200, result);
      }
      return json(res, 405, { error: "Archived history is read-only; use the explicit import endpoint to continue" });
    } catch (error) {
      const status = error instanceof PersonbotLegacyError ? error.status
        : error instanceof URIError ? 400 : (error as { status?: number })?.status === 413 ? 413 : 503;
      return json(res, status, { error: status === 503 ? "Archived history could not be loaded or imported; retry the same import" : error instanceof Error ? error.message : "Invalid archived history request" });
    }
  };
}
