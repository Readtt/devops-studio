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
  /** Absolute path on disk. */
  path: string;
  /** Repo the path was resolved to, for the header's `<repo>/…` form and the
   *  basename-collision title prefix. Absent when the path couldn't be
   *  attributed (outside every configured repo) or on tabs persisted before
   *  multi-repo — dedup is on the absolute path, which is unambiguous either
   *  way, so nothing depends on it being set. */
  repoName?: string | null;
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

export type CommitReviewTab = TabBase & {
  kind: "commit-review";
  /** @deprecated Nothing reads this. A review spans every configured repo now,
   *  so there is no single directory to pin to — but tabs persisted before that
   *  still carry the field, and the persist store has no `migrate`, so it stays
   *  declared to document the shape on disk. Never write it. */
  cwd?: string | null;
  /** The changes selected in the picker, as `${repoId}:${sha}` keys (bare SHAs
   *  on tabs persisted before multi-repo — normalised on read). Autosaved so
   *  Duplicate carries the selection. Empty/absent ⇒ a default is picked on
   *  mount. */
  selectedShas?: string[] | null;
  /** Freeform "Add context" draft (the ticket / requirements). Autosaved so a
   *  reload during input doesn't lose it. */
  context?: string | null;
  /** Per-tab pinned model. Null/absent ⇒ inherit the global default. */
  modelId?: import("@/modules/ai/config").ModelId | null;
  /** When set, hydrate a saved run (its findings + input) from SQLite on mount.
   *  Surfaces when the user reopens a past review from the History tab. */
  rehydrateRunId?: string | null;
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
  | CommitReviewTab;

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
