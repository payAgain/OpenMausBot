import { useState, type FormEvent } from "react";
import type { PersonbotClient } from "@/lib/personbot-client";
import type {
  ChannelDeliveryRecord, IntegrationSnapshot, ScheduleRecord, SourceRecord, SubscriptionRecord, TaskRecord,
} from "../../../packages/personbot-protocol/src/index.ts";

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg border border-hairline px-3 text-[14px] text-ink enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INPUT = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const EMPTY: IntegrationSnapshot = { sources: [], subscriptions: [], schedules: [], triggers: [], deliveries: [] };
type IntegrationsClient = Pick<PersonbotClient, "saveSource" | "saveSchedule" | "saveSubscription" | "controlDelivery" | "select">;
type Origin = { id: string; name: string };

export function generateSourceToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sourceEndpoint(sourceId: string, origin?: string): string {
  const path = `/api/personbot/sources/${encodeURIComponent(sourceId)}/events`;
  return origin && /^https?:\/\//.test(origin) ? new URL(path, origin).href : path;
}

export function localScheduleTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function readableTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "无待执行时间";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("已复制");
    } catch {
      setMessage("复制失败，请选择内容手动复制");
    }
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <button type="button" className={BUTTON} onClick={() => void copy()}>{label}</button>
    {message && <span role="status" className="text-[12px] text-ink-secondary">{message}</span>}
  </div>;
}

export function SourceForm({ source, origins, originSessionId, client, disabled, done }: {
  source?: SourceRecord; origins: Origin[]; originSessionId?: string; client: IntegrationsClient; disabled: boolean; done(): void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [origin, setOrigin] = useState(source?.originSessionId ?? originSessionId ?? origins[0]?.id ?? "");
  const [goal, setGoal] = useState(source?.goal ?? "");
  const [criteria, setCriteria] = useState(source?.criteria.join("\n") ?? "");
  const [enabled, setEnabled] = useState(source?.enabled ?? false);
  const [callbackUrl, setCallbackUrl] = useState(source?.callbackUrl ?? "");
  const [callbackMode, setCallbackMode] = useState<SourceRecord["callbackMode"]>(source?.callbackMode ?? "at-most-once");
  const [token, setToken] = useState<string>();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await client.saveSource({
      ...(source ? { id: source.id, revision: source.revision } : {}), name: name.trim(), originSessionId: origin,
      enabled, goal: goal.trim(), criteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
      callbackMode, ...(callbackUrl.trim() ? { callbackUrl: callbackUrl.trim() } : {}), ...(token ? { token } : {}),
    })) { setToken(undefined); done(); }
  };
  return <form aria-label="事件来源设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">来源名称<input aria-label="来源名称" className={INPUT} value={name} onChange={(event) => setName(event.target.value)} required disabled={disabled} /></label>
    <label className="block">来源会话<select aria-label="来源会话" className={INPUT} value={origin} onChange={(event) => setOrigin(event.target.value)} disabled={disabled || !!source} required>
      {!origins.length && <option value="">请先建立一个会话</option>}
      {source && !origins.some((entry) => entry.id === source.originSessionId) && <option value={source.originSessionId}>{source.originSessionId}</option>}
      {origins.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select></label>
    <label className="block">新任务目标<textarea aria-label="新任务目标" className={INPUT} rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} required disabled={disabled} /></label>
    <label className="block">事件任务验收标准（每行一项）<textarea aria-label="事件任务验收标准" className={INPUT} rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} required disabled={disabled} /></label>
    <p className="text-ink-secondary">目标与验收标准由你固定。外部事件只提供内容；最终结果仍由你验收。</p>
    <label className="block">结果回调地址（可选）<input aria-label="结果回调地址" type="url" className={INPUT} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} disabled={disabled} /></label>
    <label className="block">回调重试方式<select aria-label="回调重试方式" className={INPUT} value={callbackMode} onChange={(event) => setCallbackMode(event.target.value as SourceRecord["callbackMode"])} disabled={disabled}>
      <option value="at-most-once">不自动重试不明确的结果</option><option value="idempotent">接收方支持幂等键，允许自动重试</option>
    </select></label>
    <p className="text-[12px] text-ink-secondary">回调使用 HTTPS；本机测试可用回环 HTTP。接收方需按幂等键去重，才能选择自动重试。</p>
    <div className="space-y-2">
      <button type="button" className={BUTTON} disabled={disabled || !!token} onClick={() => setToken(generateSourceToken())}>{source ? "轮换来源令牌" : "生成来源令牌"}</button>
      {token ? <div className="space-y-2">
        <label className="block">本次来源令牌<input aria-label="本次来源令牌" className={`${INPUT} font-mono`} value={token} readOnly autoComplete="off" spellCheck={false} /></label>
        <p className="text-ink-secondary">保存前请复制令牌。保存后不能再次查看；取消编辑会丢弃本次生成的令牌。</p>
        <CopyButton value={token} label="复制来源令牌" />
      </div> : source && <p className="text-ink-secondary">已保存的令牌不可读取。普通编辑保留原令牌，轮换后需更新发送方。</p>}
    </div>
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label="启用事件来源" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={disabled} /><span>启用事件来源</span></label>
    <div className="flex flex-wrap gap-2">
      <button type="submit" className={BUTTON} disabled={disabled || !origin || !name.trim() || !goal.trim() || !criteria.trim() || (!source && !token)}>保存来源</button>
      <button type="button" className={BUTTON} disabled={disabled} onClick={done}>取消编辑</button>
    </div>
  </form>;
}

