import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { SessionState } from "./store/useGenerationSession";

export type GeneratorCallbacks = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onRenameTab: (tabId: number, title: string) => void;
  onReportSession: (
    tabId: number,
    next: {
      phase: SessionState["phase"];
      isRefining: boolean;
      runId: string | null;
    },
  ) => void;
};

const GeneratorCallbacksContext = createContext<GeneratorCallbacks | null>(null);

export function GeneratorCallbacksProvider({
  value,
  children,
}: {
  value: GeneratorCallbacks;
  children: ReactNode;
}) {
  return (
    <GeneratorCallbacksContext.Provider value={value}>
      {children}
    </GeneratorCallbacksContext.Provider>
  );
}

export function useGeneratorCallbacks(): GeneratorCallbacks {
  const ctx = useContext(GeneratorCallbacksContext);
  if (!ctx) {
    throw new Error(
      "useGeneratorCallbacks must be called inside <GeneratorCallbacksProvider>",
    );
  }
  return ctx;
}
