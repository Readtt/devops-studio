// Per-tab store for the Commit Review surface. Module-level (survives a React
// unmount from a pane split/merge, like the terminal/suite-chat stores) so an
// in-flight run keeps writing here even when the pane isn't mounted. Only an
// explicit stop() or tab close aborts.

import { create } from "zustand";
import { supportsVision, type ModelId } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import type { ContextBlock } from "@/modules/ai/lib/contextBlocks";
import type { Attachment } from "@/components/chat/attachments";
import type { WorkItemRef } from "@/modules/ado";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import {
  listCommits,
  commitDiff,
  workingTreeDiff,
  LOCAL_CHANGES_SHA,
  type CommitMeta,
  type CommitDiff,
} from "./gitCommitApi";
import { gitStatusSummary } from "@/modules/git";
import {
  saveCommitReview,
  getCommitReview,
  type CommitReviewStatus,
} from "./commitReviewApi";
import { runCommitReview, type RunStage } from "./runCommitReview";
import type { Finding } from "./schema";
import type { AppliedPatchRecord, AppliedPatchesMap } from "./patchSchema";

type Status = CommitReviewStatus | "idle";

/** One reviewed commit, as persisted in the row's `commits` JSON blob. */
export type ReviewedCommit = { sha: string; short: string; subject: string };

export type CommitReviewSlice = {
  cwd: string;
  // --- commit picker (multi-select) ---
  commits: CommitMeta[];
  commitsLoading: boolean;
  commitsError: string | null;
  /** Whether the working tree has uncommitted changes — gates the "Local
   *  changes" target (and makes it the default when true). Refreshed alongside
   *  the commit list. */
  hasLocalChanges: boolean;
  /** Full SHAs of the selected commits, kept in `commits` order (newest first). */
  selectedShas: string[];
  /** Per-commit diff cache keyed by full SHA. Read in selection order via
   *  `selectedDiffs()`. Missing keys are commits still loading or failed. */
  diffBySha: Record<string, CommitDiff>;
  diffLoading: boolean;
  diffError: string | null;
  /** Monotonic token bumped on each loadDiffs so a late-resolving earlier load
   *  can't clobber a newer load's loading/error flags. */
  diffLoadSeq: number;
  // --- input (the collapsed "Add context") ---
  context: string;
  attachments: Attachment[];
  workItems: WorkItemRef[];
  // --- run ---
  status: Status;
  stage: RunStage | null;
  activity: ActivityEntry[];
  findings: Finding[];
  appliedPatches: AppliedPatchesMap;
  busy: boolean;
  abort: AbortController | null;
  error: string | null;
  /** Raw model text when stage 1 didn't return parseable findings. */
  schemaViolationRaw: string | null;
  runId: string | null;
  createdAt: string | null;
  durationMs: number | null;
  modelId: ModelId | null;
};

type State = {
  byTab: Map<number, CommitReviewSlice>;
  ensure: (
    tabId: number,
    cwd: string,
    rehydrateRunId?: string | null,
    modelId?: ModelId | null,
  ) => Promise<void>;
  loadCommits: (tabId: number) => Promise<void>;
  /** Add/remove a commit from the selection, then load any missing diffs.
   *  Changing the selection invalidates the current findings. */
  toggleCommit: (tabId: number, sha: string) => Promise<void>;
  /** Add/remove the synthetic "Local changes" target. It can be reviewed alone
   *  or alongside commits; adding it re-reads the live working-tree diff. */
  toggleLocalChanges: (tabId: number) => Promise<void>;
  /** Deselect every commit (the user must pick at least one to review). */
  clearCommits: (tabId: number) => void;
  /** Re-read the source-dir git state after an in-app branch switch / pull /
   *  stash op so an open tab doesn't show the previous branch's commit list,
   *  a stale dirty-state, or a cached "Local changes" diff from another branch.
   *  No-op while a review is running and for tabs pinned to a different cwd. */
  refreshSource: (tabId: number) => Promise<void>;
  /** Fetch the diffs for the currently-selected commits that aren't cached. */
  loadDiffs: (tabId: number) => Promise<void>;
  setContext: (tabId: number, text: string) => void;
  addAttachment: (tabId: number, att: Attachment) => void;
  removeAttachment: (tabId: number, id: string) => void;
  addWorkItem: (tabId: number, item: WorkItemRef) => void;
  removeWorkItem: (tabId: number, id: number) => void;
  setModel: (tabId: number, modelId: ModelId | null) => void;
  run: (tabId: number) => Promise<void>;
  stop: (tabId: number) => void;
  applyFix: (tabId: number, findingId: string, record: AppliedPatchRecord) => void;
  /** Abort any in-flight run and drop the per-tab slice. Called when the tab
   *  closes, via the tabs-store subscription at the bottom of this module. */
  disposeTab: (tabId: number) => void;
};

