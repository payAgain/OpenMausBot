import { SUPERAGENT_CAPABILITIES } from "../../shared/superagent-capabilities.ts";
import type { SuperagentBinding, SuperagentGateway, SuperagentTaskState } from "../../shared/superagent.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface Options {
  gateway: SuperagentGateway;
  live(auth: RequestAuth): boolean;
  available(binding: SuperagentBinding): boolean;
  status(): unknown;
  taskUsage?(task: SuperagentTaskState): Promise<unknown>;
}

export function createSuperagentRoutes(options: Options): RouteHandler {
  return async ({ req, res, method, path, url, auth, json, readBody }) => {
    if (!path.startsWith("/api/personbot/")) return PASS;
    if (!ownerOrAdmin(auth) || !options.live(auth)) return json(res, 403, { error: "Super Agent requires owner access" });
    res.setHeader("cache-control", "no-store");
    if (method === "GET" && path === "/api/personbot/status") return json(res, 200, options.status());
    if (method === "GET" && path === "/api/personbot/capabilities") return json(res, 200, SUPERAGENT_CAPABILITIES);
    const inspect = () => options.gateway.inspect?.();
    const reconcile = method === "POST" ? /^\/api\/personbot\/workspaces\/([\w-]{1,128})\/reconcile$/.exec(path) : null;
    if (reconcile) {
      let body: unknown;
      try { body = await readBody(req, 1_024); } catch { return json(res, 400, { error: "Expected an explicit owner acknowledgment" }); }
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || (body as { acknowledge?: unknown }).acknowledge !== "external-processes-reviewed") {
        return json(res, 400, { error: "Review outstanding external operations, then explicitly acknowledge external-processes-reviewed" });
      }
      const released = await options.gateway.releaseWorkspace?.(reconcile[1]!);
      return released ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such quarantined workspace" });
    }
    const taskUsage = method === "GET" ? /^\/api\/personbot\/tasks\/([\w-]{1,128})\/usage$/.exec(path) : null;
    if (taskUsage) {
      const snapshot = await inspect();
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      const task = snapshot?.tasks.find(task => task.ticketId === taskUsage[1] && options.available(task));
      if (!task) return json(res, 404, { error: "The task is no longer available" });
      const usage = await options.taskUsage?.(task) ?? null;
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      if (!options.available(task)) return json(res, 404, { error: "The task is no longer available" });
      return json(res, 200, { ticketId: task.ticketId, usage });
    }
    if (method === "GET" && (path === "/api/personbot/tasks" || path === "/api/personbot/resources")) {
      const snapshot = await inspect();
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      if (!snapshot) return json(res, 503, { error: "Super Agent lifecycle state is unavailable" });
      if (path.endsWith("/resources")) return json(res, 200, snapshot.resources);
      const threadId = url.searchParams.get("threadId");
      return json(res, 200, {
        tasks: snapshot.tasks.filter(task => (!threadId || task.threadId === threadId) && options.available(task)),
        decisions: snapshot.decisions.filter(decision => (!threadId || decision.threadId === threadId) && options.available(decision)),
      });
    }
    const taskStop = /^\/api\/personbot\/tasks\/([\w-]{1,128})\/stop$/.exec(path);
    const threadStop = /^\/api\/personbot\/threads\/([\w-]{1,128})\/stop$/.exec(path);
    if (method === "POST" && (taskStop || threadStop)) {
      const snapshot = await inspect();
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      if (!snapshot) return json(res, 503, { error: "Super Agent lifecycle state is unavailable" });
      if (taskStop) {
        const task = snapshot.tasks.find(task => task.ticketId === taskStop[1] && options.available(task));
        if (!task) return json(res, 404, { error: "The task is no longer available" });
        if (task.ended) return json(res, 409, { error: "The task has already ended" });
        await options.gateway.interrupt(task, { scope: "task", ticketId: task.ticketId });
      } else {
        const bindings = snapshot.bindings.filter(binding => binding.active && binding.threadId === threadStop![1] && options.available(binding));
        if (!bindings.length) return json(res, 404, { error: "The conversation is no longer available" });
        const targets = new Map(bindings.map(binding => [binding.botId, { botId: binding.botId, threadId: binding.threadId }]));
        for (const binding of targets.values()) await options.gateway.interrupt(binding, { scope: "conversation" });
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 410, { error: "This experimental runtime endpoint is retired. Use the original chat and memory APIs with Super Agent." });
  };
}
