import { useEffect, useState, useSyncExternalStore } from "react";
import { Boxes, CalendarClock, Folder, History, Menu, MessageSquare, Settings, X } from "lucide-react";
import { PersonbotClient } from "@/lib/personbot-client";
import type { PersonbotSetup } from "@/lib/personbot-product-client";
import { cn } from "@/lib/cn";
import { PersonbotView, type PersonbotSection } from "./PersonbotView";
import { PersonbotSetupPanel, PRODUCT_BUTTON } from "./PersonbotSetup";
import { PersonbotLegacy } from "./PersonbotLegacy";
import "./personbot.css";

type ProductPage = PersonbotSection | "setup" | "legacy";
const PAGES = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "tasks", label: "长期任务", icon: Boxes },
  { id: "personal", label: "项目与记忆", icon: Folder },
  { id: "artifacts", label: "产物", icon: Folder },
  { id: "integrations", label: "事件与渠道", icon: CalendarClock },
  { id: "legacy", label: "旧历史", icon: History },
  { id: "setup", label: "模型设置", icon: Settings },
] as const;

function initialPage(setup: PersonbotSetup): ProductPage {
  if (!setup.credential.configured) return "setup";
  const value = new URLSearchParams(location.hash.slice(1)).get("personbot");
  return PAGES.some((page) => page.id === value) ? value as ProductPage : "chat";
}

export function PersonbotProduct({ initialSetup }: { initialSetup: PersonbotSetup }) {
  const [setup, setSetup] = useState(initialSetup);
  const [page, setPage] = useState<ProductPage>(() => initialPage(initialSetup));
  const [menu, setMenu] = useState(false);
  const [client] = useState(() => new PersonbotClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const configured = setup.credential.configured;
  useEffect(() => {
    if (configured) client.start();
    else client.suspend();
  }, [client, configured]);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    const previous = document.title;
    document.title = "Personbot";
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    url.hash = `personbot=${page}`;
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [page]);
  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [menu]);
  const navigate = (next: ProductPage) => { setPage(next); setMenu(false); };
  const saved = (value: PersonbotSetup) => {
    setSetup(value);
    if (value.credential.configured && !value.restartRequired && configured) client.retry();
  };
  const awaiting = state.tasks.tasks.filter((task) => task.lifecycle === "open" && task.stage === "awaiting_review").length;
  const productSection = page !== "setup" && page !== "legacy" ? page : undefined;
  return <div data-personbot-product="" className="personbot-product flex h-full min-h-0 flex-col bg-app text-ink">
    <header className="personbot-product-mobile">
      <button type="button" className={PRODUCT_BUTTON} aria-label="打开 Personbot 导航" aria-expanded={menu} onClick={() => setMenu(true)}><Menu size={18} /></button>
      <span className="text-[16px] font-semibold">Personbot</span><span className="text-[12px] text-ink-secondary">个人工作区</span>
    </header>
    <div className="relative flex min-h-0 flex-1">
      {menu && <button type="button" className="personbot-product-scrim" aria-label="关闭 Personbot 导航" onClick={() => setMenu(false)} />}
      <aside className={cn("personbot-product-sidebar", menu && "is-open")} aria-label="Personbot 工作区">
        <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-6 pt-2">
          <div className="min-w-0"><p className="text-[20px] font-semibold tracking-tight">Personbot<span className="ms-1 text-[14px] font-normal text-ink-secondary">/</span></p><p className="mt-1 text-[12px] text-ink-secondary">个人工作区 · dsh</p></div>
          <button type="button" className="personbot-product-close" aria-label="收起 Personbot 导航" onClick={() => setMenu(false)}><X size={18} /></button>
        </div>
        <nav aria-label="Personbot 导航" className="space-y-1">
          {PAGES.map(({ id, label, icon: Icon }) => <button key={id} type="button" data-personbot-nav={id} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)} className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px] transition-colors hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", page === id ? "bg-raised font-medium text-ink" : "text-ink-secondary")}>
            <Icon size={17} strokeWidth={1.6} aria-hidden="true" /><span className="flex-1">{label}</span>{id === "tasks" && awaiting > 0 && <span className="text-[12px]" aria-label={`${awaiting} 项任务待验收`}>{awaiting}</span>}
          </button>)}
        </nav>
        <div className="mt-auto px-3 pt-8 text-[12px] leading-5 text-ink-secondary">
          <p>{configured ? state.connection === "connected" ? "运行时已连接" : state.connection === "connecting" ? "正在连接运行时" : "运行时等待连接" : "等待连接模型"}</p>
          <p className="mt-2 break-all">{setup.provider} / {setup.model}</p>
          <p className="mt-3">对话、任务和产物保存在本机。</p>
        </div>
      </aside>
      <div className="personbot-product-canvas min-h-0 min-w-0 flex-1">
        {page === "setup" && <PersonbotSetupPanel setup={setup} onSaved={saved} />}
        {page === "legacy" && <PersonbotLegacy configured={configured} onImported={(sessionId) => { void client.select(sessionId); navigate("chat"); }} />}
        {configured && <div className={cn("min-h-0 min-w-0 flex-1 flex-col", productSection ? "flex" : "hidden")}><PersonbotView client={client} primary section={productSection ?? "chat"} onNavigate={navigate} /></div>}
        {!configured && productSection && <section className="personbot-product-page"><h1 className="text-[24px] font-semibold">{PAGES.find((entry) => entry.id === page)?.label}</h1><p className="mt-3 text-[14px] leading-6 text-ink-secondary">先连接模型，之后可以创建会话、安排长期任务和接收外部事件。</p><button type="button" className={cn(PRODUCT_BUTTON, "mt-6")} onClick={() => navigate("setup")}>连接 DeepSeek</button></section>}
      </div>
    </div>
  </div>;
}