function newRunId(): string {
  return `crun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The loaded diffs for the selected commits, in selection order. Commits whose
 *  diff is still loading or failed to load are skipped. */
export function selectedDiffs(slice: CommitReviewSlice): CommitDiff[] {
  return slice.selectedShas
    .map((s) => slice.diffBySha[s])
    .filter((d): d is CommitDiff => !!d);
}

/** True once every selected commit has a loaded diff (the gate for running). */
export function allDiffsLoaded(slice: CommitReviewSlice): boolean {
  return (
    slice.selectedShas.length > 0 &&
    slice.selectedShas.every((s) => !!slice.diffBySha[s])
  );
}

/** Re-order a set of selected SHAs to match the commit-list order (newest
 *  first) so diff sections render in a stable, predictable order. */
export function orderShas(shas: string[], commits: CommitMeta[]): string[] {
  // "Local changes" (uncommitted, newest of all) sorts ahead of every commit;
  // commits follow newest-first. Local can be reviewed alone, alongside
  // commits, or not at all — it's just another item in the set.
  const idx = new Map(commits.map((c, i) => [c.sha, i]));
  const rank = (s: string) =>
    s === LOCAL_CHANGES_SHA ? -1 : (idx.get(s) ?? Number.MAX_SAFE_INTEGER);
  return [...new Set(shas)].sort((a, b) => rank(a) - rank(b));
}

function patch(
  set: (fn: (s: State) => Partial<State>) => void,
  tabId: number,
  partial: Partial<CommitReviewSlice>,
) {
  set((s) => {
    const next = new Map(s.byTab);
    const curr = next.get(tabId);
    if (!curr) return s;
    next.set(tabId, { ...curr, ...partial });
    return { byTab: next };
  });
}

function emptySlice(cwd: string, modelId: ModelId | null): CommitReviewSlice {
  return {
    cwd,
    commits: [],
    commitsLoading: false,
    commitsError: null,
    hasLocalChanges: false,
    selectedShas: [],
    diffBySha: {},
    diffLoading: false,
    diffError: null,
    diffLoadSeq: 0,
    context: "",
    attachments: [],
    workItems: [],
    status: "idle",
    stage: null,
    activity: [],
    findings: [],
    appliedPatches: {},
    busy: false,
    abort: null,
    error: null,
    schemaViolationRaw: null,
    runId: null,
    createdAt: null,
    durationMs: null,
    modelId,
  };
}

export const useCommitReview = create<State>((set, get) => ({
  byTab: new Map(),

  ensure: async (tabId, cwd, rehydrateRunId, modelId) => {
    const existing = get().byTab.get(tabId);
    if (existing && existing.cwd === cwd) {
      if (existing.commits.length === 0 && !existing.commitsLoading) {
        await get().loadCommits(tabId);
      }
      return;
    }

    set((s) => {
      const next = new Map(s.byTab);
      next.set(tabId, emptySlice(cwd, modelId ?? null));
      return { byTab: next };
    });

    // Reopening a saved run from History: hydrate its findings + input.
    if (rehydrateRunId) {
      try {
        const row = await getCommitReview(rehydrateRunId);
        if (row) {
          const findings = safeParseFindings(row.findings);
          const appliedPatches = safeParseApplied(row.appliedPatches);
          patch(set, tabId, {
            selectedShas: safeParseCommitShas(row.commits, row.commitSha),
            context: row.context ?? "",
            status: row.status,
            findings,
            appliedPatches,
            runId: row.runId,
            createdAt: row.createdAt,
            durationMs: row.durationMs,
            error:
              row.status === "error"
                ? (row.error ?? "This review ended with an error.")
                : row.status === "interrupted"
                  ? "This review was interrupted before it finished."
                  : null,
          });
        }
      } catch (e) {
        console.warn("[commit-review] rehydrate failed:", e);
      }
    }

    // Non-rehydrate mount: restore the autosaved commit selection + context
    // draft from the persisted tab so an app reload (or a Duplicate, which
    // clones those fields onto the new tab) keeps what the user had picked
    // instead of snapping back to HEAD with an empty context. (The rehydrate
    // branch above already seeds these from the saved SQLite row.)
    if (!rehydrateRunId) {
      const tab = useTabsStore.getState().tabs[tabId];
      if (tab && tab.kind === "commit-review") {
        patch(set, tabId, {
          selectedShas: tab.selectedShas ?? [],
          context: tab.context ?? "",
        });
      }
    }

    await get().loadCommits(tabId);

    // Select the rehydrated commits, or default to the working-tree changes
    // when the tree is dirty (the common "review what I'm about to commit"
    // case), else HEAD. Then load the diffs.
    const slice = get().byTab.get(tabId);
    if (slice) {
      const shas = slice.selectedShas.length
        ? slice.selectedShas
        : slice.hasLocalChanges
          ? [LOCAL_CHANGES_SHA]
          : slice.commits[0]
            ? [slice.commits[0].sha]
            : [];
      patch(set, tabId, { selectedShas: orderShas(shas, slice.commits) });
      await get().loadDiffs(tabId);

      // Reopening a saved run whose commits were since rebased away: those SHAs
      // can't be diffed, so loadDiffs left them out and set a diffError that, on
      // a historical review, reads as "the review is broken". Drop the
      // unreachable commits so a stale selection degrades to what's still
      // reviewable, and clear the now-moot error. (Scoped to rehydrate: a fresh
      // selection can only hold loadable commits, so a load failure there is a
      // real error worth surfacing.)
      if (rehydrateRunId) {
        const after = get().byTab.get(tabId);
        if (after) {
          const reachable = selectedDiffs(after).map((d) => d.sha);
          // "Local changes" isn't a commit that can be rebased away — keep it
          // even if its live diff failed to load this time, so reopening a saved
          // local-changes review doesn't silently snap to an empty selection.
          const nextShas =
            after.selectedShas.includes(LOCAL_CHANGES_SHA) &&
            !reachable.includes(LOCAL_CHANGES_SHA)
              ? [...reachable, LOCAL_CHANGES_SHA]
              : reachable;
          if (nextShas.length !== after.selectedShas.length) {
            patch(set, tabId, { selectedShas: nextShas, diffError: null });
            useTabsStore
              .getState()
              .patchCommitReviewTab(tabId, { selectedShas: nextShas });
          }
        }
      }
    }
  },

  loadCommits: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    patch(set, tabId, { commitsLoading: true, commitsError: null });
    try {
      const commits = await listCommits(slice.cwd, 80);
      // Also probe the working tree so the "Local changes" target can show
      // (and default on) only when there's something uncommitted. Non-fatal —
      // a status failure just leaves the option hidden.
      let hasLocalChanges = false;
      try {
        const st = await gitStatusSummary(slice.cwd);
        hasLocalChanges = st.dirty;
      } catch {
        // ignore — leave hasLocalChanges false
      }
      patch(set, tabId, { commits, commitsLoading: false, hasLocalChanges });
    } catch (e) {
      patch(set, tabId, {
        commitsLoading: false,
        commitsError: errStr(e),
      });
    }
  },

  toggleCommit: async (tabId, sha) => {
    const slice = get().byTab.get(tabId);
    // Don't change the reviewed set mid-run: the in-flight run captured its diff
    // snapshot, so re-selecting now would orphan it and (because runId is reset)
    // silently drop the completed result. The picker is also disabled while busy.
    if (!slice || slice.busy) return;
    const has = slice.selectedShas.includes(sha);
    const nextShas = orderShas(
      has
        ? slice.selectedShas.filter((s) => s !== sha)
        : [...slice.selectedShas, sha],
      slice.commits,
    );
    // Changing the reviewed set invalidates the findings — they were about a
    // different change. Keep the input context (likely still relevant).
    patch(set, tabId, {
      selectedShas: nextShas,
      findings: [],
      activity: [],
      status: "idle",
      error: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
    });
    useTabsStore.getState().patchCommitReviewTab(tabId, { selectedShas: nextShas });
    await get().loadDiffs(tabId);
  },

  toggleLocalChanges: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    const has = slice.selectedShas.includes(LOCAL_CHANGES_SHA);
    // Always drop any cached working-tree diff: removing it cleans up, and
    // re-adding should re-read the LIVE tree (the user may have edited files
    // since the last look). Changing the selection invalidates findings.
    const nextDiffs = { ...slice.diffBySha };
    delete nextDiffs[LOCAL_CHANGES_SHA];
    const nextShas = has
      ? slice.selectedShas.filter((s) => s !== LOCAL_CHANGES_SHA)
      : orderShas([...slice.selectedShas, LOCAL_CHANGES_SHA], slice.commits);
    patch(set, tabId, {
      selectedShas: nextShas,
      diffBySha: nextDiffs,
      findings: [],
      activity: [],
      status: "idle",
      error: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
    });
    useTabsStore
      .getState()
      .patchCommitReviewTab(tabId, { selectedShas: nextShas });
    await get().loadDiffs(tabId);
  },

  clearCommits: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    patch(set, tabId, {
      selectedShas: [],
      diffLoading: false,
      diffError: null,
      findings: [],
      activity: [],
      status: "idle",
      error: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
    });
    useTabsStore.getState().patchCommitReviewTab(tabId, { selectedShas: [] });
  },

  refreshSource: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    // Only the live source directory's git state changes via the in-app
    // switcher; a tab pinned to a different cwd (its repo didn't move) is left
    // alone. usePreferencesStore is the single source of truth for sourceRoot.
    if (slice.cwd !== usePreferencesStore.getState().sourceRoot) return;

    // Re-read the commit list + dirty-state for the (possibly new) branch so
    // the picker offers the right commits and the "Local changes" affordance
    // matches the current tree.
    await get().loadCommits(tabId);

    // A branch switch / pull / stash op rewrote the working tree, so any cached
    // "Local changes" diff is now stale. Drop it (commit diffs are immutable
    // and stay cached); reload it if it's selected so the diff panel — and the
    // next run — reflect the live tree, never the previous branch's snapshot.
    const after = get().byTab.get(tabId);
    if (!after || !after.diffBySha[LOCAL_CHANGES_SHA]) return;
    const nextDiffs = { ...after.diffBySha };
    delete nextDiffs[LOCAL_CHANGES_SHA];
    patch(set, tabId, { diffBySha: nextDiffs });
    if (after.selectedShas.includes(LOCAL_CHANGES_SHA)) {
      await get().loadDiffs(tabId);
    }
  },

  loadDiffs: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    const missing = slice.selectedShas.filter((s) => !slice.diffBySha[s]);
    if (missing.length === 0) {
      patch(set, tabId, { diffLoading: false, diffError: null });
      return;
    }
    // Tag this load so only the most-recent toggle's load owns the
    // loading/error flags: an earlier load resolving late can't flip
    // diffLoading off while a newer one is still pending, nor clobber its error.
    const seq = slice.diffLoadSeq + 1;
    patch(set, tabId, { diffLoading: true, diffError: null, diffLoadSeq: seq });
    const results = await Promise.allSettled(
      missing.map((s) =>
        s === LOCAL_CHANGES_SHA
          ? workingTreeDiff(slice.cwd)
          : commitDiff(slice.cwd, s),
      ),
    );
    const fetched: Record<string, CommitDiff> = {};
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched[missing[i]] = r.value;
      else errors.push(errStr(r.reason));
    });
    set((s) => {
      const next = new Map(s.byTab);
      const curr = next.get(tabId);
      if (!curr) return s;
      // Commit diffs are immutable, so caching them even after the selection
      // moved on is intentional (re-selecting is instant). The working-tree diff
      // is NOT — drop a late-arriving local diff if "local" was deselected
      // meanwhile, so a stale snapshot can never be reviewed. The loading/error
      // flags are only written by the latest-issued load.
      const fresh = { ...fetched };
      if (
        fresh[LOCAL_CHANGES_SHA] &&
        !curr.selectedShas.includes(LOCAL_CHANGES_SHA)
      ) {
        delete fresh[LOCAL_CHANGES_SHA];
      }
      const merged = { ...curr, diffBySha: { ...curr.diffBySha, ...fresh } };
      if (curr.diffLoadSeq === seq) {
        merged.diffLoading = false;
        merged.diffError =
          errors.length === 0
            ? null
            : errors.length === 1
              ? errors[0]
              : `${errors.length} commits couldn't be loaded (rebased or amended?).`;
      }
      next.set(tabId, merged);
      return { byTab: next };
    });
  },

  setContext: (tabId, text) => {
    patch(set, tabId, { context: text });
    useTabsStore.getState().patchCommitReviewTab(tabId, { context: text });
  },

  addAttachment: (tabId, att) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    if (slice.attachments.some((a) => a.id === att.id)) return;
    patch(set, tabId, { attachments: [...slice.attachments, att] });
  },

  removeAttachment: (tabId, id) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    patch(set, tabId, {
      attachments: slice.attachments.filter((a) => a.id !== id),
    });
  },

  addWorkItem: (tabId, item) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    if (slice.workItems.some((w) => w.id === item.id)) return;
    patch(set, tabId, { workItems: [...slice.workItems, item] });
  },

  removeWorkItem: (tabId, id) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    patch(set, tabId, { workItems: slice.workItems.filter((w) => w.id !== id) });
  },

  setModel: (tabId, modelId) => {
    patch(set, tabId, { modelId });
    useTabsStore.getState().patchCommitReviewTab(tabId, { modelId });
  },

  run: async (tabId) => {
    let slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;

    // "Local changes" is a live target, not an immutable commit: the working
    // tree may have moved since its diff was last read (edits in an external
    // editor, an in-app branch switch). Re-read it fresh right before the run
    // so the model always reviews the CURRENT tree — this is the guarantee that
    // we never hand it a stale snapshot. (Commit diffs are immutable and stay
    // cached.) On a transient read failure, fall back to the cached diff rather
    // than refusing the run.
    if (slice.selectedShas.includes(LOCAL_CHANGES_SHA)) {
      try {
        const fresh = await workingTreeDiff(slice.cwd);
        const now = get().byTab.get(tabId);
        // Drop the result if the tab vanished, a run already started, or the
        // user deselected local while we were reading (mirrors loadDiffs).
        if (now && !now.busy && now.selectedShas.includes(LOCAL_CHANGES_SHA)) {
          patch(set, tabId, {
            diffBySha: { ...now.diffBySha, [LOCAL_CHANGES_SHA]: fresh },
          });
        }
      } catch {
        // Keep the cached local diff — reviewing the last-known tree beats
        // refusing the run on a transient read error.
      }
      slice = get().byTab.get(tabId);
      if (!slice || slice.busy) return;
    }

    const diffs = selectedDiffs(slice);
    if (diffs.length === 0 || diffs.length !== slice.selectedShas.length) {
      patch(set, tabId, {
        error: "Pick at least one commit and wait for its diff to load.",
      });
      return;
    }

    const abort = new AbortController();
    const runId = newRunId();
    const createdAt = new Date().toISOString();
    const prefs = usePreferencesStore.getState();
    const chat = useChatStore.getState();
    const effectiveModelId = slice.modelId ?? prefs.defaultModelId;

    // Claim the run atomically: a second run() firing in the same tick (a fast
    // double-click before the button re-renders to Stop) must not overwrite the
    // first run's AbortController/runId. Only the invocation that flips busy
    // wins; the loser bails so stop() can still cancel the one live run.
    let started = false;
    set((s) => {
      const next = new Map(s.byTab);
      const curr = next.get(tabId);
      if (!curr || curr.busy) return s;
      started = true;
      next.set(tabId, {
        ...curr,
        busy: true,
        status: "running",
        stage: "investigate",
        activity: [],
        findings: [],
        error: null,
        schemaViolationRaw: null,
        abort,
        runId,
        createdAt,
        durationMs: null,
      });
      return { byTab: next };
    });
    if (!started) return;

    // Persist the running row BEFORE the model call so a crash/refresh leaves a
    // durable record (the startup sweep flips it to "interrupted").
    await persistRow(tabId, { status: "running" }).catch(() => {});

    const mergeToolEvent = (e: ActivityEntry) => {
      set((s) => {
        const next = new Map(s.byTab);
        const curr = next.get(tabId);
        if (!curr) return s;
        const prior = curr.activity;
        const idx = prior.findIndex((x) => x.id === e.id);
        const activity =
          idx >= 0 ? prior.map((x, i) => (i === idx ? { ...x, ...e } : x)) : [...prior, e];
        next.set(tabId, { ...curr, activity });
        return { byTab: next };
      });
    };

    try {
      const visionCapable = supportsVision(effectiveModelId);
      const { blocks: bpBlocks, warnings } = await loadBestPracticeBlocks(
        prefs.bestPracticeFiles,
        { visionCapable },
      );
      if (warnings.length > 0) {
        console.warn("[commit-review] best-practices skipped:", warnings);
      }
      const contextBlocks: ContextBlock[] = [];
      if (slice.context.trim()) {
        contextBlocks.push({
          heading:
            "DEVELOPER-PROVIDED CONTEXT — what this change is meant to do (ticket / requirements / notes)",
          body: slice.context.trim(),
        });
      }
      if (slice.workItems.length > 0) {
        contextBlocks.push(
          ...(await bugsToContextBlocks(slice.workItems.map((w) => w.id))),
        );
      }
      contextBlocks.push(...bpBlocks);

      const result = await runCommitReview({
        modelId: effectiveModelId,
        keys: chat.apiKeys,
        local: localProviderConfig(prefs),
        sourceRoot: prefs.codeSearchEnabled ? slice.cwd : null,
        diffs,
        contextBlocks,
        attachments: slice.attachments,
        customInstructions: prefs.customInstructions || undefined,
        onToolEvent: mergeToolEvent,
        onStage: (stage) => patch(set, tabId, { stage }),
        signal: abort.signal,
      });

      if (!result.ok) {
        patch(set, tabId, {
          busy: false,
          abort: null,
          stage: null,
          status: "error",
          durationMs: result.durationMs,
          error:
            "The model didn't return findings in the expected format. Re-run, or try a more capable model.",
          schemaViolationRaw: result.rawText,
        });
        await persistRow(tabId, {
          status: "error",
          error: "schema_violation",
        }).catch(() => {});
        return;
      }

      patch(set, tabId, {
        busy: false,
        abort: null,
        stage: null,
        status: "done",
        findings: result.findings,
        durationMs: result.durationMs,
      });
      await persistRow(tabId, { status: "done" }).catch(() => {});
      window.dispatchEvent(new CustomEvent("devops-studio:commit-review-updated"));
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === "AbortError";
      if (aborted) {
        patch(set, tabId, {
          busy: false,
          abort: null,
          stage: null,
          status: "cancelled",
        });
        await persistRow(tabId, { status: "cancelled" }).catch(() => {});
        window.dispatchEvent(
          new CustomEvent("devops-studio:commit-review-updated"),
        );
        return;
      }
      console.error("[commit-review] run failed:", e);
      patch(set, tabId, {
        busy: false,
        abort: null,
        stage: null,
        status: "error",
        error: errStr(e),
      });
      await persistRow(tabId, { status: "error", error: errStr(e) }).catch(
        () => {},
      );
      window.dispatchEvent(new CustomEvent("devops-studio:commit-review-updated"));
    }
  },

  stop: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (slice?.abort) slice.abort.abort();
  },

  applyFix: (tabId, findingId, record) => {
    set((s) => {
      const next = new Map(s.byTab);
      const curr = next.get(tabId);
      if (!curr) return s;
      next.set(tabId, {
        ...curr,
        appliedPatches: { ...curr.appliedPatches, [findingId]: record },
      });
      return { byTab: next };
    });
    void persistRow(tabId, {}).catch(() => {});
  },

  disposeTab: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    // Abort any in-flight run so a closed tab stops streaming the model, then
    // free the slice (cached diffs, attachments, findings) so it doesn't leak
    // for the app's lifetime. Any pending writes from the aborted run no-op via
    // the `if (!curr) return s` guards once the slice is gone, and persistRow
    // early-returns because the slice (and its runId) are missing.
    slice.abort?.abort();
    set((s) => {
      const next = new Map(s.byTab);
      next.delete(tabId);
      return { byTab: next };
    });
  },
}));

