type TabBase = { id: number; title: string; pinned: boolean };

export type TestCaseTab = TabBase & {
  kind: "test-case";
  caseId: number;
  /** Execution context: the plan + suite this case was opened from. Lets the
   *  TestCasePane record a Pass/Fail/Blocked outcome against the right test
   *  point without a picker. Absent when the case was opened from a surface
   *  with no suite context (search, history, a bug's linked items) — the
   *  Execute bar then offers a suite picker. Dedup is still by caseId alone
   *  (one case == one tab); reopening from a different suite retargets the
   *  existing tab's context. */
  planId?: number | null;
  suiteId?: number | null;
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
  /** Optional thread pin. When set, the tab is bound to one specific
   *  conversation on this suite and dedups against other tabs with the
   *  same threadId. Null/undefined = "follow whatever thread is active
   *  on this suite" — opened from the suite tree context menu or any
   *  surface that doesn't name a specific thread. The two states coexist
   *  cleanly: a no-thread tab + thread-A tab + thread-B tab are three
   *  separate tabs on the same suite. */
  threadId?: string | null;
};

export type CodeReviewTab = TabBase & {
  kind: "code-review";
  /** Source directory the diff is computed against. */
  cwd: string;
  /** Base branch; null defers to backend fallback (main → master → origin/HEAD). */
  base: string | null;
  /** When set, review an Azure DevOps commit/PR/branch instead of the local
   *  working-copy diff. Absent ⇒ local. */
  source?: import("@/modules/code-review/source").CodeReviewSource | null;
  /** Per-tab pinned model. Null/absent ⇒ inherit the global default. Persisted
   *  so the chosen model survives a reload. */
  modelId?: import("@/modules/ai/config").ModelId | null;
  /** When set, hydrate this tab's conversation from useCodeReviewHistory
   *  on mount. Surfaces when the user reopens a past review from the
   *  Chats sidebar. The current diff still loads from disk (the prior
   *  diff is not stored), but messages are restored verbatim. */
  rehydrateThreadId?: string | null;
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

export type ConfidenceTab = TabBase & {
  kind: "confidence";
  /** Title of the case the verdict is for (header + tab label). */
  caseTitle: string;
  /** The verdict snapshot. Persisted so the detail survives a reload without
   *  needing the originating draft/case to still be open. */
  verdict: import("@/modules/test-plans/lib/confidence").ConfidenceVerdict;
  /** Dedup identity: `case-<id>` for a published case, `draft-<uid>` for a
   *  generator review draft. Re-opening the chip re-focuses this pane. */
  evalKey: string;
  /** Set for a published case — enables Re-evaluate (fetch → eval → save). */
  caseId?: number | null;
};

export type AppTab =
  | TestCaseTab
  | GeneratorTab
  | CodeViewerTab
  | BugTab
  | SuiteChatTab
  | TerminalTab
  | CodeReviewTab
  | ConfidenceTab;

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
