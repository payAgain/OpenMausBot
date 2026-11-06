import { Bot } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

export function SidebarPersonbotButton({ iconsOnly = false, rail = false }: { iconsOnly?: boolean; rail?: boolean }) {
  const { state, dispatch } = useStore();
  return (
    <button
      type="button"
      data-sidebar-nav="personbot"
      aria-label="Personbot"
      title={iconsOnly ? "Personbot" : undefined}
      aria-current={state.activeView === "personbot" ? "page" : undefined}
      onClick={() => dispatch({ type: "showPersonbot" })}
      className={cn(
        "flex shrink-0 items-center rounded-xl text-[14px] font-medium text-ink transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        iconsOnly ? rail ? "size-11 justify-center" : "mx-auto size-[46px] justify-center" : "min-h-11 w-full gap-3 px-3 py-2 text-left",
        state.activeView === "personbot" ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <Bot size={18} className="shrink-0 text-ink-secondary" />
      {!iconsOnly && <><span className="flex-1">Personbot</span><span className="text-[12px] text-ink-secondary">dsh</span></>}
    </button>
  );
}
