// Per-tab store for the Commit Review surface. Module-level (survives a React
// unmount from a pane split/merge, like the terminal/suite-chat stores) so an
// in-flight run keeps writing here even when the pane isn't mounted. Only an
// explicit stop() or tab close aborts.

import { create } from "zustand";
import {
  isKnownModelId,
  RESUME_TOPUP_STEPS,
  supportsVision,
  type ModelId,
} from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import {
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  sanitizeTranscriptMessages,
  type CheckpointOutcome,
  type CheckpointWriter,
  type CommitReviewCheckpointV1,
  type TranscriptCheckpoint,
} from "@/modules/ai/lib/checkpointApi";
import { canOfferResume, classifyForResume } from "@/modules/ai/lib/errorClass";
import { sumUsage } from "@/modules/generator/lib/resumePolicy";
import type { TaskCheckpoint } from "@/modules/ai/lib/taskRunner";
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
import {
  runCommitReview,
  type RunCommitReviewResult,
  type RunStage,
} from "./runCommitReview";
import type { CandidateFinding, Finding } from "./schema";
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
  /** Structural failure reason when the run RESOLVED unusable (vs threw) —
   *  what the error card classifies on, so copy never string-matches. */
  errorReason: "step_cap" | "empty" | "schema_violation" | null;
  /** Raw model text when stage 1 didn't return parseable findings. */
  schemaViolationRaw: string | null;
  runId: string | null;
  createdAt: string | null;
  durationMs: number | null;
  modelId: ModelId | null;
  /** Set when a failed / cancelled run left a checkpoint worth continuing.
   *  Null when there's nothing to resume (never ran, ran to completion, or the
   *  model answered — badly — so a resume would just re-fail). */
  resumable: {
    stage: RunStage;
    stepsUsed: number;
    totalTokens: number | null;
    updatedAt: string;
    outcome: CheckpointOutcome | null;
  } | null;
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
  /** Continue the last run from its persisted checkpoint: same runId, the diffs
   *  it was snapshotted with, and — when stage 1 already parsed — no second
   *  investigate pass. */
  resume: (tabId: number) => Promise<void>;
  /** Throw away the resume point (and its persisted row) for this tab's run. */
  discardCheckpoint: (tabId: number) => void;
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

type SetState = (fn: (s: State) => Partial<State>) => void;

