import { SuiteChatPane } from "./SuiteChatPane";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Mounts at most one SuiteChatPane per open `suite-chat` tab. Inactive panes
 * stay mounted so re-activating a chat keeps the thread + scroll position
 * intact — closing the tab is the only way to lose state.
 */
export function SuiteChatStack({ tabs, activeId }: Props) {
  const chatTabs = tabs.filter((t) => t.kind === "suite-chat");
  if (chatTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {chatTabs.map((t) => {
        if (t.kind !== "suite-chat") return null;
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={
              visible
                ? "pointer-events-auto absolute inset-0"
                : "absolute inset-0"
            }
            style={{ visibility: visible ? "visible" : "hidden" }}
            aria-hidden={!visible}
          >
            <SuiteChatPane planId={t.planId} suiteId={t.suiteId} />
          </div>
        );
      })}
    </div>
  );
}
