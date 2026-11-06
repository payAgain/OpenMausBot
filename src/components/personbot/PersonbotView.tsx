import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowUp, Check, LoaderCircle, Plus, RotateCcw, Square, Terminal, X } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { cn } from "@/lib/cn";
import { PersonbotClient } from "@/lib/personbot-client";
import type { PendingDecision, SessionProjection, TranscriptRow } from "../../../packages/personbot-projection/src/index.ts";
import type { QuestionAnswer } from "../../../packages/personbot-protocol/src/index.ts";
import { PersonbotTasks, taskStatus } from "./PersonbotTasks";
import { PersonbotPersonal } from "./PersonbotPersonal";
import { PersonbotArtifacts } from "./PersonbotArtifacts";
import { PersonbotIntegrations } from "./PersonbotIntegrations";
import "./personbot.css";

const BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[14px] text-ink transition-colors enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

function sessionName(session: SessionProjection, index: number): string {
  const first = session.rows.find((row) => row.kind === "message" && row.role === "user");
  return first?.kind === "message" ? first.text.replace(/\s+/g, " ").slice(0, 48) || `会话 ${index + 1}` : `会话 ${index + 1}`;
}

function statusName(status: SessionProjection["status"]): string {
  return status === "running" ? "执行中" : status === "idle" ? "等待输入" : status === "closed" ? "已停止" : "恢复中";
}

function TranscriptItem({ row }: { row: TranscriptRow }) {
  if (row.kind === "notice") {
    return <p data-personbot-notice={row.code} className={cn("my-3 border-s-2 border-hairline ps-3 text-[13px]", row.level === "error" ? "text-danger" : "text-ink-secondary")}>{row.message}</p>;
  }
  if (row.kind === "tool") {
    const status = {
      requested: "准备调用", running: "执行中", succeeded: "已完成", failed: "失败", interrupted: "已中断",
    }[row.status];
    return (
      <details data-personbot-tool={row.callId} className="personbot-tool my-3 rounded-lg border border-hairline px-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-ink-secondary">
          <Terminal size={15} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-ink">{row.name}</span>
          <span className={cn("shrink-0", row.status === "failed" && "text-danger")}>{status}</span>
        </summary>
        <div className="space-y-3 border-t border-hairline py-3 text-[13px]">
          <div><p className="mb-1 text-ink-secondary">参数</p><pre>{row.arguments}</pre></div>
          {row.resultText && <div><p className="mb-1 text-ink-secondary">结果</p><pre>{row.resultText}</pre></div>}
          {row.error && <p role="status" className="text-danger">{row.error.reason ?? row.error.name ?? "工具调用失败"}</p>}
        </div>
      </details>
    );
  }
  return (
    <article data-personbot-message={row.messageId} data-role={row.role} className="personbot-message py-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-secondary">
        <span className="font-medium">{row.role === "user" ? "你" : "Personbot"}</span>
        {row.status === "streaming" && <span>正在回复</span>}
        {row.status === "settling" && <span>保存回复中</span>}
        {row.status === "interrupted" && <span>已中断</span>}
      </div>
      {row.reasoning && <details className="mb-3 text-[13px] text-ink-secondary"><summary className="min-h-8 cursor-pointer">思考过程</summary><div className="pt-2"><ChatMarkdown text={row.reasoning} /></div></details>}
      {row.text && <div className="text-[15px] leading-6 text-ink"><ChatMarkdown text={row.text} /></div>}
      {row.blocks.filter((block) => block.type === "attachment").map((block, index) => (
        <p key={index} className="mt-2 text-[13px] text-ink-secondary">{block.type === "attachment" && (block.kind === "image" ? "图像附件已记录" : "文件附件已记录")}</p>
      ))}
    </article>
  );
}

