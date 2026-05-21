// Minimal tab type union used by TestCaseStack and GeneratorStack.
//
// The full tab system (terminal/editor/preview/markdown/diff/git history) was
// deleted in Phase 1B of the QA-tool refactor. App.tsx now owns its own tab
// state inline. This module survives only to provide the structural `Tab`
// type that the stacks pattern-match against, plus the kinds we'll need as
// new surfaces land (`bug`, `code-viewer`, `generation-history`).

export type TestCaseTab = {
  id: number;
  kind: "test-case";
  title: string;
  caseId: number;
};

export type GeneratorTab = {
  id: number;
  kind: "generator";
  title: string;
  initialPlanId: number | null;
  initialSuiteId: number | null;
};

export type BugTab = {
  id: number;
  kind: "bug";
  title: string;
  bugId: number;
};

export type CodeViewerTab = {
  id: number;
  kind: "code-viewer";
  title: string;
  /** Absolute path inside the user's chosen source directory. */
  path: string;
  startLine?: number;
  endLine?: number;
};

export type GenerationHistoryTab = {
  id: number;
  kind: "generation-history";
  title: string;
  runId: string;
};

export type Tab =
  | TestCaseTab
  | GeneratorTab
  | BugTab
  | CodeViewerTab
  | GenerationHistoryTab;