function patch(
  set: SetState,
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

/** Activity log that keeps a local mirror alongside the slice's copy: a run
 *  whose tab was closed mid-flight (disposeTab drops the slice) still has to
 *  write its log into the terminal checkpoint. */
function activitySink(set: SetState, tabId: number, seed: ActivityEntry[]) {
  let activity = seed;
  return {
    get current(): ActivityEntry[] {
      return activity;
    },
    /** Append, or replace an earlier entry with the same id (a tool_use later
     *  completed by its tool_result, carrying duration + output). */
    onEvent(e: ActivityEntry): void {
      const i = activity.findIndex((x) => x.id === e.id);
      activity =
        i >= 0
          ? activity.map((x, n) => (n === i ? { ...x, ...e } : x))
          : [...activity, e];
      patch(set, tabId, { activity });
    },
  };
}

/** Fold one runner checkpoint into a persistable transcript, carrying the
 *  totals earlier attempts already accrued. Null when the messages can't
 *  survive a JSON round-trip — the caller then persists inputs-only rather
 *  than a transcript that would fail to parse on the way back in. */
function toTranscript(
  cp: TaskCheckpoint,
  base: TranscriptCheckpoint | null,
): TranscriptCheckpoint | null {
  const messages = sanitizeTranscriptMessages(cp.messages);
  if (!messages) return null;
  return {
    messages,
    stepsUsed: (base?.stepsUsed ?? 0) + cp.stepsUsed,
    usage: sumUsage(base?.usage, cp.usage),
  };
}

/** The resume affordance derived from the payload we just flushed, so what the
 *  UI offers and what's actually on disk can't drift. */
function resumableFrom(
  payload: CommitReviewCheckpointV1,
  outcome: CheckpointOutcome,
): NonNullable<CommitReviewSlice["resumable"]> {
  return {
    stage: payload.stage,
    stepsUsed: payload.transcript?.stepsUsed ?? 0,
    totalTokens: payload.transcript?.usage?.totalTokens ?? null,
    updatedAt: outcome.at,
    outcome,
  };
}

/** A step finishing after the run already settled — or after its tab closed —
 *  must not queue a live payload on top of the terminal outcome just written. */
function isLiveRun(get: () => State, tabId: number, runId: string): boolean {
  const s = get().byTab.get(tabId);
  return !!s && s.busy && s.runId === runId;
}

/** The checkpoint handles a live run carries around, so run() and resume() can
 *  share one set of terminal paths. */
type CheckpointCtx = {
  writer: CheckpointWriter;
  buildPayload: (outcome: CheckpointOutcome | null) => CommitReviewCheckpointV1;
};

/** Terminal handling for a run that RESOLVED — shared by run() and resume(). */
async function settleResult(
  set: SetState,
  tabId: number,
  cp: CheckpointCtx,
  result: RunCommitReviewResult,
): Promise<void> {
  if (!result.ok) {
    const at = new Date().toISOString();
    // A loop that burned its whole budget still calling tools never reached the
    // point of writing its findings — continuable, unlike a model that answered
    // with something unusable (resuming that transcript just re-fails).
    const stepCapped = result.reason === "step_cap";
    const outcome: CheckpointOutcome = { at, kind: result.reason };
    const payload = cp.buildPayload(outcome);
    patch(set, tabId, {
      busy: false,
      abort: null,
      stage: null,
      status: "error",
      durationMs: result.durationMs,
      error: stepCapped
        ? `The review hit its step budget before it could write its findings. Resume grants ${RESUME_TOPUP_STEPS} more steps and asks the model to finish with what it has already read.`
        : "The model didn't return findings in the expected format. Re-run, or try a more capable model.",
      errorReason: result.reason,
      schemaViolationRaw: stepCapped ? null : result.rawText,
      resumable: stepCapped ? resumableFrom(payload, outcome) : null,
    });
    await cp.writer.flush(payload);
    await persistRow(tabId, {
      status: "error",
      error: result.reason,
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
    resumable: null,
  });
  await persistRow(tabId, { status: "done" }).catch(() => {});
  // Only after the row landed: a crash between the two must leave the
  // checkpoint standing, never a window where neither copy exists.
  await cp.writer.delete();
  window.dispatchEvent(new CustomEvent("devops-studio:commit-review-updated"));
}

/** Terminal handling for a run that THREW — a user abort or a real failure.
 *  Both keep their checkpoint and offer a resume. `cp` is null only for a
 *  failure before the run reached the provider (nothing was spent). */
async function settleFailure(
  set: SetState,
  tabId: number,
  cp: CheckpointCtx | null,
  e: unknown,
): Promise<void> {
  const aborted = (e as { name?: string } | null)?.name === "AbortError";
  if (!aborted) console.error("[commit-review] run failed:", e);
  const at = new Date().toISOString();
  const outcome: CheckpointOutcome = aborted
    ? { at, kind: "cancelled" }
    : {
        at,
        kind: "error",
        errorKind: classifyForResume(e).kind,
        message: errStr(e),
      };
  // Built BEFORE the flush and from the run's own scope, so a tab closed
  // mid-run (disposeTab aborts, then drops the slice) still checkpoints.
  const payload = cp?.buildPayload(outcome) ?? null;
  patch(set, tabId, {
    busy: false,
    abort: null,
    stage: null,
    status: aborted ? "cancelled" : "error",
    error: aborted ? null : errStr(e),
    // A thrown failure is a provider/runtime error, never a parse outcome.
    errorReason: null,
    resumable: payload ? resumableFrom(payload, outcome) : null,
  });
  if (cp && payload) await cp.writer.flush(payload);
  await persistRow(
    tabId,
    aborted ? { status: "cancelled" } : { status: "error", error: errStr(e) },
  ).catch(() => {});
  window.dispatchEvent(new CustomEvent("devops-studio:commit-review-updated"));
}

/** On a FRESH mount (no rehydrateRunId — a brand-new tab, or the persisted
 *  tab coming back after an app restart), find the newest resumable checkpoint
 *  for this cwd and adopt it: the reopened tab then IS the interrupted review
 *  — inputs restored, resume front and center — instead of a fresh review
 *  that hides the interrupted one behind History. That was the way users
 *  actually hit this: quit mid-run, reopen, get a fresh tab with the same
 *  settings and no hint their spend was recoverable. */
async function adoptInterruptedRun(
  set: SetState,
  get: () => State,
  tabId: number,
  cwd: string,
): Promise<void> {
  let entries: Awaited<ReturnType<typeof listCheckpoints>>;
  try {
    entries = await listCheckpoints("commit-review", cwd);
  } catch {
    return;
  }
  // Another live tab's run — busy, or already adopted — is not ours to take.
  const claimed = new Set<string>();
  for (const [id, s] of get().byTab) {
    if (id !== tabId && s.runId) claimed.add(s.runId);
  }

  // Newest first (the Rust list orders by updated_at DESC). Bounded probe: an
  // orphaned-but-unresumable row shouldn't make mount cost N round-trips.
  for (const entry of entries.slice(0, 5)) {
    if (claimed.has(entry.runId)) continue;
    let cp: Awaited<ReturnType<typeof getCheckpoint>> = null;
    try {
      cp = await getCheckpoint(entry.runId);
    } catch {
      continue;
    }
    if (!cp || cp.payload.surface !== "commit-review") continue;
    const p = cp.payload;
    // Same gate as every Resume affordance: a run that answered badly
    // (schema_violation / empty) or died non-resumably would just re-fail.
    if (!canOfferResume(p.lastOutcome, p.lastOutcome?.message ?? null)) continue;
    // A finished review's checkpoint is an orphan (delete-on-success swallows
    // IPC failures), not a resume point — the persisted row is the truth.
    let row: Awaited<ReturnType<typeof getCommitReview>> = null;
    try {
      row = await getCommitReview(entry.runId);
    } catch {
      // No row usually means the crash beat the first persist — still adoptable.
    }
    if (row?.status === "done") continue;

    // Re-validate the claim in the same synchronous step as the patch: a
    // second fresh tab for this cwd (Duplicate persists across restarts, and
    // a leaf mounts all its tabs at once) races this same probe, and both
    // saw the pre-await claimed set. Whoever patches first wins; the loser
    // sees the runId here and moves on to the next entry.
    const nowClaimed = new Set<string>();
    for (const [id, s] of get().byTab) {
      if (id !== tabId && s.runId) nowClaimed.add(s.runId);
    }
    if (nowClaimed.has(entry.runId)) continue;

    const snapshotDiffs: Record<string, CommitDiff> = {};
    for (const d of p.inputs.diffs) snapshotDiffs[d.sha] = d;
    const status: Status =
      row?.status === "cancelled" || p.lastOutcome?.kind === "cancelled"
        ? "cancelled"
        : row?.status === "error" || p.lastOutcome?.kind === "error"
          ? "error"
          : "interrupted";
    // Same token lift the rehydrate branch does: settleResult persists the
    // raw reason ("step_cap" / …) into the row's error column, and the
    // outcome kind carries it for unflushed rows — without this an adopted
    // step-capped run classifies as "Something went wrong".
    const kind = p.lastOutcome?.kind;
    const reason =
      kind === "step_cap" || kind === "empty" || kind === "schema_violation"
        ? kind
        : row?.error === "step_cap" ||
            row?.error === "empty" ||
            row?.error === "schema_violation"
          ? row.error
          : null;
    patch(set, tabId, {
      runId: p.runId,
      createdAt: p.createdAt,
      status,
      errorReason: status === "error" ? reason : null,
      error:
        status === "error"
          ? (p.lastOutcome?.message ??
            row?.error ??
            "This review ended with an error.")
          : null,
      activity: p.activity,
      context: p.inputs.context,
      attachments: p.inputs.attachments,
      workItems: p.inputs.workItems,
      selectedShas: p.inputs.selectedShas,
      // The snapshot the run was reviewing. Safe to seed: commit diffs are
      // immutable, and a fresh run() re-reads the live working tree anyway —
      // only resume() deliberately replays this snapshot.
      diffBySha: snapshotDiffs,
      resumable: {
        stage: p.stage,
        stepsUsed: p.transcript?.stepsUsed ?? 0,
        totalTokens: p.transcript?.usage?.totalTokens ?? null,
        updatedAt: cp.updatedAt,
        outcome: p.lastOutcome,
      },
    });
    return;
  }
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
    errorReason: null,
    schemaViolationRaw: null,
    runId: null,
    createdAt: null,
    durationMs: null,
    modelId,
    resumable: null,
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
      // The tab's persisted modelId can name a model retired since it was
      // saved — feeding that into the picker/runner would throw at getModel.
      // Degrade to "use the global default" instead.
      next.set(
        tabId,
        emptySlice(cwd, modelId && isKnownModelId(modelId) ? modelId : null),
      );
      return { byTab: next };
    });

    // Reopening a saved run from History: hydrate its findings + input.
    if (rehydrateRunId) {
      try {
        const row = await getCommitReview(rehydrateRunId);
        if (row) {
          const findings = safeParseFindings(row.findings);
          const appliedPatches = safeParseApplied(row.appliedPatches);
          // persistRow writes the raw reason token ("step_cap" / "empty" /
          // "schema_violation") into the error column on parse failures —
          // lift it back into the structural field the error card reads.
          const rowReason =
            row.error === "step_cap" ||
            row.error === "empty" ||
            row.error === "schema_violation"
              ? row.error
              : null;
          patch(set, tabId, {
            selectedShas: safeParseCommitShas(row.commits, row.commitSha),
            context: row.context ?? "",
            status: row.status,
            findings,
            appliedPatches,
            runId: row.runId,
            createdAt: row.createdAt,
            durationMs: row.durationMs,
            errorReason: row.status === "error" ? rowReason : null,
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

      // The row is a thin record of the RESULT; a run that died mid-flight also
      // left a checkpoint holding the inputs it was working from, the activity
      // log, and where to pick up. Restore what the row can't carry, and offer
      // the resume. (A completed run deleted its checkpoint — nothing here.)
      try {
        const cp = await getCheckpoint(rehydrateRunId);
        if (cp && cp.payload.surface === "commit-review") {
          const p = cp.payload;
          const curr = get().byTab.get(tabId);
          const spent = p.lastOutcome?.kind;
          // A FINISHED review's checkpoint is an orphan, not a resume point:
          // writer.delete() swallows IPC failures by design, so a run that
          // wrote status "done" can still leave a payload behind with
          // lastOutcome null — which reads exactly like the crash-mid-run case
          // this probe exists for. Gate on the hydrated ROW status, not the
          // outcome, or reopening a finished review would offer a Resume that
          // re-runs verify over its own findings.
          const done = curr?.status === "done";
          patch(set, tabId, {
            activity: curr?.activity.length ? curr.activity : p.activity,
            context: curr?.context ? curr.context : p.inputs.context,
            attachments: curr?.attachments.length
              ? curr.attachments
              : p.inputs.attachments,
            workItems: curr?.workItems.length
              ? curr.workItems
              : p.inputs.workItems,
            // A run that ANSWERED — badly — isn't worth resuming: continuing a
            // transcript that ends in garbage just re-fails. Re-run is the
            // right affordance there.
            resumable:
              done || spent === "schema_violation" || spent === "empty"
                ? null
                : {
                    stage: p.stage,
                    stepsUsed: p.transcript?.stepsUsed ?? 0,
                    totalTokens: p.transcript?.usage?.totalTokens ?? null,
                    updatedAt: cp.updatedAt,
                    outcome: p.lastOutcome,
                  },
          });
        }
      } catch (e) {
        console.warn("[commit-review] checkpoint probe failed:", e);
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
      // A fresh mount is where an interrupted run resurfaces after an app
      // restart — adopt it (inputs + resume affordance) instead of leaving
      // it discoverable only through History.
      await adoptInterruptedRun(set, get, tabId, cwd);
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
      errorReason: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
      // Walking away from the reviewed set also walks away from any adopted
      // resume point — the affordance is gated on status anyway, but a stale
      // resumable must not linger behind a null runId.
      resumable: null,
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
      errorReason: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
      // Walking away from the reviewed set also walks away from any adopted
      // resume point — the affordance is gated on status anyway, but a stale
      // resumable must not linger behind a null runId.
      resumable: null,
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
      errorReason: null,
      schemaViolationRaw: null,
      runId: null,
      durationMs: null,
      // Walking away from the reviewed set also walks away from any adopted
      // resume point — the affordance is gated on status anyway, but a stale
      // resumable must not linger behind a null runId.
      resumable: null,
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
    // Read before the claim overwrites it: whatever this run supersedes.
    const prevRunId = slice.runId;

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
        errorReason: null,
        schemaViolationRaw: null,
        abort,
        runId,
        createdAt,
        durationMs: null,
        resumable: null,
      });
      return { byTab: next };
    });
    if (!started) return;

    // The superseded run's resume point can never be reached again — nothing
    // points at that runId once this one takes over, so don't orphan its row.
    if (prevRunId && prevRunId !== runId) {
      void deleteCheckpoint(prevRunId).catch(() => {});
    }

    // Persist the running row BEFORE the model call so a crash/refresh leaves a
    // durable record (the startup sweep flips it to "interrupted").
    await persistRow(tabId, { status: "running" }).catch(() => {});

    const sink = activitySink(set, tabId, []);
    // Out here so the catch can flush a terminal outcome: a failure BEFORE the
    // provider was touched (best-practices, work items, keys) spent nothing, so
    // it leaves no checkpoint and offers no resume.
    let writer: CheckpointWriter | null = null;
    let buildPayload: CheckpointCtx["buildPayload"] | null = null;

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

      // Everything above is recoverable input; from here on the run costs
      // money, so the resume point goes to disk BEFORE the provider is touched.
      const w = createCheckpointWriter({
        runId,
        surface: "commit-review",
        cwd: slice.cwd,
        createdAt,
      });
      writer = w;
      const basePayload: CommitReviewCheckpointV1 = {
        v: 1,
        surface: "commit-review",
        runId,
        createdAt,
        modelId: effectiveModelId,
        cwd: slice.cwd,
        sourceRoot: prefs.codeSearchEnabled ? slice.cwd : null,
        customInstructions: prefs.customInstructions || undefined,
        inputs: {
          selectedShas: slice.selectedShas,
          // The diffs captured above — including the freshly re-read working
          // tree. A resume replays THESE, never the tree as it is by then.
          diffs,
          context: slice.context,
          attachments: slice.attachments,
          workItems: slice.workItems,
          contextBlocks,
        },
        stage: "investigate",
        stage1Candidates: null,
        activity: [],
        transcript: null,
        lastOutcome: null,
      };
      let cpStage: RunStage = "investigate";
      let cpCandidates: CandidateFinding[] | null = null;
      let transcript: TranscriptCheckpoint | null = null;
      const build = (
        outcome: CheckpointOutcome | null,
      ): CommitReviewCheckpointV1 => ({
        ...basePayload,
        stage: cpStage,
        stage1Candidates: cpCandidates,
        activity: sink.current,
        transcript,
        lastOutcome: outcome,
      });
      buildPayload = build;
      await w.flush(basePayload);

      const result = await runCommitReview({
        modelId: effectiveModelId,
        keys: await chat.ensureApiKeys(),
        local: localProviderConfig(prefs),
        sourceRoot: basePayload.sourceRoot,
        diffs,
        contextBlocks,
        attachments: slice.attachments,
        customInstructions: prefs.customInstructions || undefined,
        onToolEvent: sink.onEvent,
        onStage: (stage) => patch(set, tabId, { stage }),
        onCheckpoint: (stage, checkpoint) => {
          cpStage = stage;
          transcript = toTranscript(checkpoint, null);
          if (!isLiveRun(get, tabId, runId)) return;
          w.save(build(null));
        },
        onStage1Candidates: (cands) => {
          cpStage = "verify";
          cpCandidates = cands;
          // Verify starts from its own prompt, so the investigate transcript
          // must not be handed to it on resume.
          transcript = null;
          // Flush, not save: this is the moment the investigate spend becomes
          // durable, and the throttle could otherwise lose it to a crash.
          void w.flush(build(null));
        },
        signal: abort.signal,
      });

      await settleResult(set, tabId, { writer: w, buildPayload: build }, result);
    } catch (e) {
      await settleFailure(
        set,
        tabId,
        writer && buildPayload ? { writer, buildPayload } : null,
        e,
      );
    }
  },

  resume: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy || !slice.runId || !slice.resumable) return;
    const runId = slice.runId;

    let row: Awaited<ReturnType<typeof getCheckpoint>> = null;
    try {
      row = await getCheckpoint(runId);
    } catch (e) {
      console.warn("[commit-review] couldn't read the checkpoint:", e);
    }
    if (!row || row.payload.surface !== "commit-review") {
      patch(set, tabId, { resumable: null });
      return;
    }
    const payload = row.payload;
    // The transcript is pinned to the model that produced it, so a retired id
    // can't be resumed. Keep the checkpoint (its inputs are still good) but
    // drop the affordance — clicking Resume could only ever fail.
    if (!isKnownModelId(payload.modelId)) {
      patch(set, tabId, {
        error: "This run's model is no longer available — re-run from scratch.",
        resumable: null,
      });
      return;
    }

    // Snapshotted diffs, keyed for the slice. Seeding these (and the selection)
    // as part of the claim is what keeps a resume off the live working tree AND
    // satisfies persistRow's no-diffs early return before the row goes running.
    const snapshotDiffs: Record<string, CommitDiff> = {};
    for (const d of payload.inputs.diffs) snapshotDiffs[d.sha] = d;

    const abort = new AbortController();
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
        stage: payload.stage,
        // Seed, don't wipe — the log reads as one continuous run.
        activity: payload.activity,
        // Only an investigate resume re-derives findings; a verify resume never
        // had any on screen to clear.
        findings: payload.stage === "investigate" ? [] : curr.findings,
        error: null,
        errorReason: null,
        schemaViolationRaw: null,
        abort,
        runId,
        createdAt: curr.createdAt ?? payload.createdAt,
        durationMs: null,
        resumable: null,
        selectedShas: payload.inputs.selectedShas,
        diffBySha: { ...curr.diffBySha, ...snapshotDiffs },
        context: curr.context || payload.inputs.context,
        attachments: curr.attachments.length
          ? curr.attachments
          : payload.inputs.attachments,
        workItems: curr.workItems.length
          ? curr.workItems
          : payload.inputs.workItems,
      });
      return { byTab: next };
    });
    if (!started) return;

    // Same runId, same row — a resume continues the run rather than orphaning
    // the failed one behind a fresh id.
    await persistRow(tabId, { status: "running" }).catch(() => {});

    const sink = activitySink(set, tabId, payload.activity);
    const w = createCheckpointWriter({
      runId,
      surface: "commit-review",
      cwd: payload.cwd,
      createdAt: payload.createdAt,
    });
    let cpStage: RunStage = payload.stage;
    let cpCandidates: CandidateFinding[] | null = payload.stage1Candidates;
    // The resumed stage's prior totals — cp.messages already carries the
    // transcript prefix, so only the COUNTERS need the earlier run added in.
    let transcriptBase: TranscriptCheckpoint | null = payload.transcript;
    let transcript: TranscriptCheckpoint | null = payload.transcript;
    const build = (
      outcome: CheckpointOutcome | null,
    ): CommitReviewCheckpointV1 => ({
      ...payload,
      stage: cpStage,
      stage1Candidates: cpCandidates,
      activity: sink.current,
      transcript,
      lastOutcome: outcome,
    });

    try {
      const prefs = usePreferencesStore.getState();
      const keys = await useChatStore.getState().ensureApiKeys();
      const result = await runCommitReview({
        modelId: payload.modelId,
        keys,
        local: localProviderConfig(prefs),
        // Every input is frozen at what the run started with — re-reading the
        // working tree here would review code the transcript never saw.
        sourceRoot: payload.sourceRoot,
        diffs: payload.inputs.diffs,
        contextBlocks: payload.inputs.contextBlocks,
        attachments: payload.inputs.attachments,
        customInstructions: payload.customInstructions,
        onToolEvent: sink.onEvent,
        onStage: (stage) => patch(set, tabId, { stage }),
        onCheckpoint: (stage, checkpoint) => {
          cpStage = stage;
          transcript = toTranscript(checkpoint, transcriptBase);
          if (!isLiveRun(get, tabId, runId)) return;
          w.save(build(null));
        },
        onStage1Candidates: (cands) => {
          cpStage = "verify";
          cpCandidates = cands;
          // Crossing into verify starts a new transcript, so the investigate
          // one (and its totals) stop applying.
          transcript = null;
          transcriptBase = null;
          void w.flush(build(null));
        },
        resume: {
          stage: payload.stage,
          stage1Candidates: payload.stage1Candidates,
          resumeMessages: payload.transcript?.messages ?? null,
          stepCapNudge: payload.lastOutcome?.kind === "step_cap",
        },
        signal: abort.signal,
      });

      await settleResult(set, tabId, { writer: w, buildPayload: build }, result);
    } catch (e) {
      await settleFailure(set, tabId, { writer: w, buildPayload: build }, e);
    }
  },

  discardCheckpoint: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy || !slice.runId || !slice.resumable) return;
    void deleteCheckpoint(slice.runId).catch(() => {});
    patch(set, tabId, { resumable: null });
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
    // Flip the durable row FIRST, while the slice still exists: the aborted
    // run's settleFailure persist no-ops once the slice is gone, which left a
    // closed-mid-run tab's History row spinning as "running" until the next
    // app-start sweep. persistRow reads the slice synchronously, so firing it
    // before the delete below is safe. (App-quit skips this — the startup
    // sweep reconciles those.)
    if (slice.busy && slice.runId) {
      void persistRow(tabId, { status: "cancelled" })
        .then(() =>
          window.dispatchEvent(
            new CustomEvent("devops-studio:commit-review-updated"),
          ),
        )
        .catch(() => {});
    }
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
