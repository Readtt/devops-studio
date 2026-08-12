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
import { getCheckpoint, checkpointIsNewer } from "@/modules/ai/lib/checkpointApi";
import { TerminalPane } from "@/modules/terminal/TerminalPane";
import { CommitReviewPane } from "@/modules/commit-review/CommitReviewPane";
import type { AppTab, GeneratorTab } from "./store/types";

type Props = {
  tab: AppTab;
};

/**
 * Kind dispatcher. Memoized on the tab — switching between two tabs in the
 * same leaf doesn't re-render any tab content other than the two involved.
 */
export const TabContent = memo(function TabContent({ tab }: Props) {
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
      return <BugPane bugId={tab.bugId} />;
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
    case "commit-review":
      return (
        <CommitReviewPane
          tabId={tab.id}
          cwd={tab.cwd}
          modelId={tab.modelId ?? null}
          rehydrateRunId={tab.rehydrateRunId ?? null}
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
        const [run, checkpointRow] = await Promise.all([
          getRun(tabRunId),
          getCheckpoint(tabRunId),
        ]);
        if (cancelled) return;
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
        // A foreign-surface row can't reach this runId in practice (checkpoints
        // are keyed per-surface), but the payload is a union — narrow before
        // handing it to the generator-only loadCheckpoint.
        const cpPayload = checkpointRow?.payload;
        const cp =
          checkpointRow && cpPayload && cpPayload.surface === "generator"
            ? { payload: cpPayload, updatedAt: checkpointRow.updatedAt }
            : null;
        if (!run && !cp) return;
        // Second-granularity compare, not lexicographic and not millisecond:
        // a history row's timestamp comes from newTimestamp() (millis
        // stripped) while a checkpoint's updatedAt keeps them, so a
        // millisecond Date.parse compare would let a checkpoint written just
        // BEFORE a same-second draft save win. checkpointIsNewer ties at
        // second granularity (history wins) and treats unparseable dates as
        // "not newer", which correctly defaults to the history row.
        const cpIsNewer = !!cp && !!run && checkpointIsNewer(cp.updatedAt, run.timestamp);
        if (cp && (!run || cpIsNewer)) {
          latest.loadCheckpoint(cp.payload, cp.updatedAt);
        } else if (run) {
          if (run.status === "published") {
            latest.loadPublishedRun(run);
          } else {
            latest.loadDraft(run);
          }
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
