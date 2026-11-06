import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/api", async (original) => ({ ...await original<object>(), api: request }));
import { ApiError } from "@/state/api";
import { legacyPath, ProductCommand } from "./personbot-product-client";

beforeEach(() => request.mockReset());

describe("product commands", () => {
  it("replays an ambiguous settings response with the original command and revision", async () => {
    const command = new ProductCommand();
    request.mockRejectedValueOnce(new ApiError("Response lost", 503)).mockResolvedValueOnce({ revision: 2, duplicate: true });
    const input = { expectedRevision: 1, model: "deepseek-flash", apiKey: "fixture-private-key" };
    await expect(command.send("/api/personbot/setup", input)).rejects.toThrow("Response lost");
    await expect(command.send("/api/personbot/setup", input)).resolves.toEqual({ revision: 2, duplicate: true });
    const bodies = request.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].commandId).toBeTruthy();
    expect(bodies[0].expectedRevision).toBe(1);
  });

  it("allocates a different command when the person changes the import or receives a definite rejection", async () => {
    const command = new ProductCommand();
    request.mockRejectedValueOnce(new ApiError("Conflict", 409)).mockResolvedValue({});
    await expect(command.send("/import", { goal: "first" })).rejects.toThrow("Conflict");
    await command.send("/import", { goal: "first" });
    await command.send("/import", { goal: "second" });
    const bodies = request.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(new Set(bodies.map((body) => body.commandId)).size).toBe(3);
  });

  it("preserves opaque thread identifiers inside one path segment", () => {
    expect(legacyPath("old/thread?name=1")).toBe("/api/personbot/legacy/threads/old%2Fthread%3Fname%3D1");
  });
});
