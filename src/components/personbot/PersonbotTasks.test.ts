import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskSnapshot } from "../../../packages/personbot-protocol/src/index.ts";
import { PersonbotTasks } from "./PersonbotTasks";

const task: TaskRecord = {
  id: "research", originSessionId: "conversation", workerSessionId: "worker-research",
  goal: "核对原生任务恢复", criteria: ["运行隔离测试", "记录恢复结果"], context: "仅使用临时目录",
  revision: 4, createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z",
  lifecycle: "open", stage: "awaiting_review", currentExecutionId: "execution",
  report: { outcome: "review", summary: "**恢复测试通过**，等待用户验收。", evidence: ["fixture：3/3 通过"] },
};

function render(value: TaskRecord, overrides: Partial<TaskSnapshot> = {}) {
  return renderToStaticMarkup(createElement(PersonbotTasks, {
    snapshot: { tasks: [value], executions: [], updates: [], ...overrides },
    client: { select: vi.fn(async () => {}), createTask: vi.fn(async () => true), controlTask: vi.fn(async () => true) },
    selectedId: "conversation", originSessionId: "conversation", disabled: false, action: null,
  }));
}

describe("Personbot persistent task controls", () => {
  it("shows completion criteria and worker evidence alongside explicit human acceptance", () => {
    const html = render(task);
    expect(html).toContain("等待验收");
    expect(html).toContain("运行隔离测试");
    expect(html).toContain("<strong>恢复测试通过</strong>");
    expect(html).toContain("fixture：3/3 通过");
    expect(html).toContain("验收通过");
    expect(html).toContain("要求修改");
    expect(html).toContain("查看任务会话");
    expect(html).not.toContain("已验收完成");
    expect(html.indexOf("fixture：3/3 通过")).toBeLessThan(html.indexOf("验收通过</button>"));
  });

  it("preserves unknown execution meaning and offers a deliberate continuation", () => {
    const html = render({ ...task, stage: "blocked", report: undefined }, {
      executions: [{
        id: "execution", taskId: task.id, sessionId: task.workerSessionId, inputMessageId: "input",
        createdAt: task.createdAt, status: "ended", outcome: "unknown",
      }],
    });
    expect(html).toContain("需要核对");
    expect(html).toContain("上次执行的部分操作可能已经生效");
    expect(html).toContain("继续执行说明");
    expect(html).toContain("继续任务");
    expect(html).not.toContain("验收通过</button>");
  });

  it("does not offer continuation while a paused worker is still stopping", () => {
    const html = render({ ...task, stage: "paused" }, {
      executions: [{
        id: "execution", taskId: task.id, sessionId: task.workerSessionId, inputMessageId: "input",
        createdAt: task.createdAt, status: "stopping",
      }],
    });
    expect(html).toContain("正在停止执行");
    expect(html).toMatch(/disabled=""[^>]*>继续任务<\/button>/);
  });

  it("removes execution controls after accepted completion", () => {
    const html = render({ ...task, lifecycle: "completed" });
    expect(html).toContain("已验收完成");
    expect(html).not.toContain("暂停任务</button>");
    expect(html).not.toContain("终止任务</button>");
    expect(html).not.toContain("验收通过</button>");
    expect(html).toContain("返回来源会话");
  });

  it("blocks acceptance while a reported execution still has a pending native drain", () => {
    const html = render({ ...task, stopState: "pending" }, {
      executions: [{
        id: "execution", taskId: task.id, sessionId: task.workerSessionId, inputMessageId: "input",
        createdAt: task.createdAt, status: "ended", outcome: "unknown",
      }],
    });
    expect(html).toContain("正在停止执行");
    expect(html).toMatch(/disabled=""[^>]*>验收通过<\/button>/);
    expect(html).toMatch(/disabled=""[^>]*>要求修改<\/button>/);
  });

  it.each(["open", "cancelled"] as const)("offers an explicit stop retry after an unconfirmed drain for %s tasks", (lifecycle) => {
    const html = render({ ...task, lifecycle, stage: "paused", stopState: "unknown" });
    expect(html).toContain("停止未确认");
    expect(html).toContain("原有操作结果仍需核对");
    expect(html).toContain("重试停止任务</button>");
    if (lifecycle === "open") expect(html).toMatch(/disabled=""[^>]*>继续任务<\/button>/);
    else expect(html).not.toContain("继续任务</button>");
  });

  it("retains historical unknown effects after cancellation and a confirmed current drain", () => {
    const html = render({ ...task, lifecycle: "cancelled", stage: "paused", stopState: "confirmed" }, {
      executions: [
        {
          id: "previous", taskId: task.id, sessionId: task.workerSessionId, inputMessageId: "previous-input",
          createdAt: task.createdAt, status: "ended", outcome: "unknown", effectsUnknown: true,
        },
        {
          id: "execution", taskId: task.id, sessionId: task.workerSessionId, inputMessageId: "input",
          createdAt: task.createdAt, status: "ended", outcome: "cancelled",
        },
      ],
    });
    expect(html).toContain("已终止");
    expect(html).toContain("历史执行的部分外部操作结果仍未确认");
    expect(html).toContain("停止确认不会撤销或核实这些操作");
    expect(html).not.toContain("重试停止任务</button>");
    expect(html).not.toContain("停止未确认");
  });

  it("offers supplementary input only to active workers and displays the stable workspace", () => {
    const html = render({
      ...task, stage: "working", report: undefined,
      workspace: { kind: "git-worktree", path: "/fixture/task", sourcePath: "/fixture/source", projectId: "project" },
      messages: [{ id: "note", text: "Keep the original report scope", createdAt: task.createdAt }],
    });
    expect(html).toContain("补充任务说明");
    expect(html).toContain("发送补充说明");
    expect(html).toContain("独立 Git 工作树");
    expect(html).toContain("/fixture/source");
    expect(html).toContain("Keep the original report scope");
    expect(render(task)).not.toContain("发送补充说明");
    expect(render({ ...task, lifecycle: "cancelled", stage: "working" })).not.toContain("发送补充说明");
  });
});
