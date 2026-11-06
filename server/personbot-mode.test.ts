import { describe, expect, it } from "vitest";
import { assertLegacyExecutionAllowed, primaryMutationRefused, resolvePersonbotMode } from "./personbot-mode.ts";

describe("Personbot execution ownership", () => {
  const personal = { source: true, hosted: false, cloud: false };

  it("uses dsh by default on personal source installations and keeps rollback explicit", () => {
    expect(resolvePersonbotMode({}, personal)).toEqual({ enabled: true, primary: true });
    expect(resolvePersonbotMode({ PERSONBOT_PRIMARY: "0" }, personal)).toEqual({ enabled: true, primary: false });
    expect(resolvePersonbotMode({ PERSONBOT_ENABLED: "0" }, personal)).toEqual({ enabled: false, primary: false });
    expect(() => resolvePersonbotMode({ PERSONBOT_PRIMARY: "1", PERSONBOT_ENABLED: "0" }, personal)).toThrow();
  });

  it("does not change hosted, Cloud or packaged defaults", () => {
    expect(resolvePersonbotMode({}, { ...personal, hosted: true }).primary).toBe(false);
    expect(resolvePersonbotMode({}, { ...personal, cloud: true }).primary).toBe(false);
    expect(resolvePersonbotMode({}, { ...personal, source: false }).enabled).toBe(false);
    expect(() => resolvePersonbotMode({ PERSONBOT_ENABLED: "1", PERSONBOT_PRIMARY: "1" }, { ...personal, cloud: true })).toThrow();
  });

  it("blocks old send, queue, automation and provider changes before any legacy handler runs", () => {
    for (const path of ["/api/bots/b/send", "/api/routines", "/api/settings/providers", "/api/internal/send", "/api/config", "/api/workspace-backup/restore"]) {
      expect(primaryMutationRefused("POST", path), path).toBe(true);
      expect(primaryMutationRefused("PATCH", path), path).toBe(true);
      expect(primaryMutationRefused("GET", path), path).toBe(false);
    }
    for (const path of ["/api/personbot/rpc", "/api/personbot/setup", "/api/auth/logout", "/api/auth/stream-ticket"]) {
      expect(primaryMutationRefused("POST", path), path).toBe(false);
    }
    expect(primaryMutationRefused("POST", "/api/personbot-legacy/send")).toBe(true);
    expect(() => assertLegacyExecutionAllowed(true)).toThrow("active system");
    expect(() => assertLegacyExecutionAllowed(false)).not.toThrow();
  });

  it("refuses legacy browser and desktop GETs before they can launch or upgrade a controllable viewer", () => {
    for (const path of [
      "/api/bots/b/browser/live", "/api/bots/b/browser/stream", "/api/bots/b/browser/download/f",
      "/api/desktop-viewer/local/shared", "/api/desktop-viewer/local/shared/websockify",
      "/api/desktop-viewer/vps/fixture/websockify",
    ]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect(primaryMutationRefused(method, path), `${method} ${path}`).toBe(true);
    }
    for (const path of ["/api/bots", "/api/bots/b/messages", "/api/personbot/legacy/threads/t", "/api/personbot/setup"]) {
      expect(primaryMutationRefused("GET", path), path).toBe(false);
    }
  });

  it("keeps original chat, memory, profile and paired-device commands on the official native driver", () => {
    for (const path of ["/api/bots", "/api/bots/b/send", "/api/bots/b/stop", "/api/bots/b/respond",
      "/api/bots/b/tasks/t", "/api/threads/t/messages/m", "/api/bots/b/memory/file",
      "/api/config", "/api/personbot/setup", "/api/auth/pairing", "/api/phones/device"]) {
      expect(primaryMutationRefused("POST", path, true), path).toBe(false);
    }
    for (const path of ["/api/instances/claude", "/api/settings/providers", "/api/routines", "/api/internal/send",
      "/api/personbot/rpc", "/api/personbot/integrations/source", "/api/bots/b/browser/live"]) {
      expect(primaryMutationRefused("POST", path, true), path).toBe(true);
    }
  });
});
