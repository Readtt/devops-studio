import { TestCasePane } from "./TestCasePane";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Mounts at most one TestCasePane per open `test-case` tab. Inactive panes
 * are hidden but kept mounted so re-activation is instant — matches the
 * pattern used by EditorStack/MarkdownStack.
 */
export function TestCaseStack({ tabs, activeId }: Props) {
  const caseTabs = tabs.filter((t) => t.kind === "test-case");
  if (caseTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {caseTabs.map((t) => {
        if (t.kind !== "test-case") return null;
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
            <TestCasePane caseId={t.caseId} />
          </div>
        );
      })}
    </div>
  );
}
