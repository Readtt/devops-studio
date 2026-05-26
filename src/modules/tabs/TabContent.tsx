import { memo, useEffect } from "react";
import { TestCasePane } from "@/modules/test-plans/TestCasePane";
import { BugPane } from "@/modules/test-plans/BugPane";
import { SuiteChatPane } from "@/modules/test-plans/SuiteChatPane";
import { CodeViewerPane } from "@/modules/code-viewer/CodeViewerPane";
import { GeneratorPane } from "@/modules/generator/GeneratorPane";
import { GenerationSessionProvider } from "@/modules/generator/store/useGenerationSession";
import { useGeneratorStoresApi } from "@/modules/generator/storesContext";
import { useGeneratorCallbacks } from "@/modules/generator/callbacksContext";
import { getRun } from "@/modules/generator/lib/history";
import { TerminalPane } from "@/modules/terminal/TerminalPane";
import { CodeReviewPane } from "@/modules/code-review/CodeReviewPane";
import { ConfidencePane } from "@/modules/test-plans/components/ConfidencePane";
import type { AppTab, GeneratorTab } from "./store/types";

type Props = {
  tab: AppTab;
  sourceRoot: string | null;
  /** Leaf this tab is rendered in. Lets a pane open a sibling beside itself
   *  (the confidence pane opens code in the adjacent leaf). */
  leafId: string;
};

/**
 * Kind dispatcher. Memoized on (tab, sourceRoot, leafId) — switching between
 * two tabs in the same leaf doesn't re-render any tab content other than the
 * two involved.
 */
export const TabContent = memo(function TabContent({
  tab,
  sourceRoot,
  leafId,
}: Props) {
  switch (tab.kind) {
    case "test-case":
      return (
        <TestCasePane
          caseId={tab.caseId}
          planId={tab.planId ?? null}
          suiteId={tab.suiteId ?? null}
        />
      );
    case "bug":
      return <BugPane bugId={tab.bugId} sourceRoot={sourceRoot} />;
    case "code-viewer":
      return (
        <CodeViewerPane
          path={tab.path}
          startLine={tab.startLine}
          endLine={tab.endLine}
        />
      );
    case "suite-chat":
      return (
        <SuiteChatPane
          planId={tab.planId}
          suiteId={tab.suiteId}
          boundThreadId={tab.threadId ?? null}
        />
      );
    case "generator":
      return <GeneratorTabContent tab={tab} />;
    case "terminal":
      return (
        <TerminalPane
          tabId={tab.id}
          sessionId={tab.sessionId}
          cwd={tab.cwd}
          shellId={tab.shellId}
        />
      );
    case "code-review":
      return (
        <CodeReviewPane
          tabId={tab.id}
          cwd={tab.cwd}
          base={tab.base}
          source={tab.source ?? null}
          rehydrateThreadId={tab.rehydrateThreadId ?? null}
        />
      );
    case "confidence":
      return (
        <ConfidencePane
          tabId={tab.id}
          leafId={leafId}
          caseTitle={tab.caseTitle}
          verdict={tab.verdict}
          caseId={tab.caseId ?? null}
        />
      );
  }
});

function GeneratorTabContent({ tab }: { tab: GeneratorTab }) {
  const storesApi = useGeneratorStoresApi();
  const callbacks = useGeneratorCallbacks();
  // getOrCreate is stable identity per tabId; the store survives leaf moves.
  const store = storesApi.getOrCreate(tab.id);

  // After a window reload, generator tabs with a runId are restored from
  // localStorage but their per-tab session store is brand-new (initial state
  // = phase "input"). Without this rehydrate the user lands on an empty
  // input form even though their draft is safe on disk — the on-disk runId
  // is the bridge. Loading the saved run here restores review (or done)
  // before GeneratorPane reads phase on its first paint.
  useEffect(() => {
    const tabRunId = tab.runId;
    if (!tabRunId) return;
    const snapshot = store.getState();
    if (snapshot.runId === tabRunId) return;
    // Only auto-rehydrate when the session is genuinely empty. Skipping
    // when the user already typed something prevents stomping a fresh
    // draft just because the tab also carries a stale runId.
    const isEmpty =
      snapshot.phase === "input" &&
      snapshot.cases.length === 0 &&
      snapshot.bugs.length === 0 &&
      snapshot.requirements.length === 0;
    if (!isEmpty) return;

    let cancelled = false;
    void (async () => {
      try {
        const run = await getRun(tabRunId);
        if (cancelled || !run) return;
        const latest = store.getState();
        // Re-check the guards — the user might have started typing while
        // the fetch was in flight; we don't want to clobber that work.
        if (latest.runId === tabRunId) return;
        if (
          latest.phase !== "input" ||
          latest.cases.length > 0 ||
          latest.bugs.length > 0 ||
          latest.requirements.length > 0
        ) {
          return;
        }
        if (run.status === "published") {
          latest.loadPublishedRun(run);
        } else {
          latest.loadDraft(run);
        }
      } catch (e) {
        console.warn("[generator] rehydrate-from-runId failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, tab.runId]);

  return (
    <GenerationSessionProvider store={store}>
      <GeneratorPane
        tabId={tab.id}
        initialPlanId={tab.initialPlanId}
        initialSuiteId={tab.initialSuiteId}
        onOpenCase={callbacks.onOpenCase}
        onRenameTab={callbacks.onRenameTab}
        onReportSession={callbacks.onReportSession}
      />
    </GenerationSessionProvider>
  );
}
