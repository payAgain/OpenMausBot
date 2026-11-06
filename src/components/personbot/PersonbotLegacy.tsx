import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { api } from "@/state/api";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { legacyPath, ProductCommand, type LegacyDetail, type LegacyPage, type LegacyThread } from "@/lib/personbot-product-client";
import { cn } from "@/lib/cn";
import { PRODUCT_BUTTON, PRODUCT_INPUT } from "./PersonbotSetup";

export function PersonbotLegacy({ configured, onImported }: { configured: boolean; onImported(sessionId: string): void }) {
  const [threads, setThreads] = useState<LegacyThread[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<LegacyDetail>();
  const [goal, setGoal] = useState("");
  const [progress, setProgress] = useState("");
  const [importConfiguration, setImportConfiguration] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const command = useRef(new ProductCommand());
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError("");
    void api<LegacyPage>("/api/personbot/legacy", { signal: abort.signal }).then((value) => {
      setThreads(value.threads); setCursor(value.nextCursor); setHasMore(!!value.hasMore);
    }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取旧历史"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [retry]);
  const select = async (id: string) => {
    const revision = ++request.current;
    setSelected(id); setDetail(undefined); setShowImport(false); setGoal(""); setProgress(""); setImportConfiguration(false); setError(""); setLoading(true);
    command.current.clear();
    try {
      const value = await api<LegacyDetail>(legacyPath(id));
      if (request.current === revision) setDetail(value);
    } catch (failure) {
      if (request.current === revision) setError(failure instanceof Error ? failure.message : "无法读取会话");
    } finally { if (request.current === revision) setLoading(false); }
  };
  const more = async () => {
    const revision = request.current;
    setLoading(true); setError("");
    try {
      if (selected && detail) {
        const value = await api<LegacyDetail>(`${legacyPath(selected)}?cursor=${encodeURIComponent(detail.nextCursor ?? "")}`);
        if (request.current === revision) setDetail({ ...value, messages: [...detail.messages, ...value.messages] });
      } else {
        const value = await api<LegacyPage>(`/api/personbot/legacy?cursor=${encodeURIComponent(cursor ?? "")}`);
        if (request.current === revision) {
          setThreads((current) => [...current, ...value.threads]); setCursor(value.nextCursor); setHasMore(!!value.hasMore);
        }
      }
    } catch (failure) { if (request.current === revision) setError(failure instanceof Error ? failure.message : "无法读取更多历史"); }
    finally { if (request.current === revision) setLoading(false); }
  };
  const importThread = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || importing || !goal.trim()) return;
    const bytes = new TextEncoder();
    if (bytes.encode(goal.trim()).byteLength > 8192 || bytes.encode(progress.trim()).byteLength > 16384) {
      setError("目标最多支持 8 KiB，已确认的进展最多支持 16 KiB。请缩短后重试。");
      return;
    }
    setImporting(true); setError("");
    try {
      const receipt = await command.current.send<{ sessionId: string }>(`${legacyPath(selected)}/import`, {
        goal: goal.trim(), progress: progress.trim(), importConfiguration,
      });
      onImported(receipt.sessionId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法导入会话"); }
    finally { setImporting(false); }
  };
  return <section aria-label="Personbot 旧历史" className="personbot-product-page">
    <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0"><h1 className="text-[24px] font-semibold">旧历史</h1><p className="mt-2 text-[14px] leading-6 text-ink-secondary">旧对话保留为只读。确认目标与已有进展后，在新的 dsh 会话中继续。</p></div>
      {!selected && <button className={PRODUCT_BUTTON} type="button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>刷新历史</button>}
    </header>
    {selected ? <>
      <button type="button" className={PRODUCT_BUTTON} disabled={importing} onClick={() => { request.current++; setSelected(undefined); setDetail(undefined); setError(""); setLoading(false); }}><ArrowLeft size={15} />返回会话列表</button>
      {detail && <>
        <div className="my-6 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h2 className="break-words text-[18px] font-medium">{detail.thread.title}</h2><p className="mt-1 text-[13px] text-ink-secondary">{detail.thread.botName} · 只读历史</p></div>
          <button className={PRODUCT_BUTTON} type="button" disabled={!configured || importing} aria-expanded={showImport} onClick={() => setShowImport(!showImport)}>导入并继续</button>
        </div>
        {!configured && <p className="mb-4 text-[13px] text-ink-secondary">先在模型设置中连接 DeepSeek，之后即可导入继续。</p>}
        {showImport && <form onSubmit={(event) => void importThread(event)} aria-label="导入旧会话" className="mb-6 space-y-4 rounded-lg border border-hairline bg-card p-4">
          <label className="block text-[14px]">接下来要完成的目标<textarea aria-label="导入后的目标" rows={2} maxLength={8192} className={PRODUCT_INPUT} value={goal} onChange={(event) => setGoal(event.target.value)} required disabled={importing} /></label>
          <label className="block text-[14px]">已确认的进展与需要核对的操作<textarea aria-label="已确认的进展" rows={3} maxLength={16384} className={PRODUCT_INPUT} value={progress} onChange={(event) => setProgress(event.target.value)} disabled={importing} /></label>
          <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={importConfiguration} onChange={(event) => setImportConfiguration(event.target.checked)} disabled={importing} />同时导入项目目录与角色说明</label>
          {importConfiguration && <div className="rounded-lg bg-raised p-3 text-[13px] leading-6"><p>角色：{detail.configuration.roleName}</p>{detail.configuration.workspace && <p className="break-all">项目目录：{detail.configuration.workspace}</p>}<p className="mt-2 whitespace-pre-wrap break-words">{detail.configuration.instructions || "使用默认助手说明。"}</p></div>}
          <p className="text-[13px] leading-6 text-ink-secondary">会创建新的 dsh 会话并发送你的目标与确认进展。旧引擎的私有上下文、权限、密钥和自动化不会随之迁移。</p>
          <button className={cn(PRODUCT_BUTTON, "bg-ink text-app enabled:hover:bg-ink/85 disabled:bg-raised")} disabled={importing || !goal.trim() || !configured} type="submit">{importing && <LoaderCircle size={15} className="animate-spin" />}创建 dsh 会话并继续</button>
        </form>}
        <div className="divide-y divide-hairline" data-personbot-legacy-messages="">
          {detail.messages.map((message) => <article key={message.id} className="py-4">
            <p className="mb-2 text-[12px] text-ink-secondary">{message.role === "user" ? "你" : message.role === "notice" ? "系统记录" : detail.thread.botName}{message.kind && message.kind !== "text" ? ` · ${message.kind}` : ""}</p>
            <div className="break-words text-[14px] leading-6"><ChatMarkdown text={message.text || "（此记录没有文本内容）"} /></div>
            {!!message.attachments?.length && <p className="mt-2 break-words text-[13px] text-ink-secondary">附件记录：{message.attachments.map((attachment) => attachment.name).join("、")}</p>}
            {message.truncated && <p className="mt-2 text-[13px] text-ink-secondary">这条记录较长，此处只展示部分文本。</p>}
          </article>)}
          {!detail.messages.length && <p className="py-6 text-[14px] text-ink-secondary">这段会话没有可读取的历史消息。</p>}
        </div>
        {detail.hasMore && <button type="button" className={cn(PRODUCT_BUTTON, "mt-4")} disabled={loading} onClick={() => void more()}>读取更多消息</button>}
      </>}
    </> : <div className="divide-y divide-hairline">
      {threads.map((thread) => <button key={thread.id} type="button" data-personbot-legacy-thread={thread.id} onClick={() => void select(thread.id)} className="flex min-h-20 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-4 text-left hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
        <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium">{thread.title}</span><span className="mt-1 block text-[13px] text-ink-secondary">{thread.botName}</span></span><span className="shrink-0 text-[13px] text-ink-secondary">查看</span>
      </button>)}
      {!threads.length && !loading && !error && <p className="py-6 text-[14px] text-ink-secondary">当前工作区没有旧会话。新建的会话会直接使用 dsh。</p>}
      {hasMore && <button type="button" className={cn(PRODUCT_BUTTON, "mt-4")} disabled={loading} onClick={() => void more()}>读取更多会话</button>}
    </div>}
    {loading && <p role="status" className="mt-4 inline-flex items-center gap-2 text-[14px] text-ink-secondary"><LoaderCircle size={15} className="animate-spin" />正在读取历史</p>}
    {error && <div className="mt-4 text-[14px]"><p role="alert" className="break-words text-danger">{error}</p>{selected && !detail && <button className={cn(PRODUCT_BUTTON, "mt-3")} type="button" onClick={() => void select(selected)}>重试读取</button>}</div>}
  </section>;
}
