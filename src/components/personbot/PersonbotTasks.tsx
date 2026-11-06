import { useState, type FormEvent } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import type { PersonbotClient } from "@/lib/personbot-client";
import type { TaskRecord, TaskSnapshot } from "../../../packages/personbot-protocol/src/index.ts";

const BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[14px] text-ink transition-colors enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INPUT = "mt-2 min-h-11 w-full rounded-lg border border-hairline bg-app px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const STAGE: Record<TaskRecord["stage"], string> = {
  queued: "等待执行", working: "执行中", waiting_event: "等待唤醒", waiting_person: "等待你的决定",
  awaiting_review: "等待验收", paused: "已暂停", blocked: "需要核对", failed: "执行失败",
};

export function taskStatus(task: TaskRecord): string {
  return task.lifecycle === "completed" ? "已验收完成" : task.lifecycle === "cancelled" ? "已终止" : STAGE[task.stage];
}

type TaskClient = Pick<PersonbotClient, "createTask" | "controlTask" | "select">;

function TaskCard({ task, snapshot, client, selectedId, disabled, action }: {
  task: TaskRecord;
  snapshot: TaskSnapshot;
  client: TaskClient;
  selectedId: string | null;
  disabled: boolean;
  action: string | null;
}) {
  const [instruction, setInstruction] = useState("");
  const execution = snapshot.executions.find((entry) => entry.id === task.currentExecutionId);
  const effectsUnknown = snapshot.executions.some((entry) => entry.taskId === task.id && entry.effectsUnknown);
  const stopping = execution?.status === "stopping" || task.stopState === "pending";
  const stopUnknown = task.stopState === "unknown";
  const open = task.lifecycle === "open";
  const canResume = open && ["paused", "blocked", "failed", "waiting_event"].includes(task.stage);
  const canPause = open && ["queued", "working", "waiting_person", "waiting_event"].includes(task.stage);
  const review = open && task.stage === "awaiting_review";
  const canSupplement = open && ["queued", "working", "waiting_person"].includes(task.stage);
  const update = snapshot.updates.findLast((entry) => entry.taskId === task.id);
  const busy = action?.startsWith(`task:${task.id}:`);
  const control = async (next: Parameters<TaskClient["controlTask"]>[1]) => {
    if (await client.controlTask(task, next, instruction.trim() || undefined)) setInstruction("");
  };
  return (
    <details data-personbot-task={task.id} open={selectedId === task.workerSessionId || review} className="personbot-task border-t border-hairline py-1">
      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 text-[14px]">
        <span className="min-w-0 flex-1 break-words font-medium">{task.goal}</span>
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-ink-secondary" data-personbot-task-status={task.id}>
          {busy && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
          {stopping ? "正在停止执行" : stopUnknown ? `${taskStatus(task)} · 停止未确认` : taskStatus(task)}
        </span>
      </summary>
      <div className="space-y-3 pb-3 pt-1 text-[13px]">
        <div>
          <p className="font-medium text-ink">完成条件</p>
          <ol className="mt-1 list-decimal space-y-1 ps-5 text-ink-secondary">{task.criteria.map((criterion, index) => <li key={index} className="whitespace-pre-wrap break-words">{criterion}</li>)}</ol>
        </div>
        {task.context && <details className="text-ink-secondary"><summary className="min-h-8 cursor-pointer">任务上下文</summary><p className="whitespace-pre-wrap break-words pt-1">{task.context}</p></details>}
        {task.workspace && <div className="space-y-1 text-ink-secondary">
          <p>任务目录：<span className="break-all">{task.workspace.path}</span></p>
          <p>项目来源：<span className="break-all">{task.workspace.sourcePath}</span>{task.workspace.kind === "git-worktree" ? " · 独立 Git 工作树" : " · 独立输出目录"}</p>
        </div>}
        {!!task.messages?.length && <details className="text-ink-secondary"><summary className="min-h-8 cursor-pointer">补充说明 · {task.messages.length}</summary><ul className="space-y-2 pt-2">{task.messages.map((message) => <li key={message.id} className="whitespace-pre-wrap break-words">{message.text}</li>)}</ul></details>}
        {task.report && <div data-personbot-task-report={task.id} className="space-y-2">
          <p className="font-medium">执行报告</p>
          <ChatMarkdown text={task.report.summary} />
          {task.report.evidence.length > 0 && <div><p className="font-medium">验收证据</p><ul className="mt-1 list-disc space-y-1 ps-5">{task.report.evidence.map((evidence, index) => <li key={index} className="break-words"><ChatMarkdown text={evidence} /></li>)}</ul></div>}
        </div>}
        {task.wakeAt && <p className="text-ink-secondary">计划唤醒：<time dateTime={task.wakeAt}>{new Date(task.wakeAt).toLocaleString("zh-CN")}</time></p>}
        {task.lastError && <p role="status" className="whitespace-pre-wrap break-words text-danger">{task.lastError}</p>}
        {stopUnknown && <p className="text-ink-secondary">原生执行树尚未确认停止。请重试停止，原有操作结果仍需核对。</p>}
        {effectsUnknown ? (
          <p className="text-ink-secondary">历史执行的部分外部操作结果仍未确认。终止任务和当前执行树的停止确认不会撤销或核实这些操作，请查看历史工具记录并核对实际结果。</p>
        ) : execution?.outcome === "unknown" && task.stage === "blocked" && <p className="text-ink-secondary">上次执行的部分操作可能已经生效。继续前请核对报告与工具记录，并补充核对结果。</p>}
        {update && <p className="text-[12px] text-ink-secondary">{update.delivered ? "最新任务进展已回传到来源会话。" : "最新任务进展等待回传到来源会话。"}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.select(task.workerSessionId)}>查看任务会话</button>
          <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.select(task.originSessionId)}>返回来源会话</button>
          {canPause && <button type="button" className={BUTTON} disabled={disabled || stopping} onClick={() => void control("pause")}>暂停任务</button>}
          {open && <button type="button" className={BUTTON} disabled={disabled || stopping} onClick={() => void control("cancel")}>终止任务</button>}
          {stopUnknown && (open || task.lifecycle === "cancelled") && <button type="button" className={BUTTON} disabled={disabled || stopping} onClick={() => void control(open ? "pause" : "cancel")}>重试停止任务</button>}
        </div>
        {(canResume || review || canSupplement) && <div className="border-t border-hairline pt-3">
          <label className="block text-ink-secondary">{review ? "修改要求" : canSupplement ? "补充任务说明" : "继续执行说明（可选）"}
            <textarea aria-label={`${review ? "修改要求" : canSupplement ? "补充任务说明" : "继续执行说明"}：${task.goal}`} value={instruction} rows={2} className={INPUT} disabled={disabled}
              onChange={(event) => setInstruction(event.target.value)} />
          </label>
          {review && <p className="mt-2 text-ink-secondary">请对照完成条件核对证据。验收通过后才会将任务标记为完成。</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {canSupplement && <button type="button" className={BUTTON} disabled={disabled || stopping || stopUnknown || !instruction.trim()} onClick={() => void control("supplement")}>发送补充说明</button>}
            {canResume && <button type="button" className={BUTTON} disabled={disabled || stopping || stopUnknown} onClick={() => void control("resume")}>继续任务</button>}
            {review && <>
              <button type="button" className={BUTTON} disabled={disabled || stopping || stopUnknown || !task.report?.evidence.length} onClick={() => void control("accept")}>验收通过</button>
              <button type="button" className={BUTTON} disabled={disabled || stopping || stopUnknown || !instruction.trim()} onClick={() => void control("revise")}>要求修改</button>
            </>}
          </div>
        </div>}
      </div>
    </details>
  );
}

export function PersonbotTasks({ snapshot, client, selectedId, originSessionId, disabled, action }: {
  snapshot: TaskSnapshot;
  client: TaskClient;
  selectedId: string | null;
  originSessionId?: string;
  disabled: boolean;
  action: string | null;
}) {
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [context, setContext] = useState("");
  const conditions = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
  const tasks = snapshot.tasks;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!originSessionId || !goal.trim() || !conditions.length || disabled) return;
    if (await client.createTask(originSessionId, goal.trim(), conditions, context.trim() || undefined)) {
      setGoal(""); setCriteria(""); setContext(""); setCreating(false);
    }
  };
  return (
    <section aria-label="Personbot 长期任务" className="personbot-tasks mb-5">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium">长期任务 <span className="ms-1 text-[12px] font-normal text-ink-secondary">{tasks.length}</span></h2>
        <button type="button" className={BUTTON} disabled={disabled || !originSessionId} aria-expanded={creating} onClick={() => setCreating(!creating)}>
          {creating ? <X size={14} /> : <Plus size={14} />}{creating ? "收起" : "新任务"}
        </button>
      </div>
      {creating && <form onSubmit={(event) => void submit(event)} aria-label="创建长期任务" className="my-3 space-y-3 rounded-lg border border-hairline p-4">
        <label className="block text-[13px] text-ink-secondary">任务目标
          <textarea aria-label="任务目标" value={goal} onChange={(event) => setGoal(event.target.value)} required rows={2} className={INPUT} disabled={disabled} />
        </label>
        <label className="block text-[13px] text-ink-secondary">完成条件（每行一项）
          <textarea aria-label="任务完成条件" value={criteria} onChange={(event) => setCriteria(event.target.value)} required rows={2} className={INPUT} disabled={disabled} placeholder="例如：生成报告并列出来源" />
        </label>
        <label className="block text-[13px] text-ink-secondary">补充上下文（可选）
          <textarea aria-label="任务上下文" value={context} onChange={(event) => setContext(event.target.value)} rows={2} className={INPUT} disabled={disabled} />
        </label>
        <p className="text-[12px] text-ink-secondary">任务在独立会话中执行，你可以继续聊天。请将 worker 需要的材料写入目标或上下文。</p>
        <button type="submit" className={BUTTON} disabled={disabled || !goal.trim() || !conditions.length || conditions.length > 20}>
          {action === "task:create" && <LoaderCircle size={14} className="animate-spin" />}创建并执行任务
        </button>
      </form>}
      {!tasks.length && !creating && <p className="py-2 text-[13px] text-ink-secondary">将需要持续推进的工作交给独立 worker，并在这里查看进展和验收结果。</p>}
      {tasks.map((task) => <TaskCard key={task.id} task={task} snapshot={snapshot} client={client} selectedId={selectedId} disabled={disabled} action={action} />)}
    </section>
  );
}