export function ScheduleForm({ schedule, sources, client, disabled, done }: {
  schedule?: ScheduleRecord; sources: SourceRecord[]; client: IntegrationsClient; disabled: boolean; done(): void;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [sourceId, setSourceId] = useState(schedule?.sourceId ?? sources[0]?.id ?? "");
  const [threadId, setThreadId] = useState(schedule?.threadId ?? "");
  const [text, setText] = useState(schedule?.text ?? "");
  const [runAt, setRunAt] = useState(localScheduleTime(schedule?.nextRunAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  const [minutes, setMinutes] = useState(schedule?.intervalSeconds ? String(schedule.intervalSeconds / 60) : "");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const time = new Date(runAt);
    const intervalSeconds = minutes ? Number(minutes) * 60 : undefined;
    if (!Number.isFinite(time.getTime()) || (intervalSeconds !== undefined && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60))) {
      setError("请选择有效的本地时间；重复间隔至少为 1 分钟。");
      return;
    }
    setError("");
    if (await client.saveSchedule({
      ...(schedule ? { id: schedule.id, revision: schedule.revision } : {}), name: name.trim(), sourceId, threadId: threadId.trim(),
      text: text.trim(), runAt: time.toISOString(), ...(intervalSeconds === undefined ? {} : { intervalSeconds }), enabled,
    })) done();
  };
  return <form aria-label="事件定时设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">定时名称<input aria-label="定时名称" className={INPUT} value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} required /></label>
    <label className="block">定时来源<select aria-label="定时来源" className={INPUT} value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={disabled || !!schedule}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}{!source.enabled && "（来源未启用）"}</option>)}</select></label>
    <label className="block">事件线程<input aria-label="定时事件线程" className={INPUT} value={threadId} onChange={(event) => setThreadId(event.target.value)} disabled={disabled || !!schedule} required /></label>
    <label className="block">事件内容<textarea aria-label="定时事件内容" className={INPUT} rows={3} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled} required /></label>
    <label className="block">首次执行时间（当前设备本地时间）<input type="datetime-local" aria-label="首次执行时间" className={INPUT} value={runAt} onChange={(event) => setRunAt(event.target.value)} disabled={disabled} required /></label>
    <label className="block">重复间隔（分钟，留空为单次）<input type="number" aria-label="重复间隔分钟" className={INPUT} min="1" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={disabled} /></label>
    <p className="text-ink-secondary">按固定间隔执行。停机期间错过的多次执行会合并为最近一次；来源与定时都启用后才会触发。</p>
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label="启用事件定时" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={disabled} /><span>启用事件定时</span></label>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className={BUTTON} disabled={disabled || !sourceId || !name.trim() || !threadId.trim() || !text.trim() || !runAt}>保存定时</button><button type="button" className={BUTTON} disabled={disabled} onClick={done}>取消编辑</button></div>
  </form>;
}