export function PersonbotDecisionCard({ decision, client, disabled, busy }: { decision: PendingDecision; client: Pick<PersonbotClient, "decide">; disabled: boolean; busy: boolean }) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  if (decision.kind === "approval") {
    return (
      <section aria-label="工具审批" data-personbot-approval={decision.requestId} className="rounded-xl border border-hairline bg-card p-4">
        <h2 className="text-[15px] font-medium text-ink">允许执行 {decision.toolName}？</h2>
        {decision.reason && <p className="mt-2 whitespace-pre-wrap break-words text-[14px] text-ink-secondary">{decision.reason}</p>}
        <p className="mt-2 text-[12px] text-ink-secondary">此决定仅适用于本次工具调用。</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.decide(decision, "allowed-once")}>
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}允许一次
          </button>
          <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.decide(decision, "rejected")}><X size={15} />拒绝</button>
        </div>
      </section>
    );
  }
  const answerFor = (id: string) => answers[id] ?? { id, selected: [] };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void client.decide(decision, { answers: decision.questions.map((question) => answerFor(question.id)) });
  };
  return (
    <form aria-label="回答 Personbot 的问题" data-personbot-question={decision.requestId} onSubmit={submit} className="rounded-xl border border-hairline bg-card p-4">
      <h2 className="text-[15px] font-medium text-ink">Personbot 需要你的回答</h2>
      {decision.questions.map((question) => (
        <fieldset key={question.id} disabled={disabled} className="mt-4 min-w-0">
          <legend className="mb-2 text-[14px] font-medium text-ink">{question.question}</legend>
          {question.detail?.trim() && (
            <div data-personbot-question-detail="" className="personbot-question-detail mb-3 min-w-0 text-[14px] leading-6 text-ink-secondary [overflow-wrap:anywhere]">
              <ChatMarkdown text={question.detail} />
            </div>
          )}
          {question.options?.map((option) => (
            <label key={option.label} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-[14px] text-ink hover:bg-raised">
              <input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} checked={answerFor(question.id).selected.includes(option.label)} className="mt-1 shrink-0"
                onChange={(event) => {
                  const answer = answerFor(question.id);
                  const selected = question.multiSelect
                    ? event.target.checked ? [...answer.selected, option.label] : answer.selected.filter((label) => label !== option.label)
                    : [option.label];
                  setAnswers((current) => ({ ...current, [question.id]: { ...answer, selected } }));
                }} />
              <span className="min-w-0 break-words">{option.label}{option.description && <span className="mt-0.5 block text-[12px] text-ink-secondary">{option.description}</span>}</span>
            </label>
          ))}
          <label className="mt-2 block text-[13px] text-ink-secondary">补充回答
            <input value={answerFor(question.id).custom ?? ""} aria-label={`补充回答：${question.question}`} className="mt-2 min-h-11 w-full rounded-lg border border-hairline bg-app px-3 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              onChange={(event) => {
                const custom = event.target.value;
                const answer = answerFor(question.id);
                setAnswers((current) => ({ ...current, [question.id]: { ...answer, ...(custom.trim() ? { custom } : { custom: undefined }) } }));
              }} />
          </label>
        </fieldset>
      ))}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className={BUTTON} disabled={disabled}>{busy && <LoaderCircle size={15} className="animate-spin" />}提交回答</button>
        <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.decide(decision, { cancelled: true })}>跳过问题</button>
      </div>
    </form>
  );
}

export type PersonbotSection = "chat" | "tasks" | "personal" | "integrations" | "artifacts";

