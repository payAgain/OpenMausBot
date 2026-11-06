import { useEffect, useState, type FormEvent } from "react";
import type { PersonbotClient } from "@/lib/personbot-client";
import type { ArtifactRecord, ArtifactSnapshot } from "../../../packages/personbot-protocol/src/index.ts";

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg border border-hairline px-3 text-[14px] text-ink enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INPUT = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function artifactContentUrl(id: string, inline = false): string {
  return `/api/personbot/artifacts/${encodeURIComponent(id)}/content${inline ? "?inline=1" : ""}`;
}

export function artifactPreviewKind(mediaType: string): "image" | "text" | undefined {
  const type = mediaType.toLowerCase().split(";", 1)[0].trim();
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(type)) return "image";
  if (type.startsWith("text/") && type !== "text/html" || ["application/json", "application/xml"].includes(type)) return "text";
  return undefined;
}

function ArtifactPreview({ artifact }: { artifact: ArtifactRecord }) {
  const [state, setState] = useState<{ url?: string; text?: string; error?: string }>({});
  const kind = artifactPreviewKind(artifact.mediaType);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({});
    void (async () => {
      const response = await fetch(artifactContentUrl(artifact.id, true), { signal: controller.signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`预览无法读取（${response.status}）`);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (kind === "image") {
        objectUrl = URL.createObjectURL(new Blob([blob], { type: artifact.mediaType }));
        setState({ url: objectUrl });
      } else {
        const text = await blob.slice(0, 512 * 1024).text();
        if (!controller.signal.aborted) setState({ text });
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, artifact.mediaType, kind]);
  if (state.error) return <p role="status" className="py-3 text-danger">{state.error}</p>;
  if (state.url) return <img src={state.url} alt={artifact.name} className="mt-3 max-h-96 max-w-full object-contain" />;
  if (state.text !== undefined) return <div className="mt-3"><pre data-personbot-artifact-preview="" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app p-3 text-[13px] leading-6">{state.text}</pre>{artifact.size > 512 * 1024 && <p className="mt-2 text-[12px] text-ink-secondary">预览前 512 KiB，下载可查看完整文件。</p>}</div>;
  return <p role="status" className="py-3 text-ink-secondary">正在读取预览…</p>;
}

export function PersonbotArtifacts({ snapshot, selectedId, sourceSessionId, taskId, client, disabled, worker = false }: {
  snapshot?: ArtifactSnapshot;
  selectedId: string | null;
  sourceSessionId?: string;
  taskId?: string;
  client: Pick<PersonbotClient, "publishArtifact">;
  disabled: boolean;
  worker?: boolean;
}) {
  const [scope, setScope] = useState<"session" | "source" | "task">("session");
  const [preview, setPreview] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const filterSession = scope === "source" ? sourceSessionId : selectedId;
  const artifacts = (snapshot?.artifacts ?? []).filter((artifact) => scope === "task" ? !!taskId && artifact.taskId === taskId : artifact.sessionId === filterSession || (scope === "source" && artifact.originSessionId === filterSession));
  useEffect(() => { setPreview(null); setScope(taskId ? "task" : sourceSessionId ? "source" : "session"); setPublishing(false); }, [selectedId, sourceSessionId, taskId]);
  const publish = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedId && await client.publishArtifact(selectedId, path.trim(), name.trim() || undefined)) {
      setPath(""); setName(""); setPublishing(false);
    }
  };
  return <details className="personbot-artifacts mb-4 rounded-lg border border-hairline" data-personbot-artifacts="" onToggle={(event) => { if (!event.currentTarget.open) setPreview(null); }}>
    <summary className="min-h-11 cursor-pointer px-3 py-3 text-[14px] font-medium">工作产物 <span className="ms-2 text-[12px] font-normal text-ink-secondary">{artifacts.length}</span></summary>
    <div className="space-y-3 border-t border-hairline p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 text-ink-secondary">查看范围<select aria-label="产物查看范围" className="min-h-11 min-w-0 rounded-lg border border-hairline bg-app px-2 text-ink" value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setPreview(null); }}><option value="session">当前会话</option>{sourceSessionId && <option value="source">来源会话及任务</option>}{taskId && <option value="task">当前任务</option>}</select></label>
        <button type="button" className={BUTTON} disabled={disabled || !selectedId || worker} onClick={() => setPublishing(!publishing)}>{publishing ? "收起发布" : "发布文件"}</button>
      </div>
      {publishing && <form aria-label="发布产物" className="space-y-3" onSubmit={(event) => void publish(event)}>
        <label className="block">文件路径<input aria-label="产物文件路径" className={INPUT} value={path} onChange={(event) => setPath(event.target.value)} required disabled={disabled} placeholder="当前会话工作目录内的相对路径" /></label>
        <label className="block">显示名称（可选）<input aria-label="产物显示名称" className={INPUT} value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></label>
        <p className="text-ink-secondary">发布时保存文件快照。源文件之后修改或删除，已发布产物仍可下载。</p>
        <button type="submit" className={BUTTON} disabled={disabled || !path.trim()}>保存产物快照</button>
      </form>}
      {!artifacts.length ? <p className="py-2 text-ink-secondary">当前范围还没有已发布的产物。</p> : <ul className="divide-y divide-hairline">{artifacts.map((artifact) => <li key={artifact.id} data-personbot-artifact={artifact.id} className="min-w-0 py-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words font-medium">{artifact.name}</p><p className="mt-1 break-words text-[12px] text-ink-secondary">{artifact.mediaType} · {artifact.size.toLocaleString("zh-CN")} 字节{artifact.taskId ? " · 任务产物" : ""}</p></div><div className="flex flex-wrap gap-2">{artifactPreviewKind(artifact.mediaType) && <button type="button" className={BUTTON} aria-label={`预览产物：${artifact.name}`} onClick={() => setPreview(preview === artifact.id ? null : artifact.id)}>{preview === artifact.id ? "收起预览" : "预览"}</button>}<a className={BUTTON} href={artifactContentUrl(artifact.id)} download={artifact.name}>下载</a></div></div>
        {preview === artifact.id && <ArtifactPreview key={artifact.id} artifact={artifact} />}
      </li>)}</ul>}
    </div>
  </details>;
}
