// Per-tab store for the Commit Review surface. Module-level (survives a React
// unmount from a pane split/merge, like the terminal/suite-chat stores) so an
// in-flight run keeps writing here even when the pane isn't mounted. Only an
// explicit stop() or tab close aborts.

import { create } from "zustand";
import {
  getModelOutputCeiling,
  isKnownModelId,
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  supportsVision,
  type ModelId,
} from "@/modules/ai/config";
import { formatTokens } from "@/modules/ai/lib/contextEstimate";
import {
  budgetSpentPhrase,
  type BudgetLimit,
  type RunBudget,
} from "@/modules/ai/lib/runBudget";

/** What Commit Review's investigate pass runs on. Only that stage can surface a
 *  budget failure to the user — a verify-stage one degrades to unverified
 *  findings — so this is the budget the failure copy names. */
const INVESTIGATE_BUDGET: RunBudget = {
  tokens: SURFACE_TOKEN_BUDGETS.commitReviewInvestigate,
  steps: SURFACE_STEP_CAPS.commitReviewInvestigate,
};
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  getRepos,
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { sameRoot, type WorkspaceRepo } from "@/modules/settings/store";
import { scopedRepos, toggleRepoScope } from "@/modules/ai/lib/repoScope";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import {
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  hasReplayableTranscript,
  listCheckpoints,
  sanitizeTranscriptMessages,
  type CheckpointOutcome,
  type CheckpointWriter,
  type CommitReviewCheckpointV2,
  type TranscriptCheckpoint,
} from "@/modules/ai/lib/checkpointApi";
import {
  canOfferResume,
  canRaiseOutputCap,
  classifyForResume,
  emptyAnswerCause,
} from "@/modules/ai/lib/errorClass";
import {
  diedOfContextOverflow,
  resumesByFinishing,
  sumUsage,
} from "@/modules/generator/lib/resumePolicy";
import type { TaskCheckpoint } from "@/modules/ai/lib/taskRunner";
import type { ContextBlock } from "@/modules/ai/lib/contextBlocks";
import type { Attachment } from "@/components/chat/attachments";
import type { WorkItemRef } from "@/modules/ado";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import {
  listCommits,
  commitDiff,
  commitKey,
  isLocalKey,
  splitCommitKey,
  workingTreeDiff,
  LOCAL_CHANGES_SHA,
  type MaybeRepoCommitDiff,
  type RepoCommitDiff,
  type RepoCommitMeta,
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

/** The scope key every commit-review checkpoint is filed under. A review spans
 *  the whole workspace now, so there is no per-directory scope left to key on —
 *  the column stays free-form TEXT on the Rust side, and `listCheckpoints`
 *  keeps filtering on it unchanged. */
const WORKSPACE_SCOPE = "workspace";

/** Commits read per repo. The merged timeline is capped separately — this is
 *  how deep into each repo's history the picker can see. */
const COMMITS_PER_REPO = 80;

/** Rows the merged timeline shows. Twenty repos × 80 commits is 1600 rows the
 *  user would scroll through one branch at a time; the search box is how you
 *  reach anything older. */
const MERGED_COMMIT_CAP = 200;

/** One reviewed commit, as persisted in the row's `commits` JSON blob. */
export type ReviewedCommit = {
  sha: string;
  short: string;
  subject: string;
  /** Which repo it came from. Absent on rows written before multi-repo — those
   *  predate the second repo existing, so they belong to the first one. */
  repoId?: string;
  repoName?: string;
};

export type CommitReviewSlice = {
  /** The repos this review covers — its workspace.
   *
   *  `null` tracks the live registry, so a repo added in Settings shows up in
   *  the picker without reopening the tab. A rehydrated saved run pins its OWN
   *  set here instead: reopening a review from History must show the repos it
   *  actually ran against, not whichever ones are configured today. */
  repoIds: string[] | null;
  /** Repo ids this run may READ — the separate, per-run narrowing. `null` = all
   *  of them. Deliberately NOT a filter on the commit list: a commit in one repo
   *  often can't be judged without reading a different repo that has no commit
   *  in the selection at all. */
  repoScope: string[] | null;
  // --- commit picker (multi-select) ---
  /** Every in-scope repo's commits, merged newest-first and capped. */
  commits: RepoCommitMeta[];
  /** What each repo actually returned, before the merge cap dropped anything.
   *
   *  `commits` is derived from this, never the other way round: a narrowed
   *  refresh re-reads one repo and re-merges, and merging from the CAPPED list
   *  would let each pass shave a few more rows off the repos it didn't read
   *  until a quiet one is down to its floor. Picker state only — a saved review
   *  persists the merged list. */
  commitsByRepo: Record<string, RepoCommitMeta[]>;
  commitsLoading: boolean;
  commitsError: string | null;
  /** Repos whose working tree has uncommitted changes — one "Local changes"
   *  target each. Refreshed alongside the commit list. */
  dirtyRepoIds: string[];
  /** The selected changes as `${repoId}:${sha}` keys, in `commits` order
   *  (newest first). A sha is only unique within its repo — every repo has a
   *  "local" — so the repo is part of the key. Legacy bare shas (persisted tabs
   *  and saved rows from the single-root era) are normalised on read. */
  selectedShas: string[];
  /** Diff cache keyed the same way. Read in selection order via
   *  `selectedDiffs()`. Missing keys are changes still loading or failed. */
  diffBySha: Record<string, RepoCommitDiff>;
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
  /** Stage 1's raw output, kept alongside `findings` from the moment it parses.
   *  These are real, paid-for results that used to exist only inside the
   *  checkpoint blob: a run stopped, crashed or rate-limited during the VERIFY
   *  pass had them on disk and rendered nothing, so the pane showed an activity
   *  log and the spend read as a total loss. Cleared once a run produces real
   *  `findings` (which supersede them) or the reviewed set changes. */
  stage1Candidates: CandidateFinding[] | null;
  appliedPatches: AppliedPatchesMap;
  busy: boolean;
  abort: AbortController | null;
  error: string | null;
  /** Structural failure reason when the run RESOLVED unusable (vs threw) —
   *  what the error card classifies on, so copy never string-matches. */
  errorReason: "step_cap" | "empty" | "schema_violation" | null;
  /** Which budget guard bound a `step_cap` failure, so the card names the one
   *  that actually stopped the run rather than always blaming steps. */
  errorLimit: BudgetLimit | null;
  /** Raw model text when stage 1 didn't return parseable findings. */
  schemaViolationRaw: string | null;
  runId: string | null;
  createdAt: string | null;
  durationMs: number | null;
  modelId: ModelId | null;
  /** Set when a failed / cancelled run left a checkpoint. Null when there's
   *  nothing on disk at all (never ran, or ran to completion). Whether a resume
   *  is on OFFER is `canOfferResume`'s call, which is why the progress fields
   *  live here: an answered-badly run that had already investigated is
   *  continuable, one that answered badly having read nothing is not. */
  resumable: {
    stage: RunStage;
    stepsUsed: number;
    /** Whether the checkpoint kept a transcript worth replaying. */
    hasTranscript: boolean;
    /** Whether a `finish: length` failure has anywhere to go on retry — a known
     *  output ceiling above the cap the attempt ran at. `canOfferResume` fails
     *  CLOSED without it, which is why a truncated review offered no resume at
     *  all while the generator, which passes it, offered one. */
    outputCapRaisable: boolean;
    totalTokens: number | null;
    updatedAt: string;
    outcome: CheckpointOutcome | null;
  } | null;
};

type State = {
  byTab: Map<number, CommitReviewSlice>;
  ensure: (
    tabId: number,
    rehydrateRunId?: string | null,
    modelId?: ModelId | null,
  ) => Promise<void>;
  /** Re-read commit lists + dirty state. `only` narrows it to one repo root;
   *  the repos it skips keep what they last reported. */
  loadCommits: (tabId: number, only?: string) => Promise<void>;
  /** Add/remove one change from the selection (by `${repoId}:${sha}` key), then
   *  load any missing diffs. Changing the selection invalidates the findings. */
  toggleCommit: (tabId: number, key: string) => Promise<void>;
  /** Add/remove one repo's "Local changes" target. It can be reviewed alone or
   *  alongside commits; adding it re-reads that repo's live working tree. */
  toggleLocalChanges: (tabId: number, repoId: string) => Promise<void>;
  /** Deselect every commit (the user must pick at least one to review). */
  clearCommits: (tabId: number) => void;
  /** Flip one repo's membership of the read scope. */
  toggleRepo: (tabId: number, repoId: string) => void;
  /** Re-read git state after an in-app branch switch / pull / stash op so an
   *  open tab doesn't show the previous branch's commit list, a stale
   *  dirty-state, or a cached "Local changes" diff from another branch. `root`
   *  is the `source-git-changed` payload: it narrows the refresh to the repo
   *  that moved, and a payload-less event means "refresh all". No-op while a
   *  review is running, and for a root outside this review's repos. */
  refreshSource: (tabId: number, root?: string) => Promise<void>;
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

/** The repos this review covers, in registry order. A pinned set (a rehydrated
 *  saved run) drops ids that no longer name a configured repo, so a review
 *  outlives one of its repos being removed. */
export function sliceRepos(slice: CommitReviewSlice): WorkspaceRepo[] {
  return scopedRepos(getRepos(), slice.repoIds);
}

/** The repos this run's tools may read: the review's repos, narrowed by the
 *  read scope. Code search off ⇒ none, and the run works from the diff alone. */
export function runRepos(slice: CommitReviewSlice): WorkspaceRepo[] {
  if (!usePreferencesStore.getState().codeSearchEnabled) return [];
  return scopedRepos(sliceRepos(slice), slice.repoScope);
}

/** The repo a selection key names, or null when it no longer resolves. */
export function repoForKey(
  slice: CommitReviewSlice,
  key: string,
): WorkspaceRepo | null {
  const repos = sliceRepos(slice);
  const { repoId } = splitCommitKey(key, repos[0]?.id ?? "");
  return repos.find((r) => r.id === repoId) ?? null;
}

/** The loaded diffs for the selected changes, in selection order. Changes whose
 *  diff is still loading or failed to load are skipped. */
export function selectedDiffs(slice: CommitReviewSlice): RepoCommitDiff[] {
  return slice.selectedShas
    .map((s) => slice.diffBySha[s])
    .filter((d): d is RepoCommitDiff => !!d);
}

/** True once every selected commit has a loaded diff (the gate for running). */
export function allDiffsLoaded(slice: CommitReviewSlice): boolean {
  return (
    slice.selectedShas.length > 0 &&
    slice.selectedShas.every((s) => !!slice.diffBySha[s])
  );
}

/** Re-order a set of selection keys to match the merged commit-list order
 *  (newest first) so diff sections render in a stable, predictable order.
 *
 *  Every repo's "Local changes" (uncommitted, newer than any commit) sorts
 *  ahead of every commit; among themselves the locals follow `repoIds` order,
 *  which is registry order — a stable position, never a ranking. */
export function orderShas(
  keys: string[],
  commits: RepoCommitMeta[],
  repoIds: string[] = [],
): string[] {
  const idx = new Map(commits.map((c, i) => [commitKey(c.repoId, c.sha), i]));
  // Commits rank from 0 up; locals occupy the negative band below them.
  const localFloor = -Math.max(repoIds.length, 1);
  const rank = (key: string) => {
    if (!isLocalKey(key)) return idx.get(key) ?? Number.MAX_SAFE_INTEGER;
    const pos = repoIds.indexOf(splitCommitKey(key, "").repoId);
    return localFloor + (pos === -1 ? repoIds.length - 1 : pos);
  };
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b));
}

