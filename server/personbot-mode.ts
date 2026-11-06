export interface PersonbotMode {
  enabled: boolean;
  primary: boolean;
}

export const PERSONBOT_PRIMARY_REFUSAL = "Personbot is the active system. Open legacy history in Personbot and import the work you want to continue.";
export const SUPERAGENT_PRIMARY_REFUSAL = "The official Super Agent owns execution. This legacy control is unavailable in the current profile.";

export function resolvePersonbotMode(
  env: NodeJS.ProcessEnv,
  context: { source: boolean; hosted: boolean; cloud: boolean },
): PersonbotMode {
  const enabled = env.PERSONBOT_ENABLED === "1"
    || (env.PERSONBOT_ENABLED !== "0" && context.source && !context.hosted && !context.cloud);
  const primary = enabled && !context.hosted && !context.cloud && env.PERSONBOT_PRIMARY !== "0";
  if (env.PERSONBOT_PRIMARY === "1" && !primary) {
    throw new Error("Personbot primary mode requires an enabled personal runtime outside hosted or Cloud workspaces.");
  }
  return { enabled, primary };
}

/** Official primary mode retains product APIs while preventing a second execution backend. */
export function primaryMutationRefused(method: string, path: string, officialSuperagent = false): boolean {
  if (/^\/api\/bots\/[^/]+\/browser(?:\/|$)/.test(path) || path.startsWith("/api/desktop-viewer/")) return true;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (!path.startsWith("/api/")) return false;
  if (officialSuperagent) {
    if (path === "/api/config" || path === "/api/bots" || /^\/api\/bots\/[^/]+(?:\/(?:send|stop|interrupt|respond|answer|messages|queue|tasks|threads|projects|memory|settings|profile|model|approval|permissions|read|archive|pin|reaction|rewind|active-branch|edit|title|order|main-thread|always-allow|command-allowlist)(?:\/|$)|$)/.test(path)
      || /^\/api\/threads\/[^/]+(?:\/|$)/.test(path)
      || path.startsWith("/api/auth/") || path.startsWith("/api/personbot/setup")
      || /^\/api\/personbot\/(?:tasks|threads)\/[\w-]{1,128}\/stop$/.test(path)
      || /^\/api\/personbot\/workspaces\/[\w-]{1,128}\/reconcile$/.test(path)
      || path.startsWith("/api/phone/") || path.startsWith("/api/phones/")
      || path.startsWith("/api/sessions/") || path === "/api/pair"
      || path.startsWith("/api/notifications/") || path.startsWith("/api/stop-line")) return false;
    return true;
  }
  return !path.startsWith("/api/personbot/") && !path.startsWith("/api/auth/");
}

export function assertLegacyExecutionAllowed(primary: boolean): void {
  if (primary) throw Object.assign(new Error(PERSONBOT_PRIMARY_REFUSAL), { status: 409, code: "personbot_primary" });
}
