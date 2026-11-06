import type { PersonbotGateway } from "../../packages/personbot-gateway/src/index.ts";
import type { PersonbotSetupSaveResult } from "../../shared/personbot-product.ts";
import { PersonbotSettings, PersonbotSettingsError } from "../personbot-settings.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PersonbotSetupRouteOptions {
  settings: PersonbotSettings;
  gateway: Pick<PersonbotGateway, "status">;
  primary: boolean;
  live(auth: RequestAuth): boolean;
}

export function createPersonbotSetupRoutes(options: PersonbotSetupRouteOptions): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/personbot/setup") return PASS;
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (!options.live(auth)) return json(res, 403, { error: "Personbot requires owner access" });
    if (method === "GET" && !options.primary && !ownerOrAdmin(auth)) return json(res, 200, { primary: false });
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Personbot requires owner access" });
    const snapshot = () => options.settings.snapshot({ primary: options.primary, runtime: options.gateway.status() });
    if (method === "GET") return json(res, 200, snapshot());
    if (method !== "POST") return json(res, 405, { error: "Use GET or POST for model settings" });
    try {
      if (!options.gateway.status().enabled) return json(res, 503, { error: "Personbot is disabled" });
      const body: unknown = await readBody(req, 16 * 1024);
      if (!options.live(auth)) return json(res, 401, { error: "Your session ended" });
      const receipt = options.settings.save(body);
      const result: PersonbotSetupSaveResult = { ...receipt, restartRequired: snapshot().restartRequired };
      return json(res, 200, result);
    } catch (error) {
      const status = error instanceof PersonbotSettingsError ? error.status
        : Number((error as { status?: unknown } | null)?.status) === 413 ? 413
          : Number((error as { status?: unknown } | null)?.status) === 400 ? 400 : 503;
      return json(res, status, {
        error: error instanceof PersonbotSettingsError ? error.message
          : status === 413 ? "Model settings exceed 16 KiB"
            : status === 400 ? "Invalid model settings" : "Model settings could not be saved",
      });
    }
  };
}