/** Normalise persisted selection keys. Bare shas come from the single-root era
 *  (a persisted tab, or a saved row) and belong to the first repo — the one the
 *  app was pinned to when they were written. */
function normalizeKeys(keys: string[], fallbackRepoId: string): string[] {
  return keys.map((k) => {
    const { repoId, sha } = splitCommitKey(k, fallbackRepoId);
    return commitKey(repoId, sha);
  });
}

/** Tag a freshly-read diff with the repo it came from. */
function tagDiff(diff: Omit<RepoCommitDiff, "repoId" | "repoName">, repo: WorkspaceRepo): RepoCommitDiff {
  return { ...diff, repoId: repo.id, repoName: repo.name };
}

/** Key a checkpoint's snapshotted diffs. Payloads written before commit review
 *  went multi-repo carry untagged diffs under the single root the run used, so
 *  they take the first repo — the same rule bare selection keys follow. */
function snapshotDiffMap(
  diffs: MaybeRepoCommitDiff[],
  repos: WorkspaceRepo[],
): Record<string, RepoCommitDiff> {
  const out: Record<string, RepoCommitDiff> = {};
  for (const d of diffs) {
    const repo = repos.find((r) => r.id === d.repoId) ?? repos[0] ?? null;
    const tagged: RepoCommitDiff = {
      ...d,
      repoId: d.repoId || repo?.id || "",
      repoName: d.repoName || repo?.name || "",
    };
    out[commitKey(tagged.repoId, tagged.sha)] = tagged;
  }
  return out;
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
  payload: CommitReviewCheckpointV2,
  outcome: CheckpointOutcome,
): NonNullable<CommitReviewSlice["resumable"]> {
  return {
    stage: payload.stage,
    stepsUsed: payload.transcript?.stepsUsed ?? 0,
    hasTranscript: hasReplayableTranscript(payload.transcript),
    outputCapRaisable: canRaiseOutputCap(payload.modelId, outcome),
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
  buildPayload: (outcome: CheckpointOutcome | null) => CommitReviewCheckpointV2;
};

/** Terminal handling for a run that RESOLVED — shared by run() and resume(). */
async function settleResult(
  set: SetState,
  tabId: number,
  cp: CheckpointCtx,
  result: RunCommitReviewResult,
  /** The budget the failing stage actually ran under — the investigate pass's,
   *  or the smaller grant a resume runs on. Named in the failure copy, so it has
   *  to be the live one rather than the table's. */
  budget: RunBudget,
): Promise<void> {
  if (!result.ok) {
    const at = new Date().toISOString();
    // A loop that burned its whole budget still calling tools never reached the
    // point of writing its findings — continuable. So, for the same reason, is
    // one that answered with something unusable AFTER investigating: the
    // transcript is the expensive half of the review and only the last hop
    // failed. What isn't continuable is answering badly with nothing banked, and
    // that's the line `canOfferResume` draws below.
    const stepCapped = result.reason === "step_cap";
    const outcome: CheckpointOutcome = {
      at,
      kind: result.reason,
      ...(result.limit ? { limit: result.limit } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      // Persisted so a later `finish: length` resume can compare what the
      // attempt ran at against the model's ceiling. The generator has recorded
      // this since d9dca77; Commit Review dropped it, which is the other half
      // of why its truncation resume could only ever fail closed.
      ...(result.outputCap !== undefined ? { outputCap: result.outputCap } : {}),
    };
    const payload = cp.buildPayload(outcome);
    const resumable = resumableFrom(payload, outcome);
    const canContinue = canOfferResume(outcome, outcome.message ?? null, resumable);
    patch(set, tabId, {
      busy: false,
      abort: null,
      stage: null,
      status: "error",
      durationMs: result.durationMs,
      error: stepCapped
        ? `The review spent ${budgetSpentPhrase(result.limit, budget, formatTokens)} before it could write its findings. Resume adds ~${formatTokens(RESUME_TOPUP_TOKENS)} more tokens and asks the model to finish with what it has already read.`
        : canContinue
          ? `${emptyAnswerCause(result.reason === "schema_violation" ? "schema_violation" : "empty", result.finishReason)} It had already investigated over ${resumable.stepsUsed} step${resumable.stepsUsed === 1 ? "" : "s"} — resuming asks it to write the findings up from what it has instead of reviewing again.`
          : `${emptyAnswerCause(result.reason === "schema_violation" ? "schema_violation" : "empty", result.finishReason)} Re-run, or try a more capable model.`,
      errorReason: result.reason,
      errorLimit: stepCapped ? (result.limit ?? null) : null,
      schemaViolationRaw: stepCapped ? null : result.rawText,
      // Set whether or not a resume is on offer — the row is written below
      // either way, and this is the handle Discard hangs off. The pane asks
      // `canOfferResume` for the button; nulling it here is what once left an
      // unresumable checkpoint both unreachable and undeletable.
      resumable,
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
    // The merged findings ARE the candidates, verified — keeping both would
    // render the same issues twice, once as a partial-result warning.
    stage1Candidates: null,
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
    errorLimit: null,
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
): Promise<void> {
  let entries: Awaited<ReturnType<typeof listCheckpoints>>;
  try {
    entries = await listCheckpoints("commit-review", WORKSPACE_SCOPE);
  } catch {
    return;
  }
  // Adoption is a nicety on the mount path; `ensure` awaits it, so anything
  // thrown here rejects the whole mount and leaves the pane on its spinner.
  // The Rust command answers with an array or fails, but this is the wrong
  // place to be right by luck.
  if (!Array.isArray(entries)) return;
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
    // The workspace has to still BE the workspace this run read. Resuming
    // replays a transcript against live tools, so a repo that's since been
    // removed would answer "no such repo" to reads the transcript already has
    // results for — worse than not offering the resume at all.
    const configured = getRepos();
    if (p.repos.some((r) => !configured.some((c) => sameRoot(c.root, r.root)))) {
      continue;
    }
    // Same gate as every Resume affordance: a run that died non-resumably, or
    // answered badly with nothing banked, would just re-fail.
    if (
      !canOfferResume(p.lastOutcome, p.lastOutcome?.message ?? null, {
        stepsUsed: p.transcript?.stepsUsed ?? 0,
        hasTranscript: hasReplayableTranscript(p.transcript),
        outputCapRaisable: canRaiseOutputCap(p.modelId, p.lastOutcome),
      })
    ) {
      continue;
    }
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

    const snapshotDiffs = snapshotDiffMap(p.inputs.diffs, configured);
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
    // Undefined on a checkpoint written before budgets were denominated in
    // tokens; the panel then falls back to budget-neutral copy.
    const limit = p.lastOutcome?.limit ?? null;
    patch(set, tabId, {
      runId: p.runId,
      createdAt: p.createdAt,
      status,
      errorReason: status === "error" ? reason : null,
      errorLimit: status === "error" ? limit : null,
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
      // The scope the interrupted run started with — a resume replays against
      // `p.repos`, so the chips must not widen back to the whole registry.
      repoScope: p.repoScope ?? null,
      selectedShas: normalizeKeys(
        p.inputs.selectedShas,
        configured[0]?.id ?? "",
      ),
      // The snapshot the run was reviewing. Safe to seed: commit diffs are
      // immutable, and a fresh run() re-reads the live working tree anyway —
      // only resume() deliberately replays this snapshot.
      diffBySha: snapshotDiffs,
      // The verify-stage spend that was stranded: stage 1 parsed, its findings
      // went to disk, and the run died before anything rendered them.
      stage1Candidates: p.stage1Candidates,
      resumable: {
        stage: p.stage,
        stepsUsed: p.transcript?.stepsUsed ?? 0,
        hasTranscript: hasReplayableTranscript(p.transcript),
        outputCapRaisable: canRaiseOutputCap(p.modelId, p.lastOutcome),
        totalTokens: p.transcript?.usage?.totalTokens ?? null,
        updatedAt: cp.updatedAt,
        outcome: p.lastOutcome,
      },
    });
    return;
  }
}

function emptySlice(modelId: ModelId | null): CommitReviewSlice {
  return {
    repoIds: null,
    repoScope: null,
    commits: [],
    commitsByRepo: {},
    commitsLoading: false,
    commitsError: null,
    dirtyRepoIds: [],
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
    stage1Candidates: null,
    appliedPatches: {},
    busy: false,
    abort: null,
    error: null,
    errorReason: null,
    errorLimit: null,
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

  ensure: async (tabId, rehydrateRunId, modelId) => {
    const existing = get().byTab.get(tabId);
    if (existing) {
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
        emptySlice(modelId && isKnownModelId(modelId) ? modelId : null),
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
          // The saved row keeps only the reason token, never which guard bound
          // the loop — a reopened history entry gets budget-neutral copy rather
          // than a guess.
          const rowLimit = null;
          // Bug #8: a saved run reopens against ITS repos, never whichever are
          // configured right now. Roots that no longer resolve drop out; if
          // none do (the whole workspace moved), fall back to tracking the live
          // registry so the tab still works — the findings are historical
          // either way, and an empty picker would just be a dead pane.
          const rowRepoIds = repoIdsForRoots(parseRepoRoots(row.cwd));
          patch(set, tabId, {
            repoIds: rowRepoIds.length > 0 ? rowRepoIds : null,
            selectedShas: safeParseCommitShas(
              row.commits,
              row.commitSha,
              rowRepoIds[0] ?? getRepos()[0]?.id ?? "",
            ),
            context: row.context ?? "",
            status: row.status,
            findings,
            appliedPatches,
            runId: row.runId,
            createdAt: row.createdAt,
            durationMs: row.durationMs,
            errorReason: row.status === "error" ? rowReason : null,
            errorLimit: row.status === "error" ? rowLimit : null,
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
            // Only when the row carried no findings of its own: a completed
            // review's merged findings supersede the candidates they came from.
            stage1Candidates:
              done || curr?.findings.length ? null : p.stage1Candidates,
            // The read scope the run started with — the row can't carry it, and
            // a resume replays against `p.repos`, so the chips have to match.
            repoScope: p.repoScope ?? null,
            // A finished run has nothing to continue. An answered-badly one
            // might: `canOfferResume` (via the pane) decides on what the
            // attempt banked, so this only has to hand it the checkpoint —
            // which is also the handle Discard hangs off.
            resumable: done
              ? null
              : {
                  stage: p.stage,
                  stepsUsed: p.transcript?.stepsUsed ?? 0,
                  hasTranscript: hasReplayableTranscript(p.transcript),
                  outputCapRaisable: canRaiseOutputCap(
                    p.modelId,
                    p.lastOutcome,
                  ),
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
          selectedShas: normalizeKeys(
            tab.selectedShas ?? [],
            getRepos()[0]?.id ?? "",
          ),
          context: tab.context ?? "",
        });
      }
      // A fresh mount is where an interrupted run resurfaces after an app
      // restart — adopt it (inputs + resume affordance) instead of leaving
      // it discoverable only through History.
      await adoptInterruptedRun(set, get, tabId);
    }

    await get().loadCommits(tabId);

    // Select the rehydrated commits, or default to the uncommitted work when
    // there is any (the common "review what I'm about to commit" case), else
    // the newest change in the workspace. Every dirty repo is selected, not
    // one of them: at one repo that's exactly today's behaviour, and at
    // several, uncommitted work spanning repos is the case this pane exists
    // for. The selection is visible in the picker and the oversized-diff
    // banner still warns, so nothing is silently expensive.
    const slice = get().byTab.get(tabId);
    if (slice) {
      const shas = slice.selectedShas.length
        ? slice.selectedShas
        : slice.dirtyRepoIds.length > 0
          ? slice.dirtyRepoIds.map((id) => commitKey(id, LOCAL_CHANGES_SHA))
          : slice.commits[0]
            ? [commitKey(slice.commits[0].repoId, slice.commits[0].sha)]
            : [];
      patch(set, tabId, {
        selectedShas: orderShas(
          shas,
          slice.commits,
          sliceRepos(slice).map((r) => r.id),
        ),
      });
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
          const reachable = selectedDiffs(after).map((d) =>
            commitKey(d.repoId, d.sha),
          );
          // "Local changes" isn't a commit that can be rebased away — keep it
          // even if its live diff failed to load this time, so reopening a saved
          // local-changes review doesn't silently snap to an empty selection.
          const strandedLocals = after.selectedShas.filter(
            (k) => isLocalKey(k) && !reachable.includes(k),
          );
          const nextShas = [...reachable, ...strandedLocals];
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

  loadCommits: async (tabId, only) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    const all = sliceRepos(slice);
    // A branch switch moves ONE repo. Re-listing the others spends a
    // `git log` + a `git status` per repo to re-learn what they already said,
    // and the answer is merged back from `commitsByRepo` either way.
    const repos = only ? all.filter((r) => sameRoot(r.root, only)) : all;
    if (repos.length === 0) return;
    patch(set, tabId, { commitsLoading: true, commitsError: null });

    const results = await Promise.all(
      repos.map(async (repo) => {
        // A repo that can't be listed (moved on disk, not a git repo) travels
        // as data: one unreadable root must not empty the picker for the ones
        // that answered. Its dirty-state probe is separately non-fatal, so a
        // status failure only hides that repo's "Local changes" row.
        const dirty = await gitStatusSummary(repo.root).then(
          (s) => s.dirty,
          () => false,
        );
        try {
          const rows = await listCommits(repo.root, COMMITS_PER_REPO);
          return {
            repo,
            dirty,
            commits: rows.map((c) => ({
              ...c,
              repoId: repo.id,
              repoName: repo.name,
            })),
            error: null as string | null,
          };
        } catch (e) {
          return { repo, dirty, commits: [], error: errStr(e) };
        }
      }),
    );

    // Fold this pass over what the repos we didn't read last said, then drop
    // any repo that has since left the workspace.
    const before = get().byTab.get(tabId);
    if (!before) return;
    // A tab rehydrated from a persisted session (or any slice built before this
    // field existed) has the merged list and no buckets. Re-bucketing it is
    // lossy by exactly the rows the cap already dropped — losing the unread
    // repos from the picker entirely is not.
    const prior = before.commitsByRepo ?? bucketByRepo(before.commits);
    const byRepo: Record<string, RepoCommitMeta[]> = {};
    for (const repo of all) {
      const fresh = results.find((r) => r.repo.id === repo.id);
      byRepo[repo.id] = fresh ? fresh.commits : (prior[repo.id] ?? []);
    }

    const merged = mergeCommits(Object.values(byRepo), MERGED_COMMIT_CAP);
    const failed = results.filter((r) => r.error);
    // Same fold for dirty state: a narrowed pass only learned about its own
    // repo, so the others keep whatever was last known rather than reading as
    // clean and losing their "Local changes" row.
    const stillDirty = new Set(
      only
        ? before.dirtyRepoIds.filter((id) => !results.some((r) => r.repo.id === id))
        : [],
    );
    for (const r of results) if (r.dirty) stillDirty.add(r.repo.id);

    // A repo removed in Settings loses its rows above; its SELECTION keys have
    // to go with them, or the trigger keeps counting commits that no longer
    // have a row and a run starts against changes it can no longer read. Keyed
    // through `splitCommitKey`'s fallback so a legacy bare-sha selection still
    // resolves to the first repo rather than being read as an orphan.
    const liveIds = new Set(all.map((r) => r.id));
    const owned = (key: string) =>
      liveIds.has(splitCommitKey(key, all[0]?.id ?? "").repoId);
    const selectedShas = before.selectedShas.filter(owned);
    const diffBySha =
      selectedShas.length === before.selectedShas.length
        ? before.diffBySha
        : Object.fromEntries(
            Object.entries(before.diffBySha).filter(([key]) => owned(key)),
          );

    patch(set, tabId, {
      commits: merged,
      commitsByRepo: byRepo,
      commitsLoading: false,
      selectedShas,
      diffBySha,
      dirtyRepoIds: all.filter((r) => stillDirty.has(r.id)).map((r) => r.id),
      commitsError:
        failed.length === 0
          ? // A narrowed pass says nothing about the repos it skipped, so it
            // must not clear an error one of them is still in.
            (only ? (before.commitsError ?? null) : null)
          : failed.length === results.length && failed.length === 1
            ? // The single-repo case reads exactly as it always did.
              failed[0].error
            : `Couldn't read ${failed.map((r) => r.repo.name).join(", ")}: ${failed[0].error}`,
    });
  },

  toggleCommit: async (tabId, key) => {
    const slice = get().byTab.get(tabId);
    // Don't change the reviewed set mid-run: the in-flight run captured its diff
    // snapshot, so re-selecting now would orphan it and (because runId is reset)
    // silently drop the completed result. The picker is also disabled while busy.
    if (!slice || slice.busy) return;
    const has = slice.selectedShas.includes(key);
    const nextShas = orderShas(
      has
        ? slice.selectedShas.filter((s) => s !== key)
        : [...slice.selectedShas, key],
      slice.commits,
      sliceRepos(slice).map((r) => r.id),
    );
    // Changing the reviewed set invalidates the findings — they were about a
    // different change. Keep the input context (likely still relevant).
    patch(set, tabId, {
      selectedShas: nextShas,
      findings: [],
      stage1Candidates: null,
      activity: [],
      status: "idle",
      error: null,
      errorReason: null,
      errorLimit: null,
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

  toggleLocalChanges: async (tabId, repoId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    const key = commitKey(repoId, LOCAL_CHANGES_SHA);
    const has = slice.selectedShas.includes(key);
    // Always drop this repo's cached working-tree diff: removing it cleans up,
    // and re-adding should re-read the LIVE tree (the user may have edited
    // files since the last look). Changing the selection invalidates findings.
    const nextDiffs = { ...slice.diffBySha };
    delete nextDiffs[key];
    const nextShas = has
      ? slice.selectedShas.filter((s) => s !== key)
      : orderShas(
          [...slice.selectedShas, key],
          slice.commits,
          sliceRepos(slice).map((r) => r.id),
        );
    patch(set, tabId, {
      selectedShas: nextShas,
      diffBySha: nextDiffs,
      findings: [],
      stage1Candidates: null,
      activity: [],
      status: "idle",
      error: null,
      errorReason: null,
      errorLimit: null,
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
      stage1Candidates: null,
      activity: [],
      status: "idle",
      error: null,
      errorReason: null,
      errorLimit: null,
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

  toggleRepo: (tabId, repoId) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    patch(set, tabId, {
      repoScope: toggleRepoScope(slice.repoScope, sliceRepos(slice), repoId),
    });
  },

  refreshSource: async (tabId, root) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    const repos = sliceRepos(slice);
    // A payload-less event means "refresh all"; a root narrows it to the repo
    // that moved. Compared with the registry's own separator- and
    // case-insensitive rule, because a root that round-tripped through an
    // event payload comes back in whichever spelling that layer preferred —
    // a raw `!==` here is what once made this silently return forever.
    if (root && !repos.some((r) => sameRoot(r.root, root))) return;

    // Re-read the commit lists + dirty-state for the (possibly new) branches so
    // the picker offers the right commits and the "Local changes" affordances
    // match the current trees. Narrowed to the repo that actually moved.
    await get().loadCommits(tabId, root);

    // A branch switch / pull / stash op rewrote a working tree, so that repo's
    // cached "Local changes" diff is now stale. Drop it (commit diffs are
    // immutable and stay cached); reload if it's selected so the diff panel —
    // and the next run — reflect the live tree, never the old snapshot.
    const after = get().byTab.get(tabId);
    if (!after) return;
    const stale = Object.keys(after.diffBySha).filter((key) => {
      if (!isLocalKey(key)) return false;
      if (!root) return true;
      const repo = repos.find(
        (r) => r.id === splitCommitKey(key, "").repoId,
      );
      return !!repo && sameRoot(repo.root, root);
    });
    if (stale.length === 0) return;
    const nextDiffs = { ...after.diffBySha };
    for (const key of stale) delete nextDiffs[key];
    patch(set, tabId, { diffBySha: nextDiffs });
    if (stale.some((key) => after.selectedShas.includes(key))) {
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
    const repos = sliceRepos(slice);
    // Tag this load so only the most-recent toggle's load owns the
    // loading/error flags: an earlier load resolving late can't flip
    // diffLoading off while a newer one is still pending, nor clobber its error.
    const seq = slice.diffLoadSeq + 1;
    patch(set, tabId, { diffLoading: true, diffError: null, diffLoadSeq: seq });
    const results = await Promise.allSettled(
      missing.map((key) => {
        const { repoId, sha } = splitCommitKey(key, repos[0]?.id ?? "");
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) {
          return Promise.reject(
            new Error("That repo is no longer in your workspace."),
          );
        }
        return (
          sha === LOCAL_CHANGES_SHA
            ? workingTreeDiff(repo.root)
            : commitDiff(repo.root, sha)
        ).then((d) => tagDiff(d, repo));
      }),
    );
    const fetched: Record<string, RepoCommitDiff> = {};
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
      for (const key of Object.keys(fresh)) {
        if (isLocalKey(key) && !curr.selectedShas.includes(key)) {
          delete fresh[key];
        }
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
    const localKeys = slice.selectedShas.filter(isLocalKey);
    if (localKeys.length > 0) {
      const repos = sliceRepos(slice);
      const reread = await Promise.all(
        localKeys.map(async (key) => {
          const repo = repos.find(
            (r) => r.id === splitCommitKey(key, repos[0]?.id ?? "").repoId,
          );
          if (!repo) return null;
          try {
            return { key, diff: tagDiff(await workingTreeDiff(repo.root), repo) };
          } catch {
            // Keep the cached local diff — reviewing the last-known tree beats
            // refusing the run on a transient read error.
            return null;
          }
        }),
      );
      const now = get().byTab.get(tabId);
      // Drop the results if the tab vanished or a run already started; drop any
      // whose target the user deselected while we were reading (mirrors
      // loadDiffs).
      if (now && !now.busy) {
        const fresh: Record<string, RepoCommitDiff> = {};
        for (const r of reread) {
          if (r && now.selectedShas.includes(r.key)) fresh[r.key] = r.diff;
        }
        if (Object.keys(fresh).length > 0) {
          patch(set, tabId, { diffBySha: { ...now.diffBySha, ...fresh } });
        }
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
        stage1Candidates: null,
        error: null,
        errorReason: null,
        errorLimit: null,
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
      const { blocks: bpBlocks } = await loadBestPracticeBlocks(
        prefs.bestPracticeFiles,
        { visionCapable },
      );
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
        cwd: WORKSPACE_SCOPE,
        createdAt,
      });
      writer = w;
      const basePayload: CommitReviewCheckpointV2 = {
        v: 2,
        surface: "commit-review",
        runId,
        createdAt,
        modelId: effectiveModelId,
        cwd: WORKSPACE_SCOPE,
        repos: runRepos(slice),
        repoScope: slice.repoScope,
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
      ): CommitReviewCheckpointV2 => ({
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
        repos: basePayload.repos,
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
          // Render them NOW, before the (independently failable) verify pass —
          // this is the moment they stop being hypothetical spend.
          if (isLiveRun(get, tabId, runId)) {
            patch(set, tabId, { stage1Candidates: cands });
          }
          // Verify starts from its own prompt, so the investigate transcript
          // must not be handed to it on resume.
          transcript = null;
          // Flush, not save: this is the moment the investigate spend becomes
          // durable, and the throttle could otherwise lose it to a crash.
          void w.flush(build(null));
        },
        signal: abort.signal,
      });

      await settleResult(
        set,
        tabId,
        { writer: w, buildPayload: build },
        result,
        INVESTIGATE_BUDGET,
      );
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
    const snapshotDiffs = snapshotDiffMap(payload.inputs.diffs, getRepos());

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
        stage1Candidates:
          payload.stage === "investigate" ? null : payload.stage1Candidates,
        error: null,
        errorReason: null,
        errorLimit: null,
        schemaViolationRaw: null,
        abort,
        runId,
        createdAt: curr.createdAt ?? payload.createdAt,
        durationMs: null,
        resumable: null,
        selectedShas: normalizeKeys(
          payload.inputs.selectedShas,
          getRepos()[0]?.id ?? "",
        ),
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
      // Not payload.cwd: a checkpoint written before reviews spanned the
      // workspace is filed under a single root, and re-filing it here is what
      // keeps `listCheckpoints` finding the resumed row.
      cwd: WORKSPACE_SCOPE,
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
    ): CommitReviewCheckpointV2 => ({
      ...payload,
      cwd: WORKSPACE_SCOPE,
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
        // working tree here would review code the transcript never saw. The
        // snapshot map, not the raw payload: it carries the repo tag a
        // pre-multi-repo checkpoint's diffs don't.
        repos: payload.repos,
        diffs: Object.values(snapshotDiffs),
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
          if (isLiveRun(get, tabId, runId)) {
            patch(set, tabId, { stage1Candidates: cands });
          }
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
          // Budget-exhausted OR answered-badly: both stopped without findings
          // and both want the same "stop reading, write it up" pass.
          stepCapNudge: resumesByFinishing(
            payload.lastOutcome,
            hasReplayableTranscript(payload.transcript),
          ),
          afterOverflow: diedOfContextOverflow(payload.lastOutcome),
          // A truncated answer resumes at the model's output CEILING with the
          // truncation nudge, or — when no higher ceiling is known — not at
          // all: canOfferResume already refused it, and this keeps the two
          // gates reading the same field.
          ...(payload.lastOutcome?.finishReason === "length" &&
          canRaiseOutputCap(payload.modelId, payload.lastOutcome)
            ? { raisedOutputCap: getModelOutputCeiling(payload.modelId) }
            : {}),
        },
        signal: abort.signal,
      });

      await settleResult(
        set,
        tabId,
        { writer: w, buildPayload: build },
        result,
        // A budget-exhausted resume runs on the top-up, not the full pass — see
        // runCommitReview's resumeArgs.
        resumesByFinishing(
          payload.lastOutcome,
          hasReplayableTranscript(payload.transcript),
        )
          ? { ...INVESTIGATE_BUDGET, tokens: RESUME_TOPUP_TOKENS }
          : INVESTIGATE_BUDGET,
      );
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
    // The workspace this review ran in, so reopening it restores its own repos
    // rather than whichever are configured then (bug #8). The column is
    // unconstrained TEXT, like the `commits` blob beside it.
    cwd: JSON.stringify(sliceRepos(slice).map((r) => r.root)),
    commitSha: primary.sha,
    commitShort: primary.shortSha,
    commitSubject: primary.subject,
    commits: JSON.stringify(
      diffs.map(
        (d): ReviewedCommit => ({
          sha: d.sha,
          short: d.shortSha,
          subject: d.subject,
          repoId: d.repoId,
          repoName: d.repoName,
        }),
      ),
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

/** Restore the reviewed-commit selection keys from a saved row's `commits`
 *  blob, falling back to the single primary SHA for legacy rows (or an empty
 *  selection). Entries with no repo predate multi-repo and take `fallbackRepoId`
 *  — the first repo, which is the root the app was then pinned to. */
function safeParseCommitShas(
  json: string | null,
  fallbackSha: string,
  fallbackRepoId: string,
): string[] {
  if (json) {
    try {
      const v = JSON.parse(json);
      if (Array.isArray(v)) {
        const keys = v
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const { sha, repoId } = c as ReviewedCommit;
            if (typeof sha !== "string" || sha.length === 0) return null;
            return commitKey(repoId || fallbackRepoId, sha);
          })
          .filter((s): s is string => s !== null);
        if (keys.length > 0) return keys;
      }
    } catch {
      // fall through to the single-commit fallback
    }
  }
  return fallbackSha ? [commitKey(fallbackRepoId, fallbackSha)] : [];
}

/** The repo roots a saved row's `cwd` column names. New rows store a JSON
 *  array; anything that doesn't parse as one is a single path from the
 *  single-root era. */
function parseRepoRoots(cwd: string): string[] {
  try {
    const v = JSON.parse(cwd);
    if (Array.isArray(v)) {
      return v.filter((r): r is string => typeof r === "string" && !!r.trim());
    }
  } catch {
    // not JSON — a legacy single path
  }
  return cwd.trim() ? [cwd] : [];
}

/** Configured repo ids for a set of roots, in registry order. Roots that no
 *  longer name a configured repo simply drop out. */
function repoIdsForRoots(roots: string[]): string[] {
  return getRepos()
    .filter((r) => roots.some((root) => sameRoot(r.root, root)))
    .map((r) => r.id);
}

function errStr(e: unknown): string {
  return typeof e === "string" ? e : (e as Error)?.message ?? String(e);
}

/** Sort key for the merged timeline. `CommitMeta.date` is `%cI` — ISO-8601
 *  strict — but the offsets differ between repos cloned on different machines,
 *  so it's parsed rather than compared as text. An unparseable date sinks to
 *  the bottom instead of scrambling the order around it. */
function commitTime(c: RepoCommitMeta): number {
  const ms = Date.parse(c.date);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Split a merged timeline back into one list per repo, newest-first. */
function bucketByRepo(commits: RepoCommitMeta[]): Record<string, RepoCommitMeta[]> {
  const out: Record<string, RepoCommitMeta[]> = {};
  for (const c of commits) (out[c.repoId] ??= []).push(c);
  return out;
}

/** Rows every repo is guaranteed in the merged timeline, before the global cap
 *  gets to drop anything. Without a floor, a repo nobody has touched in months
 *  contributes ZERO rows — every one of its commits is older than the cap's
 *  worth of commits from the active repos — and becomes unreachable, because
 *  the picker's search filters this list rather than re-querying git. */
const MIN_COMMITS_PER_REPO = 10;

/** Merge every repo's commits into one newest-first timeline, capped, with each
 *  repo guaranteed its floor of rows. The floor shrinks as repos are added, but
 *  it bottoms out at one row per repo, so past `cap` repos the guarantee alone
 *  would overrun the cap — the final slice is what actually enforces it. */
function mergeCommits(
  perRepo: RepoCommitMeta[][],
  cap: number,
): RepoCommitMeta[] {
  const newestFirst = (a: RepoCommitMeta, b: RepoCommitMeta) =>
    commitTime(b) - commitTime(a);
  const withCommits = perRepo.filter((rows) => rows.length > 0);
  if (withCommits.length <= 1) {
    return withCommits.flat().sort(newestFirst).slice(0, cap);
  }
  const floor = Math.max(
    1,
    Math.min(MIN_COMMITS_PER_REPO, Math.floor(cap / withCommits.length)),
  );
  const guaranteed: RepoCommitMeta[] = [];
  const rest: RepoCommitMeta[] = [];
  for (const rows of withCommits) {
    const sorted = [...rows].sort(newestFirst);
    guaranteed.push(...sorted.slice(0, floor));
    rest.push(...sorted.slice(floor));
  }
  const filler = rest
    .sort(newestFirst)
    .slice(0, Math.max(0, cap - guaranteed.length));
  return [...guaranteed, ...filler].sort(newestFirst).slice(0, cap);
}
