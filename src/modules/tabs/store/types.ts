type TabBase = { id: number; title: string; pinned: boolean };

export type TestCaseTab = TabBase & {
  kind: "test-case";
  caseId: number;
};

export type GeneratorTab = TabBase & {
  kind: "generator";
  initialPlanId: number | null;
  initialSuiteId: number | null;
  /** Run id once the live session commits to one (or pre-set for "Open in
   *  review"). Null for a fresh tab — those are dropped on persist-rehydrate
   *  since they have no draft to restore. */
  runId: string | null;
};

export type CodeViewerTab = TabBase & {
  kind: "code-viewer";
  /** Absolute path inside the user's source root. */
  path: string;
  startLine?: number;
  endLine?: number;
};

export type BugTab = TabBase & {
  kind: "bug";
  bugId: number;
};

export type SuiteChatTab = TabBase & {
  kind: "suite-chat";
  planId: number;
  suiteId: number;
};

export type CodeReviewTab = TabBase & {
  kind: "code-review";
  /** Source directory the diff is computed against. */
  cwd: string;
  /** Base branch; null defers to backend fallback (main → master → origin/HEAD). */
  base: string | null;
};

export type TerminalTab = TabBase & {
  kind: "terminal";
  /** Working directory the shell launches in. `null` lets `pty_spawn` use
   *  whatever the app's process cwd is at the time. */
  cwd: string | null;
  /** Optional shell id override (matches a `ShellCandidate.id` from
   *  `detect_shells`). When null, `pty_spawn` falls back to `defaultShellPath`
   *  from preferences, then platform default. */
  shellId: string | null;
  /** Renderer-minted session id (UUID v4). Generated when the tab is opened
   *  so the PTY event channel name is stable across remounts. PTY state
   *  itself doesn't survive a window reload — `useTabsStore.merge` drops
   *  terminal tabs on rehydrate so the user gets a fresh shell. */
  sessionId: string;
};

export type AppTab =
  | TestCaseTab
  | GeneratorTab
  | CodeViewerTab
  | BugTab
  | SuiteChatTab
  | TerminalTab
  | CodeReviewTab;

export type TabKind = AppTab["kind"];

/**
 * Recursive pane tree. Splits hold ordered children with size percentages
 * matching `react-resizable-panels`' `defaultSize` (numbers in [0, 100]).
 * Leaves hold an ordered list of tab ids and a pointer to the active one.
 */
export type SplitNode = {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: PaneNode[];
};

export type LeafNode = {
  kind: "leaf";
  id: string;
  tabIds: number[];
  activeTabId: number | null;
};

export type PaneNode = SplitNode | LeafNode;

export type ClosedTabSnapshot = {
  tab: AppTab;
  leafId: string;
  index: number;
  closedAt: number;
};
