import { useEffect, useState } from "react";
import type { SuperagentSnapshot } from "../../shared/superagent";
import { readSuperagentResources, reconcileSuperagentWorkspace } from "@/lib/personbot-product-client";
import { ConfirmDialog } from "./ConfirmDialog";

export function SuperagentRuntimeStatus() {
  const [resources, setResources] = useState<SuperagentSnapshot["resources"]>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void readSuperagentResources(abort.signal).then(setResources).catch(() => {
      if (!abort.signal.aborted) setError("无法读取运行时资源状态");
    });
    return () => abort.abort();
  }, []);
  const refresh = async () => {
    try { setResources(await readSuperagentResources()); setError(""); }
    catch { setError("无法读取运行时资源状态"); }
  };
  const reconcile = async () => {
    if (!selected || pending) return;
    setPending(true);
    try {
      await reconcileSuperagentWorkspace(selected);
      setSelected(undefined);
      await refresh();
    } catch { setError("无法解除此工作目录的写入隔离，请刷新后重试"); }
    finally { setPending(false); }
  };
  return <div className="space-y-2 text-sm" data-superagent-resources="">
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-secondary">{resources
        ? `模型调用 ${resources.activeCalls}/${resources.maxConcurrentCalls} · 排队 ${resources.queuedCalls}`
        : "运行时资源状态"}</span>
      <button type="button" onClick={() => { void refresh(); }} className="rounded-md px-2 py-1 text-ink-secondary hover:bg-raised hover:text-ink">刷新</button>
    </div>
    {resources && <p className="text-xs text-ink-secondary">
      输入 {resources.inputTokens.toLocaleString()} tokens · 输出 {resources.outputTokens.toLocaleString()} tokens
      {(resources.unpricedCalls ?? 0) > 0 ? ` · ${resources.unpricedCalls} 次调用尚无可靠费用` : ""}
    </p>}
    {resources?.tokenLimit !== undefined && <p className="text-xs text-ink-secondary">
      累计 token 额度：{(resources.inputTokens + resources.outputTokens).toLocaleString()} / {resources.tokenLimit.toLocaleString()}
    </p>}
    {resources?.requestLimit !== undefined && <p className="text-xs text-ink-secondary">
      累计模型调用额度：{resources.admittedCalls ?? 0} / {resources.requestLimit}
    </p>}
    {resources?.costLimitUsd !== undefined && <p className="text-xs text-ink-secondary">
      费用额度：${resources.costLimitUsd}；存在未计价调用时，后续模型调用会暂停。
    </p>}
    {resources && (resources.tokenLimit !== undefined || resources.requestLimit !== undefined || resources.costLimitUsd !== undefined)
      && <p className="text-xs text-ink-secondary">达到额度后暂停新的模型调用；已开始的调用、审批和结果投递继续处理。</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {resources?.quarantinedWorkspaces?.map(item => <div key={item.id} className="space-y-1 rounded-lg border border-hairline p-3">
      <p className="text-ink">此目录的写入已隔离</p>
      <p className="break-all text-xs text-ink-secondary">{item.workspace}</p>
      <p className="text-xs text-ink-secondary">{item.reason}</p>
      <button type="button" className="rounded-md px-2 py-1.5 text-ink hover:bg-raised" onClick={() => setSelected(item.id)}>检查后解除隔离</button>
    </div>)}
    <ConfirmDialog open={Boolean(selected)} title="解除工作目录写入隔离？"
      body="请先确认相关外部工具进程已经停止，并检查目录中的文件状态。解除后，等待中的任务可以再次写入此目录。"
      confirmLabel="已检查，解除隔离" cancelLabel="取消" pending={pending}
      onCancel={() => { if (!pending) setSelected(undefined); }} onConfirm={() => { void reconcile(); }} />
  </div>;
}
