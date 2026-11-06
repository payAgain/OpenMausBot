import { api, ApiError } from "@/state/api";
export type { PersonbotProductBootstrap, PersonbotSetup } from "../../shared/personbot-product.ts";
export type {
  PersonbotLegacyThread as LegacyThread, PersonbotLegacyList as LegacyPage, PersonbotLegacyDetail as LegacyDetail,
} from "../../shared/personbot-legacy.ts";
import type { PersonbotProductBootstrap, PersonbotSetup } from "../../shared/personbot-product.ts";
import type { SuperagentCapabilities } from "../../shared/superagent-capabilities.ts";
import type { SuperagentSnapshot } from "../../shared/superagent.ts";

export class ProductCommand {
  private pending?: { signature: string; commandId: string };

  async send<T>(path: string, payload: object, signal?: AbortSignal): Promise<T> {
    const signature = JSON.stringify([path, payload]);
    if (this.pending?.signature !== signature) this.pending = { signature, commandId: crypto.randomUUID() };
    const pending = this.pending;
    try {
      const result = await api<T>(path, {
        method: "POST", body: JSON.stringify({ ...payload, commandId: pending.commandId }), signal, timeoutMs: 60_000,
      });
      if (this.pending === pending) this.pending = undefined;
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && this.pending === pending) this.pending = undefined;
      throw error;
    }
  }

  clear(): void { this.pending = undefined; }
}

export function readProductSetup(signal?: AbortSignal): Promise<PersonbotSetup> {
  return api<PersonbotSetup>("/api/personbot/setup", { signal, timeoutMs: 10_000 });
}

export function readProductBootstrap(signal?: AbortSignal): Promise<PersonbotProductBootstrap> {
  return api<PersonbotProductBootstrap>("/api/personbot/setup", { signal, timeoutMs: 10_000 });
}

export function readSuperagentCapabilities(signal?: AbortSignal): Promise<SuperagentCapabilities> {
  return api<SuperagentCapabilities>("/api/personbot/capabilities", { signal, timeoutMs: 10_000 });
}

export function readSuperagentResources(signal?: AbortSignal): Promise<SuperagentSnapshot["resources"]> {
  return api<SuperagentSnapshot["resources"]>("/api/personbot/resources", { signal, timeoutMs: 10_000 });
}

export function reconcileSuperagentWorkspace(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/personbot/workspaces/${encodeURIComponent(id)}/reconcile`, {
    method: "POST", body: JSON.stringify({ acknowledge: "external-processes-reviewed" }), timeoutMs: 10_000,
  });
}
export function legacyPath(threadId: string): string {
  return `/api/personbot/legacy/threads/${encodeURIComponent(threadId)}`;
}
