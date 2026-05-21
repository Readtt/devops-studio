import { CodeViewerPane } from "./CodeViewerPane";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/** Mounts one CodeViewerPane per open `code-viewer` tab. Inactive panes are
 *  hidden but kept mounted so switching tabs is instant (same pattern as
 *  TestCaseStack). */
export function CodeViewerStack({ tabs, activeId }: Props) {
  const viewerTabs = tabs.filter((t) => t.kind === "code-viewer");
  if (viewerTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {viewerTabs.map((t) => {
        if (t.kind !== "code-viewer") return null;
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{ visibility: visible ? "visible" : "hidden" }}
            aria-hidden={!visible}
          >
            <CodeViewerPane
              path={t.path}
              startLine={t.startLine}
              endLine={t.endLine}
            />
          </div>
        );
      })}
    </div>
  );
}
