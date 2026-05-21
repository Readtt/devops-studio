import { BugPane } from "./BugPane";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  sourceRoot?: string | null;
};

export function BugStack({ tabs, activeId, sourceRoot }: Props) {
  const bugTabs = tabs.filter((t) => t.kind === "bug");
  if (bugTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {bugTabs.map((t) => {
        if (t.kind !== "bug") return null;
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
            <BugPane bugId={t.bugId} sourceRoot={sourceRoot ?? null} />
          </div>
        );
      })}
    </div>
  );
}