// Reactively GC each per-tab slice when its tab closes — closeTab and the
// closeOthers/-ToRight/-All paths all funnel through it, plus reload-drops — so
// a closed Commit Review tab can't leave an orphaned in-flight run streaming or
// leak its cached diffs. Mirrors the generator's reactive store cleanup. The
// cheap `tabs` identity check skips the frequent focus/drag updates that don't
// touch the tab set.
useTabsStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  const { byTab, disposeTab } = useCommitReview.getState();
  if (byTab.size === 0) return;
  for (const id of byTab.keys()) {
    if (!state.tabs[id]) disposeTab(id);
  }
});

/** Build the full SQLite row from the tab's current state + a status override
 *  and upsert it. Called at every transition + each applied fix. */
async function persistRow(
  tabId: number,
  override: { status?: CommitReviewStatus; error?: string },
): Promise<void> {
  const slice = useCommitReview.getState().byTab.get(tabId);
  if (!slice || !slice.runId) return;
  const diffs = selectedDiffs(slice);
  if (diffs.length === 0) return;
  const primary = diffs[0];
  const prefs = usePreferencesStore.getState();
  const status = override.status ?? statusForPersist(slice.status);
  await saveCommitReview({
    runId: slice.runId,
    cwd: slice.cwd,
    commitSha: primary.sha,
    commitShort: primary.shortSha,
    commitSubject: primary.subject,
    commits: JSON.stringify(
      diffs.map((d) => ({ sha: d.sha, short: d.shortSha, subject: d.subject })),
    ),
    status,
    modelId: slice.modelId ?? prefs.defaultModelId,
    context: slice.context.trim() || null,
    findings: JSON.stringify(slice.findings),
    appliedPatches: JSON.stringify(slice.appliedPatches),
    error: override.error ?? null,
    findingCount: slice.findings.length,
    durationMs: slice.durationMs,
    createdAt: slice.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function statusForPersist(s: Status): CommitReviewStatus {
  return s === "idle" ? "running" : s;
}

function safeParseFindings(json: string): Finding[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch {
    return [];
  }
}

function safeParseApplied(json: string): AppliedPatchesMap {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as AppliedPatchesMap) : {};
  } catch {
    return {};
  }
}

/** Restore the reviewed-commit SHAs from a saved row's `commits` blob, falling
 *  back to the single primary SHA for legacy rows (or an empty selection). */
function safeParseCommitShas(json: string | null, fallbackSha: string): string[] {
  if (json) {
    try {
      const v = JSON.parse(json);
      if (Array.isArray(v)) {
        const shas = v
          .map((c) =>
            c && typeof c === "object" ? (c as ReviewedCommit).sha : null,
          )
          .filter((s): s is string => typeof s === "string" && s.length > 0);
        if (shas.length > 0) return shas;
      }
    } catch {
      // fall through to the single-commit fallback
    }
  }
  return fallbackSha ? [fallbackSha] : [];
}

function errStr(e: unknown): string {
  return typeof e === "string" ? e : (e as Error)?.message ?? String(e);
}
