import { memo } from "react";
import { TestCasePane } from "@/modules/test-plans/TestCasePane";
import { BugPane } from "@/modules/test-plans/BugPane";
import { SuiteChatPane } from "@/modules/test-plans/SuiteChatPane";
import { CodeViewerPane } from "@/modules/code-viewer/CodeViewerPane";
import { GeneratorPane } from "@/modules/generator/GeneratorPane";
import { GenerationSessionProvider } from "@/modules/generator/store/useGenerationSession";
import { useGeneratorStoresApi } from "@/modules/generator/storesContext";
import { useGeneratorCallbacks } from "@/modules/generator/callbacksContext";
import type { AppTab, GeneratorTab } from "./store/types";

type Props = {
  tab: AppTab;
  sourceRoot: string | null;
};

/**
 * Kind dispatcher. Memoized on (tab, sourceRoot) — switching between two
 * tabs in the same leaf doesn't re-render any tab content other than the
 * two involved.
 */
export const TabContent = memo(function TabContent({ tab, sourceRoot }: Props) {
  switch (tab.kind) {
    case "test-case":
      return <TestCasePane caseId={tab.caseId} />;
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
      return <SuiteChatPane planId={tab.planId} suiteId={tab.suiteId} />;
    case "generator":
      return <GeneratorTabContent tab={tab} />;
  }
});

function GeneratorTabContent({ tab }: { tab: GeneratorTab }) {
  const storesApi = useGeneratorStoresApi();
  const callbacks = useGeneratorCallbacks();
  // getOrCreate is stable identity per tabId; the store survives leaf moves.
  const store = storesApi.getOrCreate(tab.id);
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
