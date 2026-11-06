import { useEffect, useState } from "react";
import { readProductSetup, readSuperagentCapabilities, type PersonbotSetup } from "@/lib/personbot-product-client";
import type { SuperagentCapabilities } from "../../shared/superagent-capabilities";
import { useStore } from "@/state/store";
import { PersonbotSetupPanel } from "./personbot/PersonbotSetup";
import { SuperagentRuntimeStatus } from "./SuperagentRuntimeStatus";

export function SuperagentModelSettings() {
  const { refreshInstances } = useStore();
  const [setup, setSetup] = useState<PersonbotSetup>();
  const [error, setError] = useState("");
  const [capabilities, setCapabilities] = useState<SuperagentCapabilities>();
  useEffect(() => {
    const abort = new AbortController();
    void readProductSetup(abort.signal).then(setSetup).catch(failure => {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取模型设置");
    });
    void readSuperagentCapabilities(abort.signal).then(setCapabilities).catch(() => {});
    return () => abort.abort();
  }, []);
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!setup) return <p role="status" className="text-sm text-ink-secondary">正在读取 Super Agent 模型设置…</p>;
  return <div className="space-y-3">
    <PersonbotSetupPanel setup={setup} onSaved={value => {
      setSetup(value);
      void refreshInstances().catch(() => {});
    }} embedded />
    <SuperagentRuntimeStatus />
    {capabilities && <details className="rounded-lg border border-hairline p-3 text-sm">
      <summary className="cursor-pointer text-ink-secondary">当前运行时支持的能力</summary>
      <ul className="mt-2 space-y-2">{capabilities.features.map(feature => <li key={feature.id}>
        <span className={feature.available ? "text-ink" : "text-ink-secondary"}>{feature.available ? "已支持" : "未接入"} · {feature.label}</span>
        {feature.reason && <p className="text-xs text-ink-secondary">{feature.reason}</p>}
      </li>)}</ul>
    </details>}
  </div>;
}