export function PersonbotView({ client: suppliedClient, primary = false, section = "chat", onNavigate }: {
  client?: PersonbotClient;
  primary?: boolean;
  section?: PersonbotSection;
  onNavigate?(section: PersonbotSection): void;
} = {}) {
  const [client] = useState(() => suppliedClient ?? new PersonbotClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"followup" | "steer">("followup");
  const [projectId, setProjectId] = useState("default");
  const [roleId, setRoleId] = useState("assistant");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const transcriptHeight = useRef(0);
  const session = state.selectedId ? state.transcript.sessions[state.selectedId] : undefined;
  const selectedTask = state.tasks.tasks.find((task) => task.workerSessionId === state.selectedId);
  const isWorker = !!session?.summary?.taskId;
  const originSessionId = selectedTask?.originSessionId ?? (!isWorker ? state.selectedId ?? undefined : undefined);
  const sessions = Object.values(state.transcript.sessions).filter((entry) => entry.summary);
  const selectedId = state.selectedId;
  const draft = selectedId ? drafts[selectedId] ?? "" : "";
  const connected = state.connection === "connected";
  const disabled = !connected || !!state.action;
  const pending = state.transcript.pending.filter((decision) => decision.sessionId === selectedId || decision.rootSessionId === selectedId);
  const personal = state.personal ?? { projects: [], roles: [], memories: [] };
  const create = () => client.create({
    ...(personal.projects.some((project) => project.id === projectId) ? { projectId } : {}),
    ...(personal.roles.some((role) => role.id === roleId) ? { roleId } : {}),
  });
  const selectWork = async (sessionId: string) => {
    await client.select(sessionId);
    if (primary) onNavigate?.("chat");
  };
  const taskClient = {
    createTask: client.createTask.bind(client), controlTask: client.controlTask.bind(client), select: selectWork,
  };
  const integrationClient = {
    saveSource: client.saveSource.bind(client), saveSchedule: client.saveSchedule.bind(client),
    saveSubscription: client.saveSubscription.bind(client), controlDelivery: client.controlDelivery.bind(client), select: selectWork,
  };
  useEffect(() => {
    if (suppliedClient) return;
    client.start();
    return () => client.dispose();
  }, [client, suppliedClient]);
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    transcriptHeight.current = element.clientHeight;
    const observer = new ResizeObserver(() => {
      transcriptHeight.current = element.clientHeight;
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    follow.current = true;
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [selectedId]);
  useEffect(() => {
    if (follow.current && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [session?.rows, pending.length]);

  const send = async () => {
    if (!selectedId || !draft.trim() || disabled || isWorker) return;
    const text = draft;
    if (await client.submit(selectedId, text, mode)) {
      setDrafts((current) => current[selectedId] === text ? { ...current, [selectedId]: "" } : current);
    }
  };

  return (
    <main data-personbot-view="" data-personbot-section={section} className={cn("personbot-view flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app text-ink", primary && "personbot-primary-view")}>
      <header className="shrink-0 border-b border-hairline px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 max-md:pl-11">
          <div className="flex min-w-0 items-baseline gap-3"><h1 className="text-[20px] font-semibold">{primary ? ({ chat: "对话", tasks: "长期任务", personal: "项目与记忆", integrations: "事件与渠道", artifacts: "产物" })[section] : "Personbot"}</h1>{!primary && <span className="text-[12px] text-ink-secondary">dsh</span>}</div>
          <div className="flex items-center gap-2 text-[12px] text-ink-secondary" role="status" aria-label="Personbot 连接状态">
            {state.connection === "connecting" && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
            {state.connection === "connected" ? "已连接" : state.connection === "connecting" ? "正在连接" : state.connection === "reconnecting" ? "正在重连" : "未连接"}
            <button type="button" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" aria-label="重新连接 Personbot" onClick={() => client.retry()}><RotateCcw size={15} /></button>
          </div>
        </div>
        {(!primary || section === "chat") && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
          <span className="min-w-0 max-w-full truncate" title={session?.summary?.cwd ?? state.status?.workspace}>工作目录：{session?.summary?.cwd ?? state.status?.workspace ?? "正在读取"}</span>
          {state.status && <span className="min-w-0 break-all">{state.status.provider} / {state.status.model}</span>}
        </div>}
        <div className="mt-3 flex min-w-0 items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Personbot 会话</span>
            <select aria-label="Personbot 会话" value={selectedId ?? ""} disabled={!sessions.length} onChange={(event) => void client.select(event.target.value)}
              className="min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-3 text-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
              {!sessions.length && <option value="">尚无会话</option>}
              {sessions.map((entry, index) => <option key={entry.sessionId} value={entry.sessionId}>{
                entry.summary?.taskId
                  ? `任务 · ${state.tasks.tasks.find((task) => task.workerSessionId === entry.sessionId)?.goal.slice(0, 48) ?? entry.summary.taskId}`
                  : sessionName(entry, index)
              }</option>)}
            </select>
          </label>
          <button type="button" className={BUTTON} disabled={disabled || state.status?.enabled === false} onClick={() => void create()}><Plus size={16} /><span>新会话</span></button>
        </div>
        {!!personal.projects.length && (!primary || section === "chat") && <details className="mt-2 text-[12px] text-ink-secondary">
          <summary className="min-h-8 cursor-pointer">新会话的项目与角色</summary>
          <div className="personbot-binding-grid mt-2 grid grid-cols-2 gap-3">
            <label className="min-w-0">项目<select aria-label="新会话项目" value={projectId} disabled={disabled} onChange={(event) => setProjectId(event.target.value)} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-2 text-[13px] text-ink">{personal.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label className="min-w-0">角色<select aria-label="新会话角色" value={roleId} disabled={disabled} onChange={(event) => setRoleId(event.target.value)} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-2 text-[13px] text-ink">{personal.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
          </div>
        </details>}
        {session?.summary && (!primary || section === "chat") && <p data-personbot-session-binding="" className="mt-2 break-words text-[12px] text-ink-secondary">
          {session.summary.projectId ? `项目：${personal.projects.find((project) => project.id === session.summary?.projectId)?.name ?? session.summary.projectId}` : "项目：原有工作目录"}
          {session.summary.roleId && ` · 角色：${personal.roles.find((role) => role.id === session.summary?.roleId)?.name ?? session.summary.roleId}（版本 ${session.summary.roleRevision ?? 1}）`}
          <span className="ms-2">当前会话绑定已固定</span>
        </p>}
      </header>
      <div ref={transcriptRef} role="log" aria-label="Personbot 对话" aria-live="polite" aria-relevant="additions text" className="personbot-transcript min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (transcriptHeight.current !== element.clientHeight) {
            transcriptHeight.current = element.clientHeight;
            if (follow.current) element.scrollTop = element.scrollHeight;
            return;
          }
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        }}>
        <div className="mx-auto w-full max-w-[860px] py-4">
          {primary && section !== "chat" && (state.actionError || state.error || state.status?.error) && <p role="alert" className="mb-4 break-words rounded-lg border border-hairline p-3 text-[13px] text-danger">{state.actionError ?? state.error ?? state.status?.error}</p>}
          {state.status?.enabled !== false && (!primary || section === "personal") && <PersonbotPersonal snapshot={state.personal} client={client} projectId={session?.summary?.projectId} disabled={disabled} expanded={primary} />}
          {state.status?.enabled !== false && (!primary || section === "integrations") && <PersonbotIntegrations snapshot={state.integrations} client={integrationClient} origins={sessions.filter((entry) => !entry.summary?.taskId).map((entry, index) => ({ id: entry.sessionId, name: sessionName(entry, index) }))} originSessionId={originSessionId} tasks={state.tasks.tasks} disabled={disabled} expanded={primary} />}
          {state.status?.enabled !== false && (!primary || section === "tasks" || !!selectedTask && section === "chat") && <PersonbotTasks snapshot={state.tasks} client={taskClient} selectedId={selectedId} originSessionId={originSessionId} disabled={disabled} action={state.action} />}
          {state.status?.enabled !== false && (!primary || section === "artifacts") && <PersonbotArtifacts snapshot={state.artifacts} selectedId={selectedId} sourceSessionId={originSessionId} taskId={selectedTask?.id} client={client} disabled={disabled} worker={isWorker} />}
          {primary && section === "chat" && selectedId && !isWorker && !session?.rows.length && <div className="mb-5 rounded-lg bg-raised p-4 text-[14px]">
            <p className="font-medium">先说清楚你想完成的工作</p>
            <p className="mt-2 text-ink-secondary">Personbot 会在这个会话中保留上下文。需要持续推进的工作，可以交给独立任务。</p>
            <button type="button" className={cn(BUTTON, "mt-3")} onClick={() => onNavigate?.("tasks")}>交给长期任务</button>
          </div>}
          {(!primary || section === "chat") && <>
          {state.status?.enabled === false ? (
            <div className="py-8"><h2 className="text-[16px] font-medium">Personbot 尚未启用</h2><p className="mt-2 text-[14px] text-ink-secondary">在服务端启用 Personbot 后，点击重新连接。</p></div>
          ) : !selectedId ? (
            <div className="py-8"><h2 className="text-[16px] font-medium">开始一个会话</h2><p className="mt-2 text-[14px] text-ink-secondary">新建会话，向 Personbot 描述你想完成的工作。</p><button type="button" className={cn(BUTTON, "mt-4")} disabled={disabled} onClick={() => void create()}><Plus size={16} />创建第一个会话</button></div>
          ) : session?.rows.length ? (
            session.rows.map((row) => <TranscriptItem key={row.id} row={row} />)
          ) : <p className="py-8 text-[14px] text-ink-secondary">会话已就绪。发送消息开始工作。</p>}
          {session?.error && <p className="my-3 text-[13px] text-danger" role="alert">{session.error}</p>}
          {pending.length > 0 && <div className="my-4 space-y-3">{pending.map((decision) => <PersonbotDecisionCard key={`${decision.generation}:${decision.requestId}`} decision={decision} client={client} disabled={disabled} busy={state.action === decision.requestId} />)}</div>}
          </>}
          {primary && section !== "chat" && pending.length > 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline p-3 text-[14px]">
            <p>当前会话有 {pending.length} 项决定等待处理。</p>
            <button type="button" className={BUTTON} onClick={() => onNavigate?.("chat")}>查看待处理决定</button>
          </div>}
        </div>
      </div>
      <footer className="shrink-0 px-4 pb-4 sm:px-6" hidden={primary && section !== "chat"}>
        <div className="mx-auto w-full max-w-[860px]">
          {(state.error || state.actionError || state.status?.error) && (
            <div role="alert" className="mb-3 rounded-lg border border-hairline px-3 py-2 text-[13px] text-ink-secondary">
              <p className="break-words">{state.actionError ?? state.error ?? state.status?.error}</p>
              {state.actionError && <p className="mt-1">可以重试原操作；重试发送会保留同一条消息的标识。</p>}
            </div>
          )}
          {selectedId && isWorker ? (
            <div className="rounded-xl border border-hairline bg-card p-4">
              <p className="text-[14px]">{selectedTask ? `任务：${taskStatus(selectedTask)}` : "任务执行会话"}</p>
              <p className="mt-2 text-[13px] text-ink-secondary">此会话由任务监督层管理。使用上方任务操作暂停、继续或终止；工具审批与问题仍在这里处理。</p>
              {originSessionId && <button type="button" className={cn(BUTTON, "mt-3")} disabled={disabled} onClick={() => void client.select(originSessionId)}>返回来源会话继续聊天</button>}
            </div>
          ) : selectedId && <>
            <div className="mb-2 flex min-h-8 items-center justify-between gap-2 text-[12px] text-ink-secondary">
              <span role="status" aria-label="Personbot 执行状态">{session ? statusName(session.status) : "恢复中"}{pending.length ? " · 等待你的决定" : ""}</span>
              <span className="truncate font-mono" title={selectedId}>{selectedId.slice(0, 8)}</span>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="rounded-xl border border-hairline bg-card p-3">
              <label htmlFor="personbot-message" className="sr-only">发消息给 Personbot</label>
              <textarea id="personbot-message" aria-label="发消息给 Personbot" value={draft} placeholder="描述你想完成的工作…" rows={2} disabled={!connected}
                className="max-h-48 min-h-16 w-full resize-y bg-transparent text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none disabled:cursor-not-allowed"
                onChange={(event) => { const text = event.target.value; setDrafts((current) => ({ ...current, [selectedId]: text })); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex min-w-0 items-center gap-2 text-[12px] text-ink-secondary">发送方式
                  <select aria-label="Personbot 发送方式" value={mode} onChange={(event) => setMode(event.target.value as "followup" | "steer")} className="min-h-11 min-w-0 rounded-lg bg-app px-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                    <option value="followup">接续执行</option><option value="steer">调整当前方向</option>
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" className={BUTTON} aria-label="停止 Personbot 当前会话" disabled={disabled} onClick={() => void client.stop(selectedId)}>{state.action === "stop" ? <LoaderCircle size={14} className="animate-spin" /> : <Square size={14} />}停止</button>
                  <button type="submit" className={cn(BUTTON, "bg-ink text-app enabled:hover:bg-ink/85 disabled:bg-raised disabled:text-ink-secondary")} aria-label="发送给 Personbot" disabled={disabled || !draft.trim()}>{state.action === "send" ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowUp size={16} />}发送</button>
                </div>
              </div>
            </form>
            <p className="mt-2 text-[12px] text-ink-secondary">{mode === "steer" ? "在 Agent 下一次读取输入时调整当前方向。" : "输入会排入当前会话，按顺序接续执行。"}</p>
          </>}
        </div>
      </footer>
    </main>
  );
}
