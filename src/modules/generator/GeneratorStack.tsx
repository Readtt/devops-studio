import type { MutableRefObject } from "react";
import { GeneratorPane } from "./GeneratorPane";
import {
  GenerationSessionProvider,
  type GenerationSessionStore,
  type SessionState,
} from "./store/useGenerationSession";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenCase?: (input: { caseId: number; title: string }) => void;
  /** Per-tab generator stores. Each generator tab id maps to its own
   *  isolated Zustand store; this lets the user keep multiple drafts open
   *  in parallel without trampling state. */
  storesRef: MutableRefObject<Map<number, GenerationSessionStore>>;
  /** Rename callback wired up to the App's tab list. The pane invokes this
   *  when the session moves into review and the title should reflect the
   *  draft's first case (instead of staying "Generate cases" forever). */
  onRenameTab: (tabId: number, title: string) => void;
  /** Lift the session's phase + isRefining flags up so the StatusBarModelPicker
   *  (outside Provider scope) can lock the model when the active tab is in
   *  a draft / mid-refine. */
  onReportSession: (
    tabId: number,
    next: { phase: SessionState["phase"]; isRefining: boolean },
  ) => void;
};

export function GeneratorStack({
  tabs,
  activeId,
  onOpenCase,
  storesRef,
  onRenameTab,
  onReportSession,
}: Props) {
  // Render every generator tab simultaneously — the inactive ones are
  // hidden via CSS visibility so an in-flight analyze in tab A keeps
  // streaming while the user reviews tab B.
  const generators = tabs.filter((t) => t.kind === "generator");
  if (generators.length === 0) return null;

  return (
    <>
      {generators.map((gen) => {
        if (gen.kind !== "generator") return null;
        const store = storesRef.current.get(gen.id);
        if (!store) return null;
        const visible = gen.id === activeId;
        return (
          <div
            key={gen.id}
            className={
              visible
                ? "pointer-events-auto absolute inset-0"
                : "absolute inset-0"
            }
            style={{ visibility: visible ? "visible" : "hidden" }}
            aria-hidden={!visible}
          >
            <GenerationSessionProvider store={store}>
              <GeneratorPane
                tabId={gen.id}
                initialPlanId={gen.initialPlanId}
                initialSuiteId={gen.initialSuiteId}
                onOpenCase={onOpenCase}
                onRenameTab={onRenameTab}
                onReportSession={onReportSession}
              />
            </GenerationSessionProvider>
          </div>
        );
      })}
    </>
  );
}
