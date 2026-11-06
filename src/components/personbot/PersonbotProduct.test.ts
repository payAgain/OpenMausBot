// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonbotSetup } from "../../../shared/personbot-product.ts";

const { start, suspend, dispose, request } = vi.hoisted(() => ({
  start: vi.fn(), suspend: vi.fn(), dispose: vi.fn(), request: vi.fn(),
}));
vi.mock("@/state/api", () => ({ api: request }));
vi.mock("@/lib/personbot-client", () => ({
  PersonbotClient: class {
    subscribe = () => () => {};
    getSnapshot = () => snapshot;
    start = start;
    suspend = suspend;
    dispose = dispose;
    retry = vi.fn();
    select = vi.fn();
  },
}));
vi.mock("./PersonbotView", () => ({ PersonbotView: ({ section }: { section: string }) => createElement("div", { "data-native-view": section }, "Native chat") }));
import { PersonbotProduct } from "./PersonbotProduct";

const snapshot = { tasks: { tasks: [] }, connection: "connected" };
let root: Root;
let host: HTMLDivElement;
const setup: PersonbotSetup = {
  primary: true, revision: 1, model: "deepseek-flash", provider: "deepseek-official",
  workspace: "/fixture/workspace", credential: { configured: false, source: "missing" }, restartRequired: false,
  runtime: { enabled: true, state: "stopped", workspace: "/fixture/workspace", provider: "deepseek-official", model: "deepseek-flash" },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the primary Personbot product", () => {
  it("opens model setup without launching native execution when credentials are missing", async () => {
    await act(async () => root.render(createElement(PersonbotProduct, { initialSetup: setup })));
    expect(host.querySelector("h1")?.textContent).toBe("模型设置");
    expect(host.querySelector('input[aria-label="DeepSeek API key"]')?.getAttribute("type")).toBe("password");
    expect(start).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-native-view]")).toBeNull();
  });

  it("keeps the native view mounted while opening model settings and offers only product destinations", async () => {
    await act(async () => root.render(createElement(PersonbotProduct, { initialSetup: { ...setup, credential: { configured: true, source: "environment" } } })));
    const native = host.querySelector("[data-native-view]");
    expect(native?.getAttribute("data-native-view")).toBe("chat");
    expect(start).toHaveBeenCalledOnce();
    await act(async () => (host.querySelector('[data-personbot-nav="setup"]') as HTMLButtonElement).click());
    expect(host.querySelector("[data-native-view]")).toBe(native);
    expect(host.querySelector('nav[aria-label="Personbot 导航"]')?.textContent).toContain("旧历史");
    expect(host.querySelector('nav[aria-label="Personbot 导航"]')?.textContent).not.toContain("引擎");
    expect(host.querySelector("[data-sidebar-nav]")).toBeNull();
  });
});
