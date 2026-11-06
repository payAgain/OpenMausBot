import { useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { ProductCommand, readProductSetup, type PersonbotSetup } from "@/lib/personbot-product-client";
import { cn } from "@/lib/cn";
import { PERSONBOT_MODELS, type PersonbotSetupSaveResult } from "../../../shared/personbot-product.ts";
import { ApiError } from "@/state/api";

export const PRODUCT_BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[14px] text-ink transition-colors enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
export const PRODUCT_INPUT = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function PersonbotSetupPanel({ setup, onSaved, embedded = false }: { setup: PersonbotSetup; onSaved(value: PersonbotSetup): void; embedded?: boolean }) {
  const [model, setModel] = useState(setup.model);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const command = useRef(new ProductCommand());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      await command.current.send<PersonbotSetupSaveResult>("/api/personbot/setup", {
        expectedRevision: setup.revision, model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      });
      setApiKey(""); setClearApiKey(false); setSaved(true);
      onSaved(await readProductSetup());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存模型设置");
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        try { onSaved(await readProductSetup()); } catch {}
      }
    } finally { setBusy(false); }
  };
  return <section aria-label={embedded ? "Super Agent 模型设置" : "Personbot 模型设置"} className={embedded ? "space-y-4" : "personbot-product-page personbot-product-settings"}>
    <header className={embedded ? "" : "mb-8"}>
      {embedded ? <h3 className="text-[14px] font-medium text-ink">DSH Super Agent</h3> : <h1 className="text-[24px] font-semibold">模型设置</h1>}
      <p className={cn("mt-2 max-w-[64ch] text-ink-secondary", embedded ? "text-[13px] leading-5" : "text-[14px] leading-6")}>{embedded ? "使用官方 Super Agent 执行会话和任务。模型与 API key 在本机服务端保存。" : setup.credential.configured ? "Personbot 使用 dsh 执行模型与工具。凭据只在服务端保存。" : "连接你的 DeepSeek 账号，开始第一个会话。API key 只会提交给本机服务。"}</p>
    </header>
    <form onSubmit={(event) => void submit(event)} className="max-w-[680px] space-y-6">
      <div className="rounded-lg border border-hairline bg-card p-5">
        <p className="text-[14px] font-medium">模型供应商</p>
        <p className="mt-2 text-[14px]">{setup.provider === "deepseek-official" ? "DeepSeek 官方 API" : setup.provider}</p>
        <label className="mt-5 block text-[14px]">模型名称
          {setup.provider === "deepseek-official" ? <select aria-label={embedded ? "Super Agent 模型名称" : "Personbot 模型名称"} value={model} onChange={(event) => { setModel(event.target.value); setSaved(false); }} disabled={busy} className={PRODUCT_INPUT}>{PERSONBOT_MODELS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
            : <input aria-label="Personbot 模型名称" value={model} onChange={(event) => { setModel(event.target.value); setSaved(false); }} required maxLength={200} disabled={busy} className={PRODUCT_INPUT} />}
        </label>
        <label className="mt-5 block text-[14px]">{setup.credential.source === "environment" ? "DeepSeek API key（由启动环境管理）" : setup.credential.configured ? "替换 API key（留空保留现有凭据）" : "DeepSeek API key"}
          <input aria-label="DeepSeek API key" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); setSaved(false); }} type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={busy || setup.credential.source === "environment"} className={PRODUCT_INPUT} />
        </label>
        <p className="mt-2 text-[12px] leading-5 text-ink-secondary">凭据状态：{setup.credential.source === "environment" ? "由启动环境提供" : setup.credential.source === "saved" ? "已保存，内容不可读取" : "尚未配置"}。保存后不会在界面中回显密钥。</p>
        {setup.credential.source === "saved" && <label className="mt-4 flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={clearApiKey} disabled={busy || !!apiKey.trim()} onChange={(event) => { setClearApiKey(event.target.checked); setSaved(false); }} />移除已保存的 API key</label>}
      </div>
      <div className="text-[13px] leading-6 text-ink-secondary">
        <p>工作目录</p><p className="break-all text-ink">{setup.workspace}</p>
        <p className="mt-3">已有会话保留自己的目录绑定。模型设置会在{embedded ? "服务" : " Personbot 服务"}下次启动时应用；重启前请先停止活动会话和任务。</p>
      </div>
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-[14px] text-danger">{error}</p>}
      {setup.restartRequired && <p role="status" className="text-[14px] text-ink-secondary">配置已保存。请先停止活动任务和会话，再重启{embedded ? "服务" : " Personbot 服务"}使新配置生效。</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !model.trim()} className={cn(PRODUCT_BUTTON, "bg-ink text-app enabled:hover:bg-ink/85 disabled:bg-raised")}>{busy && <LoaderCircle size={16} className="animate-spin" />}保存模型设置</button>
        {saved && <span role="status" className="inline-flex items-center gap-2 text-[13px]"><Check size={15} />已保存</span>}
      </div>
    </form>
  </section>;
}
