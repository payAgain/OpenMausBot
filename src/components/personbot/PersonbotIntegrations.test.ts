// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDeliveryRecord, SourceRecord, TaskRecord } from "../../../packages/personbot-protocol/src/index.ts";
import {
  ChannelDelivery, generateSourceToken, localScheduleTime, PersonbotIntegrations, ScheduleForm, SourceForm, sourceEndpoint, SubscriptionForm,
} from "./PersonbotIntegrations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const client = {
  saveSource: vi.fn(async (_input: unknown) => true), saveSchedule: vi.fn(async () => true), saveSubscription: vi.fn(async () => true),
  controlDelivery: vi.fn(async () => true), select: vi.fn(async () => {}),
};
const time = "2026-11-05T10:00:00.000Z";
const source: SourceRecord = {
  id: "source", name: "Fixture events", originSessionId: "origin", enabled: false, goal: "Review event",
  criteria: ["Ask for acceptance"], callbackMode: "at-most-once", revision: 2, createdAt: time, updatedAt: time,
};
const task: TaskRecord = {
  id: "task", originSessionId: "origin", workerSessionId: "worker", goal: "Same-origin task", criteria: ["Review"], context: "",
  revision: 1, lifecycle: "open", stage: "waiting_event", createdAt: time, updatedAt: time,
};

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async (element: ReactElement) => { await act(async () => root.render(element)); };
const click = async (name: string) => {
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
};
const fill = async (name: string, value: string) => {
  const input = host.querySelector(`[aria-label="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); };

describe("Personbot events and channels", () => {
  it("keeps loading and first-use states distinct and makes the new entry discoverable", async () => {
    await render(createElement(PersonbotIntegrations, { client, origins: [], tasks: [], disabled: false }));
    expect(host.textContent).toContain("事件与渠道");
    expect(host.textContent).toContain("正在读取事件与渠道配置");
    expect(host.textContent).not.toContain("还没有事件来源");
    await render(createElement(PersonbotIntegrations, { client, origins: [], tasks: [], disabled: false, snapshot: { sources: [], schedules: [], subscriptions: [], triggers: [], deliveries: [] } }));
    expect(host.textContent).toContain("先建立一个会话");
    expect(host.textContent).toContain("添加后，手动启用");
    expect([...host.querySelectorAll("button")].find((button) => button.textContent === "添加来源")?.disabled).toBe(true);
  });

  it("generates a cryptographic write-only token on request, creates sources off, and clears the token after acceptance", async () => {
    const done = vi.fn();
    await render(createElement(SourceForm, { origins: [{ id: "origin", name: "Fixture" }], originSessionId: "origin", client, disabled: false, done }));
    expect(host.querySelector('[aria-label="本次来源令牌"]')).toBeNull();
    expect((host.querySelector('[aria-label="启用事件来源"]') as HTMLInputElement).checked).toBe(false);
    await fill("来源名称", "Fixture");
    await fill("新任务目标", "Review event");
    await fill("事件任务验收标准", "Check sources\nAsk for acceptance");
    await click("生成来源令牌");
    const token = (host.querySelector('[aria-label="本次来源令牌"]') as HTMLInputElement).value;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(host.textContent).toContain("保存后不能再次查看");
    await submit();
    expect(client.saveSource).toHaveBeenCalledWith({
      name: "Fixture", originSessionId: "origin", goal: "Review event", criteria: ["Check sources", "Ask for acceptance"],
      callbackMode: "at-most-once", enabled: false, token,
    });
    expect(done).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="本次来源令牌"]')).toBeNull();
    expect(generateSourceToken()).not.toBe(generateSourceToken());
  });

  it("preserves an existing token during an edit and sends a new token only after explicit rotation", async () => {
    await render(createElement(SourceForm, { source, origins: [{ id: "origin", name: "Fixture" }], client, disabled: false, done: vi.fn() }));
    expect((host.querySelector('[aria-label="来源会话"]') as HTMLSelectElement).disabled).toBe(true);
    await submit();
    expect(client.saveSource.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(client.saveSource).toHaveBeenCalledWith(expect.objectContaining({ id: source.id, revision: 2, enabled: false }));
    await click("轮换来源令牌");
    const token = (host.querySelector('[aria-label="本次来源令牌"]') as HTMLInputElement).value;
    await submit();
    expect(client.saveSource).toHaveBeenLastCalledWith(expect.objectContaining({ token, revision: 2 }));
  });

  it("keeps locally generated tokens available when the save result is ambiguous", async () => {
    client.saveSource.mockResolvedValueOnce(false);
    const done = vi.fn();
    await render(createElement(SourceForm, { source, origins: [{ id: "origin", name: "Fixture" }], client, disabled: false, done }));
    await click("轮换来源令牌");
    const token = (host.querySelector('[aria-label="本次来源令牌"]') as HTMLInputElement).value;
    await submit();
    expect(done).not.toHaveBeenCalled();
    expect((host.querySelector('[aria-label="本次来源令牌"]') as HTMLInputElement).value).toBe(token);
  });

  it("converts local schedule time to an ISO instant and enforces a minimum one-minute interval", async () => {
    await render(createElement(ScheduleForm, { sources: [source], client, disabled: false, done: vi.fn() }));
    await fill("定时名称", "Fixture schedule");
    await fill("定时事件线程", "thread-1");
    await fill("定时事件内容", "Review the latest event");
    await fill("首次执行时间", "2026-11-05T22:17");
    await fill("重复间隔分钟", "0.5");
    await submit();
    expect(client.saveSchedule).not.toHaveBeenCalled();
    expect(host.textContent).toContain("重复间隔至少为 1 分钟");
    await fill("重复间隔分钟", "2");
    await submit();
    expect(client.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: source.id, threadId: "thread-1", runAt: new Date("2026-11-05T22:17").toISOString(), intervalSeconds: 120, enabled: false,
    }));
    expect(localScheduleTime(new Date("2026-11-05T22:17").toISOString())).toBe("2026-11-05T22:17");
  });

  it("offers only tasks bound to the selected source origin", async () => {
    await render(createElement(SubscriptionForm, {
      sources: [source], tasks: [task, { ...task, id: "other", originSessionId: "other-origin", goal: "Unrelated private task" }],
      client, disabled: false, done: vi.fn(),
    }));
    expect(host.textContent).toContain(task.goal);
    expect(host.textContent).not.toContain("Unrelated private task");
    await fill("接收事件的任务", task.id);
    await fill("订阅事件线程", "thread-2");
    await submit();
    expect(client.saveSubscription).toHaveBeenCalledWith({ sourceId: source.id, taskId: task.id, threadId: "thread-2", enabled: true });
    await render(createElement(SubscriptionForm, {
      sources: [source], tasks: [task], client, disabled: false, done: vi.fn(),
      subscription: { id: "subscription", sourceId: source.id, threadId: "thread-2", taskId: task.id, enabled: true, revision: 1, createdAt: time, updatedAt: time },
    }));
    for (const name of ["订阅来源", "订阅事件线程", "接收事件的任务"]) {
      expect((host.querySelector(`[aria-label="${name}"]`) as HTMLInputElement).disabled).toBe(true);
    }
    expect(host.textContent).toContain("来源、线程与任务绑定已固定");
  });

  it("requires a visible duplicate-risk confirmation before retrying an uncertain callback", async () => {
    const delivery: ChannelDeliveryRecord = {
      id: "delivery", sourceId: source.id, threadId: "thread", taskId: task.id, updateId: "update", url: "http://127.0.0.1:9999/callback",
      mode: "at-most-once", state: "uncertain", attempts: 1, createdAt: time, updatedAt: time, payload: { text: "Fixture report" },
    };
    await render(createElement(ChannelDelivery, { delivery, client, disabled: false, task }));
    expect(host.textContent).toContain("送达情况不明确");
    await click("手动重试回调");
    expect(client.controlDelivery).not.toHaveBeenCalled();
    expect(host.textContent).toContain("再次发送可能产生重复结果");
    await click("确认重试，可能重复");
    expect(client.controlDelivery).toHaveBeenCalledWith(delivery, "retry");
    expect(host.textContent).not.toContain("确认重试，可能重复");
    await render(createElement(ChannelDelivery, { delivery: { ...delivery, state: "delivered" }, client, disabled: false, task }));
    expect(host.textContent).not.toContain("手动重试回调");
    expect(host.textContent).not.toContain("确认已经送达");
  });

  it("builds an encoded endpoint and keeps hostile event content as plain text", async () => {
    expect(sourceEndpoint("id/with?#", "http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321/api/personbot/sources/id%2Fwith%3F%23/events");
    await render(createElement(PersonbotIntegrations, {
      client, origins: [], tasks: [task], disabled: false,
      snapshot: { sources: [source], subscriptions: [], schedules: [], deliveries: [], triggers: [{
        id: "event", sourceId: source.id, eventId: "<img onerror=alert(1)>", threadId: "thread", text: "<script>external()</script>",
        receivedAt: time, status: "delivered", taskIds: [task.id],
      }] },
    }));
    await click("最近事件");
    expect(host.textContent).toContain("<script>external()</script>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    await click(`查看任务：${task.goal}`);
    expect(client.select).toHaveBeenCalledWith(task.workerSessionId);
  });
});