export function SubscriptionForm({ subscription, sources, tasks, client, disabled, done }: {
  subscription?: SubscriptionRecord; sources: SourceRecord[]; tasks: TaskRecord[]; client: IntegrationsClient; disabled: boolean; done(): void;
}) {
  const [sourceId, setSourceId] = useState(subscription?.sourceId ?? sources[0]?.id ?? "");
  const [taskId, setTaskId] = useState(subscription?.taskId ?? "");
  const [threadId, setThreadId] = useState(subscription?.threadId ?? "");
  const [enabled, setEnabled] = useState(subscription?.enabled ?? true);
  const source = sources.find((entry) => entry.id === sourceId);
  const available = tasks.filter((task) => task.originSessionId === source?.originSessionId);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!available.some((task) => task.id === taskId)) return;
    if (await client.saveSubscription({
      ...(subscription ? { id: subscription.id, revision: subscription.revision } : {}), sourceId, taskId, threadId: threadId.trim(), enabled,
    })) done();
  };
  return <form aria-label="事件订阅设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">订阅来源<select aria-label="订阅来源" className={INPUT} value={sourceId} onChange={(event) => { setSourceId(event.target.value); setTaskId(""); }} disabled={disabled || !!subscription}>{sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <label className="block">订阅事件线程<input aria-label="订阅事件线程" className={INPUT} value={threadId} onChange={(event) => setThreadId(event.target.value)} disabled={disabled || !!subscription} required /></label>
    <label className="block">接收事件的任务<select aria-label="接收事件的任务" className={INPUT} value={taskId} onChange={(event) => setTaskId(event.target.value)} disabled={disabled || !!subscription} required>
      <option value="">选择同一来源会话中的任务</option>{available.map((task) => <option key={task.id} value={task.id}>{task.goal}</option>)}
    </select></label>
    <p className="text-ink-secondary">该线程后续事件作为任务补充内容。等待事件的任务可被唤醒；暂停、受阻或等待验收时保留事件，已结束任务忽略新事件。</p>
    {subscription && <p className="text-ink-secondary">来源、线程与任务绑定已固定；可在这里启用或停用订阅。</p>}
    {!available.length && <p className="text-ink-secondary">此来源会话中还没有可绑定的任务。</p>}
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label="启用事件订阅" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={disabled} /><span>启用事件订阅</span></label>
    <div className="flex flex-wrap gap-2"><button type="submit" className={BUTTON} disabled={disabled || !sourceId || !threadId.trim() || !available.some((task) => task.id === taskId)}>保存订阅</button><button type="button" className={BUTTON} disabled={disabled} onClick={done}>取消编辑</button></div>
  </form>;
}

const DELIVERY_STATE: Record<ChannelDeliveryRecord["state"], string> = { pending: "等待发送", sending: "发送中", delivered: "已送达", uncertain: "送达情况不明确", failed: "发送失败" };

export function ChannelDelivery({ delivery, client, disabled, task }: {
  delivery: ChannelDeliveryRecord; client: IntegrationsClient; disabled: boolean; task?: TaskRecord;
}) {
  const [confirmRetry, setConfirmRetry] = useState(false);
  const manageable = delivery.state === "uncertain" || delivery.state === "failed";
  return <li data-personbot-delivery={delivery.id} className="py-3">
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{DELIVERY_STATE[delivery.state]}</p><span className="text-[12px] text-ink-secondary">尝试 {delivery.attempts} 次 · {readableTime(delivery.updatedAt)}</span></div>
    <p className="mt-1 break-words text-ink-secondary">{task?.goal ?? delivery.taskId} · 线程 {delivery.threadId}</p>
    {typeof delivery.payload.text === "string" && <p className="mt-2 whitespace-pre-wrap break-words">{delivery.payload.text}</p>}
    {delivery.lastError && <p className="mt-2 break-words text-danger">{delivery.lastError}</p>}
    {delivery.nextAttemptAt && delivery.state === "pending" && <p className="mt-1 text-[12px] text-ink-secondary">下次尝试：{readableTime(delivery.nextAttemptAt)}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {task && <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.select(task.workerSessionId)}>查看回调任务</button>}
      {manageable && <>
        <button type="button" className={BUTTON} disabled={disabled} onClick={() => setConfirmRetry(!confirmRetry)}>手动重试回调</button>
        <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.controlDelivery(delivery, "mark_delivered")}>确认已经送达</button>
      </>}
    </div>
    {manageable && confirmRetry && <div className="mt-3 space-y-2 border-s-2 border-hairline ps-3">
      <p className="text-ink-secondary">接收方可能已经处理了上次回调。再次发送可能产生重复结果，请核对后继续。</p>
      <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.controlDelivery(delivery, "retry").then((saved) => { if (saved) setConfirmRetry(false); })}>确认重试，可能重复</button>
    </div>}
  </li>;
}

export function PersonbotIntegrations({ snapshot, client, origins, originSessionId, tasks, disabled, expanded = false }: {
  snapshot?: IntegrationSnapshot; client: IntegrationsClient; origins: Origin[]; originSessionId?: string; tasks: TaskRecord[]; disabled: boolean; expanded?: boolean;
}) {
  const value = snapshot ?? EMPTY;
  const [tab, setTab] = useState<"sources" | "schedules" | "subscriptions" | "events" | "deliveries">("sources");
  const [editing, setEditing] = useState<string | null>(null);
  const switchTab = (next: typeof tab) => { setTab(next); setEditing(null); };
  const sourceName = (id: string) => value.sources.find((source) => source.id === id)?.name ?? id;
  return <details className="personbot-integrations mb-4 rounded-lg border border-hairline" data-personbot-integrations="" open={expanded || undefined}>
    <summary className="min-h-11 cursor-pointer px-3 py-3 text-[14px] font-medium">事件与渠道 <span className="ms-2 text-[12px] font-normal text-ink-secondary">Webhook、定时与回调</span></summary>
    <div className="space-y-4 border-t border-hairline p-3 text-[13px]">
      <div className="flex flex-wrap gap-2" aria-label="事件与渠道分类">{([
        ["sources", "来源"], ["schedules", "定时"], ["subscriptions", "订阅"], ["events", "最近事件"], ["deliveries", "回调回执"],
      ] as const).map(([key, label]) => <button type="button" key={key} className={BUTTON} aria-pressed={tab === key} onClick={() => switchTab(key)}>{label}</button>)}</div>
      {!snapshot ? <p role="status" className="text-ink-secondary">正在读取事件与渠道配置。</p> : <>
        {tab === "sources" && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">事件来源</h2><button type="button" className={BUTTON} disabled={disabled || !origins.length} onClick={() => setEditing("new")}>添加来源</button></div>
          {editing !== null ? <SourceForm key={editing} source={value.sources.find((source) => source.id === editing)} origins={origins} originSessionId={originSessionId} client={client} disabled={disabled} done={() => setEditing(null)} /> : <>
            <p className="text-ink-secondary">通用 Webhook 接收事件，同一来源的相同事件编号会去重。已接收的事件在重启后继续处理。</p>
            {!origins.length && <p className="text-ink-secondary">先建立一个会话，再为它添加事件来源。</p>}
            {value.sources.length ? <ul className="divide-y divide-hairline">{value.sources.map((source) => {
              const endpoint = sourceEndpoint(source.id, typeof window === "undefined" ? undefined : window.location.origin);
              const example = JSON.stringify({ eventId: "event-001", threadId: "thread-001", text: "需要处理的事件内容" }, null, 2);
              return <li key={source.id} data-personbot-source={source.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{source.name} <span className="ms-2 text-[12px] font-normal text-ink-secondary">{source.enabled ? "已启用" : "未启用"} · 版本 {source.revision}</span></p><button type="button" className={BUTTON} aria-label={`编辑来源：${source.name}`} disabled={disabled} onClick={() => setEditing(source.id)}>编辑</button></div>
                <p className="break-words text-ink-secondary">来源会话：{origins.find((origin) => origin.id === source.originSessionId)?.name ?? source.originSessionId}</p>
                <p className="whitespace-pre-wrap break-words">{source.goal}</p>
                <details><summary className="min-h-11 cursor-pointer py-3 text-ink-secondary">接入说明与验收标准</summary><div className="space-y-3 pb-2">
                  <ul className="list-disc space-y-1 ps-5">{source.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
                  <p className="text-ink-secondary">向以下地址 POST JSON，并在 Authorization 请求头中使用 Bearer 加来源令牌。</p>
                  <p className="select-all break-all font-mono text-[12px]">{endpoint}</p><CopyButton value={endpoint} label="复制事件地址" />
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{example}</pre><CopyButton value={example} label="复制事件示例" />
                  {source.callbackUrl && <p className="break-all text-ink-secondary">结果回调：{source.callbackUrl}</p>}
                </div></details>
              </li>;
            })}</ul> : <p className="py-2 text-ink-secondary">还没有事件来源。添加后，手动启用才会开始接收事件。</p>}
          </>}
        </>}
        {tab === "schedules" && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">定时事件</h2><button type="button" className={BUTTON} disabled={disabled || !value.sources.length} onClick={() => setEditing("new")}>添加定时</button></div>
          {editing !== null ? <ScheduleForm key={editing} schedule={value.schedules.find((schedule) => schedule.id === editing)} sources={value.sources} client={client} disabled={disabled} done={() => setEditing(null)} /> : value.schedules.length ? <ul className="divide-y divide-hairline">{value.schedules.map((schedule) => <li key={schedule.id} data-personbot-schedule={schedule.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{schedule.name} <span className="ms-2 text-[12px] font-normal text-ink-secondary">{schedule.enabled ? "已启用" : "未启用"} · {schedule.intervalSeconds ? `每 ${schedule.intervalSeconds / 60} 分钟` : "单次"}</span></p><button type="button" className={BUTTON} aria-label={`编辑定时：${schedule.name}`} disabled={disabled} onClick={() => setEditing(schedule.id)}>编辑</button></div>
            <p className="mt-1 break-words text-ink-secondary">{sourceName(schedule.sourceId)} · 线程 {schedule.threadId}</p><p className="mt-1 text-ink-secondary">下次执行：{readableTime(schedule.nextRunAt)}</p><p className="mt-2 whitespace-pre-wrap break-words">{schedule.text}</p>
          </li>)}</ul> : <p className="py-2 text-ink-secondary">{value.sources.length ? "还没有定时事件。可以选择单次执行或固定分钟间隔。" : "先添加事件来源，再配置定时。"}</p>}
        </>}
        {tab === "subscriptions" && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">线程与任务订阅</h2><button type="button" className={BUTTON} disabled={disabled || !value.sources.length} onClick={() => setEditing("new")}>添加订阅</button></div>
          {editing !== null ? <SubscriptionForm key={editing} subscription={value.subscriptions.find((subscription) => subscription.id === editing)} sources={value.sources} tasks={tasks} client={client} disabled={disabled} done={() => setEditing(null)} /> : <>
            <p className="text-ink-secondary">事件创建任务后会自动订阅该线程。可将其他线程绑定到同一来源会话中的现有任务。</p>
            {value.subscriptions.length ? <ul className="divide-y divide-hairline">{value.subscriptions.map((subscription) => <li key={subscription.id} data-personbot-subscription={subscription.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{sourceName(subscription.sourceId)} <span className="ms-2 text-[12px] font-normal text-ink-secondary">{subscription.enabled ? "已启用" : "未启用"}</span></p><button type="button" className={BUTTON} aria-label={`编辑订阅：${subscription.threadId}`} disabled={disabled} onClick={() => setEditing(subscription.id)}>编辑</button></div>
              <p className="mt-1 break-words text-ink-secondary">线程：{subscription.threadId}</p><p className="mt-2 break-words">{tasks.find((task) => task.id === subscription.taskId)?.goal ?? subscription.taskId}</p>
            </li>)}</ul> : <p className="py-2 text-ink-secondary">还没有线程订阅。</p>}
          </>}
        </>}
        {tab === "events" && <>
          <h2 className="font-medium">最近事件</h2>
          {value.triggers.length ? <ul className="divide-y divide-hairline">{value.triggers.map((trigger) => <li key={trigger.id} data-personbot-trigger={trigger.id} className="py-3">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{sourceName(trigger.sourceId)} · {{ pending: "等待处理", delivered: "已处理", ignored: "已忽略", failed: "处理失败" }[trigger.status]}</p><span className="text-[12px] text-ink-secondary">{readableTime(trigger.receivedAt)}</span></div>
            <p className="mt-1 break-words text-[12px] text-ink-secondary">事件 {trigger.eventId} · 线程 {trigger.threadId}</p><p className="mt-2 whitespace-pre-wrap break-words">{trigger.text}</p>
            {trigger.lastError && <p className="mt-2 break-words text-danger">{trigger.lastError}</p>}
            {!!trigger.taskIds.length && <div className="mt-3 flex flex-wrap gap-2">{trigger.taskIds.map((id) => {
              const task = tasks.find((entry) => entry.id === id);
              return task ? <button key={id} type="button" className={BUTTON} aria-label={`查看事件任务：${task.goal}`} disabled={disabled} onClick={() => void client.select(task.workerSessionId)}>查看任务：{task.goal}</button> : <span key={id} className="break-all text-ink-secondary">任务 {id}</span>;
            })}</div>}
          </li>)}</ul> : <p className="py-2 text-ink-secondary">还没有收到事件。</p>}
        </>}
        {tab === "deliveries" && <>
          <h2 className="font-medium">结果回调回执</h2><p className="text-ink-secondary">显示最近的发送结果。送达情况不明确的回调会等待人工处理，避免自动重复发送。</p>
          {value.deliveries.length ? <ul className="divide-y divide-hairline">{value.deliveries.map((delivery) => <ChannelDelivery key={delivery.id} delivery={delivery} client={client} disabled={disabled} task={tasks.find((task) => task.id === delivery.taskId)} />)}</ul> : <p className="py-2 text-ink-secondary">还没有结果回调。为来源配置回调地址后，后续任务更新会产生回执。</p>}
        </>}
      </>}
    </div>
  </details>;
}
