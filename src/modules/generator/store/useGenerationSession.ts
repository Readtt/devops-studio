import { createContext, createElement, useContext } from "react";
import type { ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import {
  adoErrorMessage,
  createCaseInSuite,
  createBugAndLink,
  getBug,
  getConnection,
  getCase,
  isRequirementSuite,
  listPlans,
  normalizeSuiteType,
  listSuiteCases,
  listSuites,
  listTestPoints,
  setTestPointOutcome,
  suiteCapabilities,
  suiteRestriction,
  toTargetRequirement,
  updateCaseDescription,
  updateCaseSteps,
  updateWorkItemTitle,
  toAdoError,
  type AdoError,
  type CreatedWorkItem,
  type DraftCase as AdoDraftCase,
  type ExecutionOutcome,
  type SuiteRef,
  type SuiteType,
  type TargetRequirement,
  type TestPlanRef,
} from "@/modules/ado";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  describeGeneration,
  executeQaAnalystRun,
  modeToAxes,
  prepareQaAnalystRun,
  type Coverage,
  type PreparedAnalystRun,
  type RunAttachment,
  type RunResult,
  type TargetContext,
} from "../lib/qaAnalystRun";
import { resumeBudget, sumUsage } from "../lib/resumePolicy";
import {
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  hasReplayableTranscript,
  listCheckpoints,
  sanitizeTranscriptMessages,
  type CheckpointOutcome,
  type CheckpointWriter,
  type GeneratorCheckpointV2,
  type GeneratorRefineCheckpointV2,
  type TranscriptCheckpoint,
} from "@/modules/ai/lib/checkpointApi";
import {
  canOfferResume,
  canRaiseOutputCap,
  classifyForResume,
  emptyAnswerCause,
} from "@/modules/ai/lib/errorClass";
import type { TaskCheckpoint } from "@/modules/ai/lib/taskRunner";
import {
  getRepos,
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import type { WorkspaceRepo } from "@/modules/settings/store";
import { splitRepoPath } from "@/modules/ai/lib/repoPaths";
import { scopedRepos, toggleRepoScope } from "@/modules/ai/lib/repoScope";
import { invoke } from "@tauri-apps/api/core";
import type {
  DraftSourceLink,
  ReviewedBug,
  ReviewedCase,
} from "../lib/draftBatchSchema";
import { findSimilarCases } from "../lib/similarity";
import { bugParentCaseUid } from "../lib/bugLinking";
import {
  fetchRelatedCaseTitles,
  type RelatedCase,
} from "../lib/relatedCases";
import { renderBlock } from "@/modules/test-plans/lib/sourceLinksParser";
import { saveConfidence } from "@/modules/test-plans/lib/confidenceApi";
import { reconcileAutoOutcomes } from "../lib/caseAutoOutcome";
import type { SourceLink } from "@/modules/ado";
import {
  newRunId,
  newTimestamp,
  saveRun,
  specExcerpt,
  type GenerationRun,
  type RefineRound,
} from "../lib/history";
import { entryToLabel, type ActivityEntry } from "../lib/activityLog";
import { buildRefineUserPrompt } from "../lib/qaAnalystRefinePrompt";
import {
  streamChatTask,
  newChatMessageId,
  type ChatMessage,
} from "../lib/qaChatRun";
import { sanitizeTranscript } from "@/modules/ai/lib/finishPass";
import type { ModelMessage } from "ai";

/** The transcript fields to merge onto a settled assistant message. Absent when
 *  the turn banked nothing replayable — a provider that reported no steps, or a
 *  cancel that landed before the first one finished — so the message keeps the
 *  plain-text replay it would have had. */
function bankTranscript(
  messages: ModelMessage[],
): { transcript?: ModelMessage[] } {
  const safe = sanitizeTranscript(messages);
  return safe.length > 0 ? { transcript: safe } : {};
}

export type Phase =
  | "input"
  | "analyzing"
  | "review"
  | "publishing"
  | "done"
  | "error";

export type PublishLogEntry = {
  uid: string;
  kind: "case" | "bug";
  title: string;
  status: "pending" | "ok" | "failed";
  result?: CreatedWorkItem;
  error?: string;
};

import {
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
  stepSpend,
  type RunBudget,
} from "@/modules/ai/lib/runBudget";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import type { WorkItemRef } from "@/modules/ado";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";

// Attachment types + id minting live in the shared chat-attachment module.
// Re-export here so existing call sites that import these from the session
// store keep resolving.
import {
  newAttachmentId,
  type Attachment,
  type AttachmentKind,
} from "@/components/chat/attachments/types";
export { newAttachmentId };
export type { Attachment, AttachmentKind };

export type SessionState = {
  phase: Phase;
  // Input phase
  requirements: string;
  /** Optional changeset / scope notes the user pasted to narrow generation
   *  scope. Commit summaries, PR descriptions, raw diff text, ADO changeset
   *  links — anything that tells the analyst what actually changed so it
   *  doesn't generate full coverage for a style-only edit. The analyst
   *  prompt explicitly tells the model to treat this as POSSIBLY INCOMPLETE
   *  so missing changesets still get coverage from the spec. */
  changesets: string;
  attachments: Attachment[];
  /** Work items the user #mentioned in the requirements box, attached as
   *  read-only grounding context for the analyze run — the same affordance the
   *  chats offer. Converted to context blocks at analyze time. */
  attachedWorkItems: WorkItemRef[];
  planId: number | null;
  suiteId: number | null;
  /** Display names for the chosen plan + suite, populated by analyze() (and
   *  restored by loadDraft) so the tab title can render without an extra
   *  ADO fetch. Falls back to "#<id>" when unknown. */
  planName: string | null;
  suiteName: string | null;
  /** Target suite's ADO type, resolved by analyze() alongside the names.
   *  Two jobs: the review UI can badge a requirement-based target, and
   *  publish() can refuse a query-based one before creating any work items.
   *  Null until analyze resolves it (or a draft restores it). */
  targetSuiteType: SuiteType | null;
  /** Work item a requirement-based target tracks. The requirement's BODY is
   *  deliberately not stored — it's re-derived per analyze — but the id is
   *  cheap and lets a reopened draft explain itself without a fetch. */
  targetRequirementId: number | null;
  /** The requirement BODY, cached in memory for the life of this session only.
   *  analyze() already paid for the fetch; draft-chat reuses it so "did we
   *  cover every acceptance criterion?" is answered against the real criteria
   *  instead of blind. Deliberately absent from the draft payload and the
   *  checkpoint — it's re-derived on the next analyze, and persisting it would
   *  let a stale copy outlive an edit to the work item. */
  targetRequirement: TargetRequirement | null;
  /** Coverage depth for generated cases. */
  coverage: Coverage;
  /** Whether to also flag concrete bug suggestions. Independent of coverage. */
  suggestBugs: boolean;
  /** Stamp the local source branch / commit onto published artifacts so their
   *  code links point at the code they were generated from: the branch on each
   *  case's source links, and the source-dir HEAD SHA on bug code refs.
   *  Defaults to true; the user can turn it off in the input form. */
  tagSourceBranch: boolean;
  /** Repo ids this run may read; null = every configured repo. Session-scoped
   *  and reset per run, like {@link tagSourceBranch} — the app can't know which
   *  repos a spec touches, so narrowing is always the user's explicit act.
   *  Empty = read nothing, which is the per-run equivalent of code search off. */
  repoScope: string[] | null;
  /** Per-generation model override. When null, the run uses
   *  useChatStore.selectedModelId (the global default). Reset to null on
   *  startNew so each session starts from the latest default. */
  overrideModelId: ModelId | null;
  // Analyzing
  stepLabel: string;
  /** Streaming activity from the analyst engines: tool calls, results, and
   *  thinking steps. The AnalyzingPhase renders this as a log so the user
   *  can see what the agent is doing (which files it read, what it grepped). */
  activityLog: ActivityEntry[];
  durationMs: number | null;
  /** History run id, minted when analyze STARTS (not when it reaches review) so
   *  a run that dies mid-flight still has an identity its checkpoint and its
   *  tab can be keyed by. The draft snapshot is saved under this id; the later
   *  publish path upserts on the same id so the row reads "published" instead
   *  of creating a duplicate. */
  runId: string | null;
  /** Agentic steps the current/last analyze has completed — cumulative across
   *  resumes, so it keeps counting up rather than restarting at 0. */
  stepsUsed: number | null;
  /** Runaway step ceiling in force for the current/last analyze. Kept for the
   *  activity readout's fallback on endpoints that report no token usage — the
   *  budget below is what the run is actually rationed by. */
  stepCap: number | null;
  /** What the current/last analyze has spent AGAINST ITS BUDGET, in
   *  cost-equivalent tokens (runBudget.stepSpend — cache reads at a tenth,
   *  output at 5x, normalised to a fresh input token). Cumulative across
   *  resumes, so it keeps climbing rather than restarting at 0.
   *
   *  Deliberately NOT the raw token count, and not interchangeable with it:
   *  this is the budget's unit and the one that tracks the bill. Anything
   *  measuring the run rather than rationing it — the cache hit ratio, the
   *  dollar estimate — wants {@link tokensInput} instead. */
  tokensUsed: number | null;
  /** The ceiling `tokensUsed` is shown against. On a resume this is the PRIOR
   *  total plus this call's top-up, for the same reason `stepCap` is: both
   *  counters are cumulative, so a raw budget here would read "~1.2M / 500k". */
  tokenBudget: number | null;
  /** RAW input tokens the run sent, summed across steps and inclusive of cache
   *  reads — the provider's own count, undiscounted.
   *
   *  Separate from `tokensUsed` because the cache hit ratio is
   *  `cacheReadTokens / inputTokens` and computing it against a denominator
   *  that already discounts cache reads would flatter every run. (It also
   *  quietly fixes the old denominator, which was input PLUS output.) */
  tokensInput: number | null;
  /** How many of `tokensInput` were cache reads. Prices the run honestly —
   *  cached input bills at ~10% and an agentic loop is mostly cache hits — and,
   *  as a share of `tokensInput`, is the cache hit ratio the readout shows.
   *
   *  Null means the provider reported no cache detail at ALL, which is why this
   *  isn't seeded to 0: local endpoints and some gateways never report it, and
   *  rendering that as "cache 0%" would accuse a healthy run of a cost
   *  regression it didn't have. */
  tokensCached: number | null;
  /** Largest single request this run made, from the provider's own count. The
   *  run's spend is the sum of every request; this is the one that has to FIT,
   *  and the one to compare across runs when judging whether the caps and
   *  eviction are doing their job. Null until a step reports an input count. */
  peakPromptTokens: number | null;
  /** Date.now() when the current/last analyze started, for the elapsed timer. */
  analyzeStartedAt: number | null;
  /** What the current (or most recent) follow-up round spent, in the same units
   *  as the analyze fields above.
   *
   *  Deliberately its own object rather than reusing `tokensUsed` and friends.
   *  A refine that wrote into those would silently redefine the review header,
   *  which reads them beside the analyze run's duration and case count and
   *  means "what the run that produced this draft cost". A follow-up is a
   *  separate call with a separate budget; blending them would also blend the
   *  cache ratios, and a ratio averaged across two runs describes neither.
   *
   *  Null before the first round of a session. Reset at the start of each
   *  round, so the strip shows THIS round rather than the last one's total. */
  refineSpend: {
    stepsUsed: number;
    stepCap: number;
    /** Budget-unit spend — what the round is rationed by. */
    tokensUsed: number;
    tokenBudget: number;
    /** Raw provider counts, for the cache ratio. Null ⇒ not reported. */
    tokensInput: number | null;
    tokensCached: number | null;
    peakPromptTokens: number | null;
    /** Date.now() the round started, for the elapsed timer. */
    startedAt: number;
  } | null;
  /** Set when a failed / cancelled analyze left a checkpoint worth continuing.
   *  Null when there's nothing to resume (never ran, ran to completion, or the
   *  user discarded it). */
  resumable: {
    stepsUsed: number;
    /** Whether the checkpoint kept a transcript worth replaying. Carried in
     *  state because `canOfferResume` needs it for the answered-badly outcomes
     *  and the render sites only have this object. */
    hasTranscript: boolean;
    /** Whether a `finish: length` outcome has output headroom to retry with —
     *  same carry-it-for-the-gate reason as `hasTranscript`. */
    outputCapRaisable: boolean;
    totalTokens: number | null;
    updatedAt: string;
    outcome: CheckpointOutcome | null;
  } | null;
  // Review
  cases: ReviewedCase[];
  bugs: ReviewedBug[];
  rawText: string;
  // Publishing
  publishLog: PublishLogEntry[];
  // Error
  error: AdoError | string | null;
  /** Where the failure originated, so the error UI can render targeted
   *  guidance ("open AI settings" for analyze-time failures, "open ADO
   *  settings" for publish-time failures, etc.). */
  errorPhase: "analyze" | "publish" | "validation" | null;

  setRequirements: (s: string) => void;
  setChangesets: (s: string) => void;
  setCoverage: (c: Coverage) => void;
  setSuggestBugs: (v: boolean) => void;
  setTarget: (planId: number | null, suiteId: number | null) => void;
  /** Backfill plan/suite display names when they were missing from a
   *  loaded draft. Triggers a draft autosave so subsequent reopens use
   *  the resolved labels without another ADO lookup. */
  setPlanSuiteNames: (planName: string | null, suiteName: string | null) => void;
  setTagSourceBranch: (v: boolean) => void;
  /** Include/exclude one repo from this run's read scope. */
  toggleRepoScope: (repoId: string) => void;
  /** Set or clear (null) the per-generation model override. */
  setOverrideModelId: (id: ModelId | null) => void;
  /** Add a text attachment. Convenience wrapper around `addRichAttachment`
   *  for the existing single-string-content callers. */
  addAttachment: (path: string, content: string) => void;
  /** Add an attachment of any supported kind. Dedups by `path`. */
  addRichAttachment: (attachment: Attachment) => void;
  removeAttachment: (path: string) => void;
  /** Attach / detach a #mentioned work item for the analyze run. Dedups by id. */
  addWorkItem: (item: WorkItemRef) => void;
  removeWorkItem: (id: number) => void;
  clearWorkItems: () => void;
  analyze: () => Promise<void>;
  /** Continue the last analyze from its persisted checkpoint instead of paying
   *  for the transcript again. Re-issues the assembled prompt plus everything
   *  the run had already read; makes NO ADO calls. */
  resumeAnalyze: () => Promise<void>;
  /** Restore the form + resume affordance from a persisted checkpoint. Pure
   *  state, no IPC — the caller already read the row. */
  loadCheckpoint: (payload: GeneratorCheckpointV2, updatedAt: string) => void;
  /** Throw away the resume point (and its persisted row) for this run. */
  discardCheckpoint: () => void;
  /** Cancel an in-flight analyze and return to the input phase. Aborts the
   *  model request itself (via the shared runner's abort signal) so the
   *  provider stops generating — not just a discard of the result. */
  cancel: () => void;
  /** Return to the input phase from an error WITHOUT wiping form state.
   *  Distinct from `startNew()`, which clears everything for a fresh run. */
  tryAgain: () => void;
  setCaseDecision: (uid: string, decision: "keep" | "skip") => void;
  setBugDecision: (uid: string, decision: "keep" | "skip") => void;
  /** Edit a case's title in place. */
  setCaseTitle: (uid: string, title: string) => void;
  /** Edit a case's reviewer rationale in place. */
  setCaseRationale: (uid: string, rationale: string) => void;
  /** Set (or clear, with null) the run outcome the reviewer wants recorded
   *  for a case after it publishes. */
  setCaseOutcome: (
    uid: string,
    outcome: Exclude<ExecutionOutcome, "Active"> | null,
  ) => void;
  /** Attach an AI confidence verdict to a draft case (persisted in the draft). */
  setCaseVerdict: (uid: string, verdict: ConfidenceVerdict) => void;
  /** Point a draft case at an existing ADO case so publish UPDATES it in place
   *  instead of creating a new one (null = go back to creating). */
  setCaseUpdateTarget: (uid: string, caseId: number | null) => void;
  /** Edit a single test step's action OR expected result. Pass the case
   *  uid + step index; either field can be undefined to leave unchanged. */
  setCaseStep: (
    uid: string,
    stepIndex: number,
    patch: { action?: string; expected?: string },
  ) => void;
  /** Add a blank step to the end of a case. */
  addCaseStep: (uid: string) => void;
  /** Remove a step from a case. No-op when only one step remains (the
   *  draft schema requires at least 1). */
  removeCaseStep: (uid: string, stepIndex: number) => void;
  /** Edit a bug suggestion's title in place. */
  setBugTitle: (uid: string, title: string) => void;
  /** Edit a bug's repro steps blob in place. */
  setBugReproSteps: (uid: string, reproSteps: string) => void;
  /** Set the developer a single bug is assigned to on publish (or clear with
   *  null). */
  setBugAssignee: (uid: string, assignedTo: string | null) => void;
  /** Assign every KEPT bug to a developer in one go (the review-phase "assign
   *  all bugs to…" picker). Pass null to clear them all. */
  setAllBugsAssignee: (assignedTo: string | null) => void;
  /** Re-link a bug to a different draft case (by case uid). The picker on
   *  the bug card uses this when the user explicitly chooses a new parent
   *  after the original case was skipped. */
  setBugParent: (bugUid: string, caseUid: string | null) => void;
  /** Per-change revert for the refine diff panel. All three are index-safe so
   *  bug→case links (which are index-based) never shift out from under a bug:
   *  - restoreCaseContent / restoreBugContent replace an item IN PLACE (same
   *    uid + array position) with its pre-refine snapshot version.
   *  - restoreRemovedCase / restoreRemovedBug re-APPEND an item the refine
   *    dropped (appending never shifts existing indices). The caller resolves
   *    a restored bug's parent link against the live cases before passing it. */
  restoreCaseContent: (uid: string, from: ReviewedCase) => void;
  restoreBugContent: (uid: string, from: ReviewedBug) => void;
  restoreRemovedCase: (from: ReviewedCase) => void;
  restoreRemovedBug: (from: ReviewedBug) => void;
  publish: () => Promise<void>;
  /** Replace the display title for a single publish-log entry. Used by the
   *  done-phase focus refresh to pick up renames made in the ADO web UI
   *  after we published. */
  setPublishLogTitle: (uid: string, title: string) => void;
  /** True while a refine() call is in flight. The review UI swaps to a
   *  streaming-log layout, similar to the analyze phase, while this is set. */
  isRefining: boolean;
  /** Snapshot of cases/bugs/rawText taken right before the last successful
   *  refine() landed. Powers a single-step "undo refine" affordance. Cleared
   *  on a fresh analyze, on undoRefine(), and on startNew(). */
  refineUndoSnapshot:
    | { cases: ReviewedCase[]; bugs: ReviewedBug[]; rawText: string }
    | null;
  /** Error message from the most recent refine attempt. Surfaced inline by
   *  the composer (banner over the textarea) so a failed refine keeps the
   *  user in review with their prior draft intact. Cleared by dismissRefineError(). */
  refineError: string | null;
  /** Most-recent-first list of refine prompts the user has actually sent
   *  this session. Capped at REFINE_HISTORY_MAX so it stays scannable. */
  refineHistory: string[];
  /** Structured refine history — one entry per round with the instruction,
   *  activity log, before/after counts, and outcome. Oldest-first. The
   *  user can read this back in the review pane to recover the thinking
   *  process behind why a draft is in its current shape. Persisted on the
   *  draft row so it survives a window close. */
  refineRounds: RefineRound[];
  /** Set when a follow-up died with paid-for work worth continuing — stopped
   *  by the user, killed by a provider/network error, or out of run budget.
   *  Null when there's nothing to resume. Deliberately separate from
   *  `resumable` (which belongs to analyze): a draft outlives its analyze
   *  checkpoint, so the two can be live at different times and must not
   *  overwrite each other's affordance. */
  refineResumable: {
    /** The checkpoint row's id — per follow-up round, not the session runId. */
    runId: string;
    /** What the user asked, so the affordance can name the follow-up. */
    instruction: string;
    stepsUsed: number;
    /** See `resumable.hasTranscript`. */
    hasTranscript: boolean;
    /** See `resumable.outputCapRaisable`. */
    outputCapRaisable: boolean;
    totalTokens: number | null;
    updatedAt: string;
    outcome: CheckpointOutcome | null;
  } | null;
  /** Re-prompt the model with the current draft + a follow-up instruction.
   *  Replaces cases/bugs on success and stashes the previous state for
   *  undoRefine(). Errors are surfaced via refineError without leaving review. */
  refine: (instruction: string, workItemIds?: number[]) => Promise<void>;
  /** Continue the last follow-up from its persisted checkpoint instead of
   *  paying for its tool loop again. Replays the assembled prompt plus
   *  everything the round had already read; makes NO ADO calls. */
  resumeRefine: () => Promise<void>;
  /** Throw away the resume point (and its persisted row) for the last
   *  interrupted follow-up. */
  discardRefineCheckpoint: () => void;
  /** Look for an interrupted follow-up belonging to this draft and surface it.
   *  Called by the review pane on mount — that's how a follow-up interrupted by
   *  an app quit resurfaces after the draft is rehydrated from history. */
  probeRefineCheckpoint: () => Promise<void>;
  /** Kill the in-flight refine subprocess and return the UI to the composer.
   *  ESC during refine wires here. Tolerated when nothing is running. */
  cancelRefine: () => void;
  // --- Review-phase chat ---
  /** Messages in the floating Q&A chat over the current draft. Oldest first.
   *  This is conversational — NOT the structured refine history. The user
   *  asks "why is this a bug" / "do these cover X" and the model answers
   *  with markdown. Never auto-edits the draft. */
  chatMessages: ChatMessage[];
  /** True while a chat response is in flight. */
  chatBusy: boolean;
  /** Last chat error surfaced inline in the chat panel. Cleared on the next
   *  sendChatMessage. */
  chatError: string | null;
  /** Id of the assistant message currently being streamed into, so the UI
   *  can render the live caret / thinking placeholder on the right bubble.
   *  Null when no response is streaming. */
  chatStreamingId: string | null;
  /** Send a question to the chat thread. Optimistically appends a user
   *  message + a placeholder assistant message, then resolves the
   *  assistant content when the model returns. */
  sendChatMessage: (question: string, bugIds?: number[]) => Promise<void>;
  /** Cancel the in-flight chat round (Claude CLI only). The user's message
   *  stays in the thread; the assistant placeholder is dropped. */
  cancelChat: () => void;
  /** Wipe the chat thread for the current session. Used when starting fresh
   *  on a new spec, or by the user explicitly clicking "clear chat". */
  clearChat: () => void;
  /** Drop the persistent chat error banner. */
  dismissChatError: () => void;
  /** Restore the most recent refine snapshot. No-op if none. */
  undoRefine: () => void;
  /** Clear the lingering refine error banner. */
  dismissRefineError: () => void;
  /** Jump back to the input phase WITHOUT wiping any session state. Used by
   *  the clickable progress-strip breadcrumb so the user can edit the spec /
   *  target / attachments and either re-analyze (which then wipes the draft)
   *  or jump back to review via goToReview(). */
  goToInput: () => void;
  /** Jump forward to the review phase. Only valid when a draft already
   *  exists (cases.length > 0); otherwise no-op so a click can't strand the
   *  user on an empty review screen. */
  goToReview: () => void;
  /** Jump back to the done phase. Only valid once publish has actually run
   *  (publishLog is non-empty); otherwise no-op so a click can't strand the
   *  user on an empty success screen. Mirrors goToReview's design. */
  goToDone: () => void;
  reset: () => void;
  startNew: () => void;
  /** Hydrate the session from a saved draft history row. Returns true when
   *  the row carried a full draft payload (so the caller can confirm the
   *  open-in-review action actually worked). Returns false for legacy rows
   *  that only persisted titles — those can't be restored to review. */
  loadDraft: (run: GenerationRun) => boolean;
  /** Reopen a published run in the done phase. Reconstructs publishLog
   *  result objects from the row's persisted cases/bugs arrays (matched by
   *  kind+order) so the success screen can still link out to ADO and back
   *  into the app's case/bug detail panes. The draft body is restored when
   *  the row carries one — otherwise review is locked out (no draft to
   *  navigate to). Returns true when at least the done screen is renderable. */
  loadPublishedRun: (run: GenerationRun) => boolean;
};

let uidCounter = 0;
const uid = () => `u${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

/** True for the rejection a cancelled run throws — the shared runner
 *  surfaces DOM AbortError; the legacy CLI path used kind: "cancelled". */
function isCancelledError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  return (
    (e as { name?: string }).name === "AbortError" ||
    (e as { kind?: string }).kind === "cancelled"
  );
}

/** Fold one runner checkpoint into a persistable transcript, carrying the
 *  totals earlier attempts already accrued. Returns null when the messages
 *  can't survive a JSON round-trip — the caller then persists inputs-only
 *  rather than a transcript that would fail to parse on the way back in. */
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

/** Engine attachments → the checkpoint's wire shape, which requires an `id`
 *  and a concrete `kind`. Session attachments already carry a real id; the
 *  context-block images merged in beside them may not, so those get a stable
 *  positional one. Round-tripping back through PreparedAnalystRun is a no-op —
 *  the engine only ever reads path/content/kind/mime. */
function toCheckpointAttachments(
  attachments: (RunAttachment & { id?: string })[],
): Attachment[] {
  return attachments.map((a, i) => ({
    ...a,
    id: a.id ?? `cp-att-${i}`,
    kind: a.kind ?? "text",
  }));
}

/** Attach the streamed-but-never-parsed final answer, so a run that died
 *  mid-answer keeps what it had written for salvage/debugging. */
function withPartialText(
  transcript: TranscriptCheckpoint | null,
  partialText: string,
): TranscriptCheckpoint | null {
  if (!transcript || !partialText) return transcript;
  return { ...transcript, partialText };
}

/** The resume affordance derived from the payload we just flushed, so what the
 *  UI offers and what's actually on disk can't drift. */
function resumableFrom(
  payload: GeneratorCheckpointV2,
  outcome: CheckpointOutcome,
): NonNullable<SessionState["resumable"]> {
  return {
    stepsUsed: payload.transcript?.stepsUsed ?? 0,
    hasTranscript: hasReplayableTranscript(payload.transcript),
    outputCapRaisable: canRaiseOutputCap(payload.modelId, outcome),
    totalTokens: payload.transcript?.usage?.totalTokens ?? null,
    updatedAt: outcome.at,
    outcome,
  };
}

/** Same idea for a follow-up round, keyed by the row it was flushed to. */
function refineResumableFrom(
  payload: GeneratorRefineCheckpointV2,
  outcome: CheckpointOutcome,
): NonNullable<SessionState["refineResumable"]> {
  return {
    runId: payload.runId,
    instruction: payload.round.instruction,
    stepsUsed: payload.transcript?.stepsUsed ?? 0,
    hasTranscript: hasReplayableTranscript(payload.transcript),
    outputCapRaisable: canRaiseOutputCap(payload.modelId, outcome),
    totalTokens: payload.transcript?.usage?.totalTokens ?? null,
    updatedAt: outcome.at,
    outcome,
  };
}

/** The checkpoint handles a live follow-up round carries around, so refine()
 *  and resumeRefine() can share one set of terminal paths. */
type RefineCheckpointCtx = {
  writer: CheckpointWriter;
  buildPayload: (
    outcome: CheckpointOutcome | null,
  ) => GeneratorRefineCheckpointV2;
};

/** The bookkeeping one follow-up round is recorded under. Lives in the round's
 *  checkpoint so a round finished by a resume still lands in history as the
 *  round the user started — same timestamp, same before-counts — rather than a
 *  second round dated at resume time. */
type RefineRoundMeta = GeneratorRefineCheckpointV2["round"];

/** Add this round's outcome to the thinking history.
 *
 *  A RESUME replaces the entry its earlier attempt left behind: it continues
 *  one follow-up, so the history should show how that follow-up ended — two
 *  rows sharing an instruction and a timestamp (one "failed", one "ok") read as
 *  two separate asks that never happened.
 *
 *  A fresh round always appends, even when it matches. The match key is
 *  second-granular (newTimestamp strips millis), so re-sending the same preset
 *  twice inside one second would otherwise silently swallow the first attempt.
 *  A resume is already pinned to one stored round, so it has no such ambiguity. */
function recordRound(
  rounds: RefineRound[],
  next: RefineRound,
  resumed: boolean,
  /** The live round's meter, stamped onto the entry so the thinking history
   *  can price a past round. Absent ⇒ nothing was reported and the row says
   *  so, rather than showing a confident zero. */
  spend?: SessionState["refineSpend"],
): RefineRound[] {
  next = spend
    ? {
        ...next,
        spend: {
          stepsUsed: spend.stepsUsed,
          tokensUsed: spend.tokensUsed,
          tokensInput: spend.tokensInput,
          tokensCached: spend.tokensCached,
          peakPromptTokens: spend.peakPromptTokens,
        },
      }
    : next;
  const i = resumed
    ? rounds.findIndex(
        (r) =>
          r.timestamp === next.timestamp && r.instruction === next.instruction,
      )
    : -1;
  if (i < 0) return [...rounds, next];
  const merged = rounds.slice();
  merged[i] = next;
  return merged;
}

/** The RefineRound for an attempt that left the draft untouched (cancelled,
 *  failed, empty, out of steps). before/after counts are equal by definition. */
function unchangedRound(
  round: RefineRoundMeta,
  activityLog: ActivityEntry[],
  outcome: RefineRound["outcome"],
  error: string | null,
): RefineRound {
  return {
    timestamp: round.startedAt,
    instruction: round.instruction,
    activityLog,
    beforeCases: round.beforeCases,
    afterCases: round.beforeCases,
    beforeBugs: round.beforeBugs,
    afterBugs: round.beforeBugs,
    outcome,
    error,
  };
}

/** Checkpoint id for one follow-up round. Deliberately NOT the session's runId:
 *  a round the user cancelled is still unwinding (its throttled write can land
 *  up to ~500ms later) when the next round starts, and a shared row would let
 *  that stale write clobber the new round's resume point. */
function newRefineRunId(): string {
  return `rfn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Nudge the History pane (and anything else listening) that a run's durable
 *  state changed — a terminal checkpoint flush, a draft save, the checkpoint
 *  getting deleted. Without this an interrupted run only appeared in History
 *  after a manual reload. */
function notifyHistoryUpdated(runId: string | null): void {
  try {
    window.dispatchEvent(
      new CustomEvent("devops-studio:history-updated", { detail: { runId } }),
    );
  } catch {
    // Non-fatal — synchronous dispatch should never throw.
  }
}

/** Build the ADO work-item web URL for a case id — used to link an UPDATED
 *  case from the publish log (the create path gets this from the Rust result;
 *  the update path has no such response, so we construct it). */
function caseWebUrl(orgUrl: string, project: string, id: number): string {
  if (!orgUrl || !project) return "";
  return `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

const initialState: Omit<
  SessionState,
  | "setRequirements"
  | "setChangesets"
  | "setCoverage"
  | "setSuggestBugs"
  | "setTarget"
  | "setPlanSuiteNames"
  | "setTagSourceBranch"
  | "toggleRepoScope"
  | "setOverrideModelId"
  | "addAttachment"
  | "addRichAttachment"
  | "removeAttachment"
  | "addWorkItem"
  | "removeWorkItem"
  | "clearWorkItems"
  | "analyze"
  | "resumeAnalyze"
  | "loadCheckpoint"
  | "discardCheckpoint"
  | "cancel"
  | "tryAgain"
  | "setCaseDecision"
  | "setBugDecision"
  | "setBugParent"
  | "restoreCaseContent"
  | "restoreBugContent"
  | "restoreRemovedCase"
  | "restoreRemovedBug"
  | "setCaseTitle"
  | "setCaseRationale"
  | "setCaseOutcome"
  | "setCaseVerdict"
  | "setCaseUpdateTarget"
  | "setCaseStep"
  | "addCaseStep"
  | "removeCaseStep"
  | "setBugTitle"
  | "setBugReproSteps"
  | "setBugAssignee"
  | "setAllBugsAssignee"
  | "publish"
  | "setPublishLogTitle"
  | "sendChatMessage"
  | "cancelChat"
  | "clearChat"
  | "dismissChatError"
  | "reset"
  | "startNew"
  | "loadDraft"
  | "loadPublishedRun"
  | "refine"
  | "resumeRefine"
  | "discardRefineCheckpoint"
  | "probeRefineCheckpoint"
  | "cancelRefine"
  | "undoRefine"
  | "dismissRefineError"
  | "goToInput"
  | "goToReview"
  | "goToDone"
> = {
  phase: "input",
  requirements: "",
  changesets: "",
  attachments: [],
  attachedWorkItems: [],
  planId: null,
  suiteId: null,
  planName: null,
  suiteName: null,
  targetSuiteType: null,
  targetRequirementId: null,
  targetRequirement: null,
  coverage: "full",
  suggestBugs: true,
  tagSourceBranch: true,
  repoScope: null,
  overrideModelId: null,
  stepLabel: "",
  activityLog: [],
  durationMs: null,
  runId: null,
  stepsUsed: null,
  stepCap: null,
  tokensUsed: null,
  tokenBudget: null,
  tokensInput: null,
  tokensCached: null,
  peakPromptTokens: null,
  analyzeStartedAt: null,
  refineSpend: null,
  resumable: null,
  cases: [],
  bugs: [],
  rawText: "",
  publishLog: [],
  error: null,
  errorPhase: null,
  isRefining: false,
  refineUndoSnapshot: null,
  refineError: null,
  refineHistory: [],
  refineRounds: [],
  refineResumable: null,
  chatMessages: [],
  chatBusy: false,
  chatStreamingId: null,
  chatError: null,
};

const REFINE_HISTORY_MAX = 12;

/** What a FULL generator attempt runs on — analyze and review-phase follow-ups
 *  alike, since they drive the same engine over the same tools. A resume builds
 *  its own from `resumeBudget`, which is why this is a value rather than being
 *  read from the tables at each use site. */
const GENERATOR_BUDGET: RunBudget = {
  tokens: SURFACE_TOKEN_BUDGETS.generator,
  steps: SURFACE_STEP_CAPS.generator,
};

/** Fold one request's measured size into the run's peak. A zustand updater
 *  rather than a read-then-write so two steps landing in the same tick can't
 *  clobber each other's maximum. */
function peakFrom(promptTokens: number) {
  return (s: { peakPromptTokens: number | null }) => ({
    peakPromptTokens: Math.max(s.peakPromptTokens ?? 0, promptTokens),
  });
}

/** Fold one completed step's usage into the live round's spend. Mirrors what
 *  analyze() writes into the top-level token fields — the follow-up used to
 *  write none of it, which is why the refine dock could show a live activity
 *  log and no cost beside it. */
function refineSpendFrom(cp: {
  stepsUsed: number;
  usage: { inputTokens?: number; cacheReadTokens?: number };
}) {
  return (s: { refineSpend: SessionState["refineSpend"] }) =>
    s.refineSpend
      ? {
          refineSpend: {
            ...s.refineSpend,
            stepsUsed: cp.stepsUsed,
            tokensUsed: stepSpend(cp.usage),
            // Absent (not 0) when the provider reported nothing — rendering an
            // unreported cache count as 0% accuses a healthy run of a
            // regression it didn't have.
            tokensInput: cp.usage.inputTokens ?? null,
            tokensCached: cp.usage.cacheReadTokens ?? null,
          },
        }
      : {};
}

/** The refine-side twin. Same reason for being an updater, and a no-op once the
 *  round has been cleared out from under a late-landing step. */
function refinePeakFrom(promptTokens: number) {
  return (s: { refineSpend: SessionState["refineSpend"] }) =>
    s.refineSpend
      ? {
          refineSpend: {
            ...s.refineSpend,
            peakPromptTokens: Math.max(
              s.refineSpend.peakPromptTokens ?? 0,
              promptTokens,
            ),
          },
        }
      : {};
}

/** Sum two counts that are ABSENT when the provider never reported them. Adding
 *  with `?? 0` would turn "this endpoint doesn't meter cache reads" into a
 *  confident zero, which the readout would then show as a 0% hit ratio — an
 *  accusation of a cost regression that never happened. */
function addReported(
  a: number | undefined | null,
  b: number | undefined | null,
): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Debounce window for auto-persisting draft edits.
 *
 *  Originally 350ms, but EditableText only commits on blur / Enter (not on
 *  every keystroke), so the "burst of edits" the debounce was designed to
 *  coalesce never actually happens. A long window also lost writes when
 *  the user closed the window within the debounce. 50ms now: long enough
 *  to coalesce duplicate events fired in the same tick, short enough that
 *  the save reliably lands before a typical close-the-window. */
const DRAFT_AUTOSAVE_MS = 50;

/** Persist the current session as a "draft" history row. Cheap when called
 *  in tight loops — the actual write is debounced so a burst of edits ends
 *  with a single round-trip to the Rust history store. No-op when no run
 *  id exists (we only persist post-analyze, never mid-input).
 *
 *  The timer is captured per-store via a closure in createGenerationSessionStore,
 *  not module-global, so two parallel generator tabs don't trample each
 *  other's debounced writes. */
function makeSchedulePersistDraft(getter: () => SessionState) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function schedulePersistDraft(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const s = getter();
      if (!s.runId) return;
      if (s.phase !== "review" && s.phase !== "done") return;
      // Don't downgrade a published row back to a draft — the publish path
      // moves the row to status="published" and we must not overwrite that.
      // We only write here if the row never reached publish.
      if (s.publishLog.some((l) => l.status === "ok")) return;
      const run: GenerationRun = {
        id: s.runId,
        timestamp: newTimestamp(),
        planId: s.planId,
        planName: s.planName,
        suiteId: s.suiteId,
        suiteName: s.suiteName,
        suiteType: s.targetSuiteType,
        mode: describeGeneration(s.coverage, s.suggestBugs),
        specExcerpt: specExcerpt(s.requirements ?? ""),
        cases: s.cases.map((c) => ({
          title: c.title,
          adoId: null,
          webUrl: null,
        })),
        bugs: s.bugs.map((b) => ({
          title: b.title,
          severity: b.severity,
          adoId: null,
          webUrl: null,
        })),
        publishLog: [],
        status: "draft",
        draftPayload: {
          requirements: s.requirements,
          changesets: s.changesets,
          coverage: s.coverage,
          suggestBugs: s.suggestBugs,
          overrideModelId: s.overrideModelId,
          cases: s.cases,
          bugs: s.bugs,
          rawText: s.rawText,
          planId: s.planId,
          planName: s.planName,
          suiteId: s.suiteId,
          suiteName: s.suiteName,
          targetSuiteType: s.targetSuiteType,
          targetRequirementId: s.targetRequirementId,
          refineRounds: s.refineRounds,
          refineUndoSnapshot: s.refineUndoSnapshot,
          attachments: s.attachments,
        },
      };
      // Fire-and-forget; the post-save event lets the History pane refresh.
      void saveRun(run)
        .then(() => {
          try {
            window.dispatchEvent(
              new CustomEvent("devops-studio:history-updated", {
                detail: { runId: s.runId },
              }),
            );
          } catch {
            // Non-fatal — synchronous dispatch should never throw.
          }
        })
        .catch((e) => {
          // A dropped autosave shouldn't be silent — surface it so a failing
          // history write is diagnosable instead of looking like "saved".
          console.error("[generator] draft autosave failed:", e);
        });
    }, DRAFT_AUTOSAVE_MS);
  };
}

/** Create a new, isolated generation session store. Each generator tab owns
 *  one — switching tabs is a context switch, not a stash-and-restore on the
 *  same shared singleton.
 *
 *  Returns the Zustand `StoreApi` directly so callers can subscribe, snapshot
 *  via `.getState()`, and pass the store reference into the React context. */
export type GenerationSessionStore = StoreApi<SessionState>;

export function createGenerationSessionStore(): GenerationSessionStore {
  return createStore<SessionState>((set, get) => {
    const schedulePersistDraft = makeSchedulePersistDraft(get);
    // Abort handles for this tab's in-flight model runs. Captured per-store
    // (like the persist timer above) — generator tabs stack, and module-
    // level handles would let one tab's cancel abort another tab's run.
    // Each run mints a fresh controller; the matching cancel action aborts
    // it, which stops the provider request (and billing) instead of just
    // discarding the result.
    let analyzeAbort: AbortController | null = null;
    let refineAbort: AbortController | null = null;
    let chatAbort: AbortController | null = null;
    // Checkpoint handles for the in-flight analyze/resume. They live out here
    // (beside the abort handles) because cancel() has to flush a terminal
    // "cancelled" outcome from outside the run's own scope.
    let analyzeWriter: CheckpointWriter | null = null;
    let analyzeCheckpointPayload:
      | ((outcome: CheckpointOutcome | null) => GeneratorCheckpointV2)
      | null = null;
    /** Final answer streamed so far, kept so a run that dies mid-answer can
     *  persist what it had written. */
    let analyzePartialText = "";
    /** Which follow-up round owns the terminal path. cancelRefine() frees the
     *  UI immediately, so the user can send a new follow-up while the aborted
     *  one's promise is still unwinding — only the newest round may write
     *  terminal state or touch a checkpoint. */
    let refineSeq = 0;

    /** Each activity entry either appends (new id) or replaces an earlier entry
     *  (same id — used when a tool_use is later completed by its tool_result,
     *  carrying duration and output). The most recent entry doubles as the
     *  transient stepLabel for compact displays. Shared by analyze and refine:
     *  both stream into the same activityLog, one run at a time. */
    const onRunActivity = (entry: ActivityEntry) => {
      set((s) => {
        const i = s.activityLog.findIndex((e) => e.id === entry.id);
        const next = s.activityLog.slice();
        if (i >= 0) {
          next[i] = { ...next[i], ...entry };
        } else {
          next.push(entry);
        }
        return { activityLog: next, stepLabel: entryToLabel(entry) };
      });
    };

    /** Terminal handling shared by analyze() and resumeAnalyze(): map the
     *  batch, branch on the two "nothing usable came back" shapes, and on
     *  success move to review, persist the draft, then drop the checkpoint. */
    const settleAnalyzeRun = async (args: {
      runId: string;
      result: RunResult;
      existingCaseTitles: { id: number; title: string }[];
      planName: string | null;
      suiteName: string | null;
      /** The budget this attempt actually ran under — the surface's, or the
       *  smaller grant a resume runs on. Named in the failure copy, so it has to
       *  be the live one rather than the table's. */
      budget: RunBudget;
      writer: CheckpointWriter;
      buildPayload: (outcome: CheckpointOutcome | null) => GeneratorCheckpointV2;
    }): Promise<void> => {
      const { result, writer, buildPayload } = args;
      const cases: ReviewedCase[] = result.batch.cases.map((c) => ({
        ...c,
        uid: uid(),
        decision: "keep",
        similarMatches: findSimilarCases(c.title, args.existingCaseTitles),
      }));
      const bugs: ReviewedBug[] = result.batch.bugs.map((b) => ({
        ...b,
        uid: uid(),
        decision: "keep",
      }));
      // If the user cancelled while the model was running, don't drop them
      // into review — the cancel() action already moved us back to input.
      if (get().phase !== "analyzing") return;

      // A loop that burned its whole budget still calling tools never reached
      // the point of writing an answer — that's continuable, unlike a model
      // that genuinely found nothing, so it gets its own copy and a resume.
      if (!result.ok && result.reason === "step_cap") {
        const outcome: CheckpointOutcome = {
          at: new Date().toISOString(),
          kind: "step_cap",
          ...(result.limit ? { limit: result.limit } : {}),
        };
        const payload = buildPayload(outcome);
        set({
          phase: "error",
          error: `The run spent ${budgetSpentPhrase(result.limit, args.budget, formatTokens)} reading the codebase before it could write the final test-case batch. Resume adds ~${formatTokens(RESUME_TOPUP_TOKENS)} more tokens and asks the model to finish with what it has already read.`,
          errorPhase: "analyze",
          stepLabel: "",
          resumable: resumableFrom(payload, outcome),
        });
        await writer.flush(payload);
        notifyHistoryUpdated(args.runId);
        return;
      }

      // An empty batch is a dead-end: dropping into a blank review reads as
      // "nothing happened" and is the silent-failure users hit with custom
      // connectors. Surface it as a classified error with WHY-specific
      // guidance instead. tryAgain() keeps the spec, so it's a one-click fix.
      if (cases.length === 0 && bugs.length === 0) {
        const why = !result.ok
          ? emptyAnswerCause(
              result.reason === "schema_violation" ? "schema_violation" : "empty",
              result.finishReason,
            )
          : "The model ran but produced no test cases or bugs for this spec.";
        // `resumable` means "a checkpoint exists", not "a resume is on offer":
        // the render sites ask `canOfferResume` for that, and gating this field
        // on it instead is what made a checkpoint nobody could resume also one
        // nobody could DELETE. It's the handle Discard hangs off, and the
        // handle the next run supersedes the row by.
        //
        // Whether it IS on offer now turns on what the attempt banked. "The run
        // COMPLETED, so there's no partial work to continue" — the reasoning
        // this used to carry — describes a model that answered nothing on step
        // one. It is the wrong description of a run that spent 22 steps and
        // 1.7M tokens reading the codebase and then failed only at turning that
        // into a batch: the transcript is the work, and replaying it with the
        // finish-now nudge is the cheap recovery. `canOfferResume` draws that
        // line; the copy below follows it so we never tell a user to re-run
        // work they can continue.
        const emptyOutcome: CheckpointOutcome = {
          at: new Date().toISOString(),
          // Record what actually happened rather than flattening both to
          // "empty" — the two get different unavailable-reason copy, and a
          // salvage failure is not a silent model.
          kind:
            !result.ok && result.reason === "schema_violation"
              ? "schema_violation"
              : "empty",
          // Persisted so a checkpoint reopened from History still knows WHY,
          // and so the next occurrence of this failure names its own cause
          // instead of being diagnosed by inference a second time.
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          // What the failed attempt's requests asked for — the number the
          // truncation-resume gate compares against the model's ceiling.
          ...(result.outputCap !== undefined
            ? { outputCap: result.outputCap }
            : {}),
        };
        const emptyPayload = buildPayload(emptyOutcome);
        const emptyResumable = resumableFrom(emptyPayload, emptyOutcome);
        const canContinue = canOfferResume(
          emptyOutcome,
          emptyOutcome.message ?? null,
          emptyResumable,
        );
        // A truncated answer resumes differently from a wandering one — it
        // retries the answer at the model's output CEILING with a be-compact
        // nudge (resumeBudget) — so the offer has to say that, not "write the
        // batch from what it has", which is the same request that just failed.
        const resumeSuffix =
          result.finishReason === "length"
            ? `It had already read the codebase over ${emptyResumable.stepsUsed} step${emptyResumable.stepsUsed === 1 ? "" : "s"} — resuming replays that work and retries the answer with a raised output-token limit.`
            : `It had already read the codebase over ${emptyResumable.stepsUsed} step${emptyResumable.stepsUsed === 1 ? "" : "s"} before that, so resuming asks it to write the batch from what it has instead of paying for the run again.`;
        set({
          phase: "error",
          error: canContinue
            ? `No test cases generated. ${why} ${resumeSuffix}`
            : `No test cases generated. ${why}`,
          errorPhase: "analyze",
          stepLabel: "",
          resumable: emptyResumable,
        });
        await writer.flush(emptyPayload);
        notifyHistoryUpdated(args.runId);
        return;
      }

      set({
        phase: "review",
        cases: reconcileAutoOutcomes(cases, bugs),
        bugs,
        rawText: result.rawText,
        durationMs: result.durationMs,
        stepLabel: "",
        // Seed display names from the resolved target context so the tab
        // title can render "<Plan> · <Suite>" without an extra ADO fetch.
        planName: args.planName,
        suiteName: args.suiteName,
      });

      // Persist a draft snapshot as soon as we reach review so a closed
      // window or restart doesn't lose the generated cases. The publish
      // path later upserts on the same id with status=published. We embed
      // the full draft payload (cases, bugs, spec, mode) so the history
      // pane's "Open draft" action can fully restore review state.
      try {
        const s = get();
        const draftRun: GenerationRun = {
          id: args.runId,
          timestamp: newTimestamp(),
          planId: s.planId,
          planName: args.planName,
          suiteId: s.suiteId,
          suiteName: args.suiteName,
          suiteType: s.targetSuiteType,
          mode: describeGeneration(s.coverage, s.suggestBugs),
          specExcerpt: specExcerpt(s.requirements ?? ""),
          cases: s.cases.map((c) => ({
            title: c.title,
            adoId: null,
            webUrl: null,
          })),
          bugs: s.bugs.map((b) => ({
            title: b.title,
            severity: b.severity,
            adoId: null,
            webUrl: null,
          })),
          publishLog: [],
          status: "draft",
          draftPayload: {
            requirements: s.requirements,
            changesets: s.changesets,
            coverage: s.coverage,
            suggestBugs: s.suggestBugs,
            overrideModelId: s.overrideModelId,
            cases: s.cases,
            bugs: s.bugs,
            rawText: s.rawText,
            planId: s.planId,
            planName: args.planName,
            suiteId: s.suiteId,
            suiteName: args.suiteName,
            targetSuiteType: s.targetSuiteType,
            targetRequirementId: s.targetRequirementId,
            refineRounds: s.refineRounds,
            refineUndoSnapshot: s.refineUndoSnapshot,
            attachments: s.attachments,
          },
        };
        // Awaited (not fire-and-forget) so the draft is on disk before the
        // user can reload — otherwise a reload right after generating races
        // the write, getRun returns null on restore, and the tab snaps back
        // to the input form ("refresh resets to input").
        await saveRun(draftRun);
      } catch {
        // Persistence is best-effort.
      }
      // Only AFTER the draft landed: a crash between the two must leave the
      // checkpoint standing, never a window where neither copy exists.
      await writer.delete();
      set({ resumable: null });
      notifyHistoryUpdated(args.runId);
    };

    /** May this round still apply its result?
     *
     *  `refineSeq` alone isn't enough. It only covers a NEWER round taking the
     *  slot; it says nothing about the user walking away from the draft while
     *  this one was still unwinding — New session, Back to input, re-analyze,
     *  Publish. Without the phase + runId checks a late round drops the old
     *  draft's cases, refine history and undo snapshot into whatever session is
     *  on screen now (a re-analyze even reuses the runId, so runId alone
     *  wouldn't catch it either). settleAnalyzeRun guards on phase for exactly
     *  this reason. */
    const refineRoundIsCurrent = (
      seq: number,
      sessionRunId: string | null,
    ): boolean => {
      if (seq !== refineSeq) return false;
      const s = get();
      return s.phase === "review" && s.runId === sessionRunId;
    };

    /** A round that can't apply its result must not leave a resume point
     *  behind either. Nothing points at its row once it loses the slot, and
     *  probeRefineCheckpoint treats a row with no terminal outcome as an
     *  interrupted round — so an orphan would resurface later offering to
     *  overwrite a newer draft with a two-generations-old one. Per-round row
     *  ids are what make this safe: deleting here can only ever touch this
     *  round's own row, never the live one's. */
    const abandonRefineRound = async (
      cp: RefineCheckpointCtx | null,
    ): Promise<void> => {
      await cp?.writer.delete();
    };

    /** Terminal handling for a follow-up that RESOLVED — shared by refine()
     *  and resumeRefine(). Mirrors settleAnalyzeRun: branch on the two "nothing
     *  usable came back" shapes, and on success swap the draft, then drop the
     *  checkpoint. */
    const settleRefineRun = async (args: {
      seq: number;
      /** The draft this round belongs to; null when it couldn't be
       *  checkpointed. Compared against the live runId, see above. */
      sessionRunId: string | null;
      /** True when this attempt continued an earlier one, so its history entry
       *  replaces that attempt's rather than stacking beside it. */
      resumed: boolean;
      result: RunResult;
      round: RefineRoundMeta;
      /** The draft as it stood when this attempt started: the undo point, and
       *  the basis for carrying similarity / verdicts / update-bindings
       *  forward onto the revised batch. */
      snapshot: { cases: ReviewedCase[]; bugs: ReviewedBug[]; rawText: string };
      /** The budget this attempt ran under — see settleAnalyzeRun. */
      budget: RunBudget;
      /** Null only when the round couldn't be checkpointed (no session runId to
       *  tie a row to) — it then behaves exactly as follow-ups did before
       *  checkpointing existed: no resume offered, draft handling unchanged. */
      cp: RefineCheckpointCtx | null;
    }): Promise<void> => {
      const { result, round, snapshot, cp } = args;
      if (!refineRoundIsCurrent(args.seq, args.sessionRunId)) {
        await abandonRefineRound(cp);
        return;
      }

      // Budget burned mid-tool-loop: the model never reached the point of
      // writing the revised draft, so this is continuable — unlike an answer
      // that came back unusable, where resuming the transcript just re-fails.
      if (!result.ok && result.reason === "step_cap") {
        const outcome: CheckpointOutcome = {
          at: new Date().toISOString(),
          kind: "step_cap",
          ...(result.limit ? { limit: result.limit } : {}),
        };
        const spent = budgetSpentPhrase(result.limit, args.budget, formatTokens);
        const payload = cp?.buildPayload(outcome) ?? null;
        set((curr) => ({
          isRefining: false,
          stepLabel: "",
          refineError: payload
            ? `This follow-up spent ${spent} before it could write the revised draft. Your draft is unchanged — resuming adds ~${formatTokens(RESUME_TOPUP_TOKENS)} more tokens and asks the model to finish with what it has already read.`
            : `This follow-up spent ${spent} before it could write the revised draft. Your draft is unchanged — try again with a narrower instruction.`,
          refineResumable: payload ? refineResumableFrom(payload, outcome) : null,
          refineRounds: recordRound(
            curr.refineRounds,
            unchangedRound(
              round,
              curr.activityLog,
              "failed",
              "Ran out of steps before writing the revised draft.",
            ),
            args.resumed,
            curr.refineSpend,
          ),
        }));
        if (cp && payload) await cp.writer.flush(payload);
        schedulePersistDraft();
        return;
      }

      // Nothing structured came back — better to keep the user's existing batch
      // than to wipe it for an empty response. Whether that's continuable is
      // the same question analyze answers above: a round that answered nothing
      // having read nothing is a dead end, but one that spent real steps in the
      // codebase first only failed the last hop, and its transcript is worth
      // more than the row it sits in. Keep the checkpoint in that case; drop it
      // in the other, so a useless row doesn't linger.
      if (result.batch.cases.length === 0 && result.batch.bugs.length === 0) {
        const outcome: CheckpointOutcome = {
          at: new Date().toISOString(),
          kind:
            !result.ok && result.reason === "schema_violation"
              ? "schema_violation"
              : "empty",
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          ...(result.outputCap !== undefined
            ? { outputCap: result.outputCap }
            : {}),
        };
        const payload = cp?.buildPayload(outcome) ?? null;
        const resumable = payload
          ? refineResumableFrom(payload, outcome)
          : null;
        const canContinue =
          !!resumable &&
          canOfferResume(outcome, outcome.message ?? null, resumable);
        set((curr) => ({
          isRefining: false,
          stepLabel: "",
          refineError: canContinue
            ? "The model returned an empty refine result — your previous draft is unchanged. It had already read the codebase, so resuming asks it to write the revised draft from what it has."
            : "The model returned an empty refine result — your previous draft is unchanged. Try a more specific instruction.",
          refineResumable: canContinue ? resumable : null,
          refineRounds: recordRound(
            curr.refineRounds,
            unchangedRound(round, curr.activityLog, "empty", null),
            args.resumed,
            curr.refineSpend,
          ),
        }));
        if (canContinue && cp && payload) await cp.writer.flush(payload);
        else await cp?.writer.delete();
        schedulePersistDraft();
        return;
      }

      // Carry forward analysis the refine didn't invalidate. Similarity is
      // title-based, so a case the refine kept titled the same keeps its
      // "similar to #X" matches. The confidence verdict and the reviewer's
      // chosen outcome are CONTENT-based, so they only survive when the case is
      // unchanged (same steps + description) — a genuinely edited case gets a
      // clean slate so a stale score can't mislead. New/renamed cases start
      // empty. This is why undo no longer has to "bring back" similarity /
      // confidence for cases the refine never touched.
      const normTitle = (t: string) => t.trim().toLowerCase();
      const prevByTitle = new Map<string, ReviewedCase>();
      for (const pc of snapshot.cases) prevByTitle.set(normTitle(pc.title), pc);
      const nextCases: ReviewedCase[] = result.batch.cases.map((c) => {
        const prev = prevByTitle.get(normTitle(c.title));
        const contentUnchanged =
          !!prev &&
          JSON.stringify(prev.steps) === JSON.stringify(c.steps) &&
          (prev.description ?? "") === (c.description ?? "");
        return {
          ...c,
          uid: uid(),
          decision: "keep" as const,
          similarMatches: prev ? prev.similarMatches : [],
          // Carry the reviewer's "update existing case #N" binding forward on a
          // title match — it's an ADO-case identity, NOT tied to the draft body,
          // so gate on `prev` (title), not `contentUnchanged`. Without this a
          // refine silently drops the binding and publish CREATES a duplicate
          // work item instead of updating the case the reviewer chose.
          ...(prev?.updateTargetCaseId != null
            ? { updateTargetCaseId: prev.updateTargetCaseId }
            : {}),
          ...(contentUnchanged && prev?.verdict ? { verdict: prev.verdict } : {}),
          ...(contentUnchanged && prev?.desiredOutcome
            ? {
                desiredOutcome: prev.desiredOutcome,
                outcomeAuto: prev.outcomeAuto,
              }
            : {}),
        };
      });
      const nextBugs: ReviewedBug[] = result.batch.bugs.map((b) => ({
        ...b,
        uid: uid(),
        decision: "keep",
      }));

      set((curr) => ({
        isRefining: false,
        cases: reconcileAutoOutcomes(nextCases, nextBugs),
        bugs: nextBugs,
        rawText: result.rawText,
        stepLabel: "",
        refineUndoSnapshot: snapshot,
        refineResumable: null,
        // Record the prompt in history (newest first, dedup'd, capped).
        refineHistory: [
          round.instruction,
          ...curr.refineHistory.filter((p) => p !== round.instruction),
        ].slice(0, REFINE_HISTORY_MAX),
        // And record the structured round so the user can later read back the
        // thinking process behind why the draft looks like this. Survives a
        // window close via the draft autosave path.
        refineRounds: recordRound(
          curr.refineRounds,
          {
            timestamp: round.startedAt,
            instruction: round.instruction,
            activityLog: curr.activityLog,
            beforeCases: round.beforeCases,
            afterCases: nextCases.length,
            beforeBugs: round.beforeBugs,
            afterBugs: nextBugs.length,
            outcome: "ok",
            // A round that only landed on the second attempt would otherwise
            // keep the first attempt's error text next to an "ok" badge.
            error: null,
          },
          args.resumed,
          curr.refineSpend,
        ),
      }));
      // Arms the debounced draft write. Unlike settleAnalyzeRun — which awaits
      // its saveRun before dropping the checkpoint — this can't await a save
      // that hasn't fired yet, so there is a sub-100ms window where a crash
      // loses both the refined draft and the resume point. Accepted: the round
      // is already applied in memory, and holding the row longer would mean
      // offering a Resume for work that's on screen.
      schedulePersistDraft();
      await cp?.writer.delete();
    };

    /** Terminal handling for a follow-up that THREW — a user abort or a real
     *  failure. Both keep their checkpoint and offer a resume. `cp` is null
     *  only for a failure BEFORE the run reached the provider (prompt assembly,
     *  keys, work-item fetch) — nothing was spent, so nothing is left behind. */
    const settleRefineFailure = async (args: {
      seq: number;
      sessionRunId: string | null;
      resumed: boolean;
      round: RefineRoundMeta;
      error: unknown;
      cp: RefineCheckpointCtx | null;
    }): Promise<void> => {
      const { round, cp } = args;
      if (!refineRoundIsCurrent(args.seq, args.sessionRunId)) {
        await abandonRefineRound(cp);
        return;
      }
      const cancelled = isCancelledError(args.error);
      // Refine errors stay inside the review phase — wiping the user back to
      // the input screen would lose the draft they were trying to refine.
      if (!cancelled) console.error("[generator] refine failed:", args.error);
      const errorText = cancelled ? "" : errToString(args.error);
      const outcome: CheckpointOutcome = cancelled
        ? { at: new Date().toISOString(), kind: "cancelled" }
        : {
            at: new Date().toISOString(),
            kind: "error",
            errorKind: classifyForResume(args.error).kind,
            message: errorText,
          };
      // Built BEFORE the flush and from the run's own scope, so a tab closed
      // mid-refine (disposeStore cancels, then drops the store) still leaves a
      // resume point behind.
      const payload = cp?.buildPayload(outcome) ?? null;
      set((curr) => ({
        isRefining: false,
        stepLabel: "",
        // Cancelled runs don't leave a banner — the user asked to abort, so
        // showing them an error after they pressed ESC is hostile UX. The
        // resume card below is the affordance that replaces it.
        refineError: cancelled ? null : errorText,
        refineResumable: payload ? refineResumableFrom(payload, outcome) : null,
        refineRounds: recordRound(
          curr.refineRounds,
          unchangedRound(
            round,
            curr.activityLog,
            cancelled ? "empty" : "failed",
            cancelled ? "Cancelled before completion." : errorText,
          ),
          args.resumed,
          curr.refineSpend,
        ),
      }));
      if (cp && payload) await cp.writer.flush(payload);
      schedulePersistDraft();
    };

    return ({
  ...initialState,

  setRequirements: (s) => set({ requirements: s }),
  setChangesets: (s) => set({ changesets: s }),
  setCoverage: (c) => set({ coverage: c }),
  setSuggestBugs: (v) => set({ suggestBugs: v }),
  // Setting a target wipes the cached names — they'll be re-resolved at
  // analyze() time (or restored by loadDraft) so the tab title stays in
  // sync with whichever plan/suite is actually selected.
  setTarget: (planId, suiteId) =>
    set({
      planId,
      suiteId,
      planName: null,
      suiteName: null,
      // Clear the resolved type too — keeping a stale one would badge the new
      // target as requirement-based, or let publish() gate on the old suite.
      targetSuiteType: null,
      targetRequirementId: null,
      targetRequirement: null,
    }),
  setPlanSuiteNames: (planName, suiteName) => {
    set({ planName, suiteName });
    schedulePersistDraft();
  },
  setTagSourceBranch: (v) => set({ tagSourceBranch: v }),
  toggleRepoScope: (repoId) =>
    set((s) => ({ repoScope: toggleRepoScope(s.repoScope, getRepos(), repoId) })),
  setOverrideModelId: (id) => set({ overrideModelId: id }),
  addAttachment: (path, content) =>
    set((s) => {
      // Path-keyed dedup for the text-only flow — callers using this entry
      // point pass a stable filename for the same file (e.g. a Read tool
      // result), so collapse re-adds rather than stacking duplicates.
      if (s.attachments.some((a) => a.path === path && a.kind === "text")) {
        return s;
      }
      return {
        attachments: [
          ...s.attachments,
          {
            id: newAttachmentId(),
            path,
            content,
            kind: "text",
            sizeBytes: content.length,
          },
        ],
      };
    }),
  addRichAttachment: (attachment) =>
    set((s) => {
      // Dedup by id — two attachments with identical filenames keep their
      // own slots. Without this, two Windows screenshots pasted in a row
      // (both named "Screenshot 2026-05-23 12.34.56.png") would silently
      // collapse into one.
      const without = s.attachments.filter((a) => a.id !== attachment.id);
      return { attachments: [...without, attachment] };
    }),
  removeAttachment: (id) =>
    set((s) => ({
      attachments: s.attachments.filter((a) => a.id !== id),
    })),
  addWorkItem: (item) =>
    set((s) =>
      s.attachedWorkItems.some((w) => w.id === item.id)
        ? s
        : { attachedWorkItems: [...s.attachedWorkItems, item] },
    ),
  removeWorkItem: (id) =>
    set((s) => ({
      attachedWorkItems: s.attachedWorkItems.filter((w) => w.id !== id),
    })),
  clearWorkItems: () => set({ attachedWorkItems: [] }),

  analyze: async () => {
    // Re-analyzing replaces the draft a follow-up is refining, so stop it —
    // otherwise it keeps streaming (and billing) against a draft that's about
    // to stop existing. Its terminal handler then finds a session it doesn't
    // belong to and drops its row instead of writing into the new run.
    get().cancelRefine();
    const { requirements, changesets, attachments, attachedWorkItems, planId, suiteId, coverage, suggestBugs, repoScope, overrideModelId } = get();
    if (!requirements.trim()) {
      set({
        phase: "error",
        error: "Paste requirements first.",
        errorPhase: "validation",
      });
      return;
    }
    // Decide runId reuse from the PRE-clean-slate state. Once anything was
    // published, re-analyzing must mint a FRESH id so the saveRun on reaching
    // review can't overwrite the published history row in place (status:"draft",
    // empty publishLog) and destroy its ADO ids / web URLs. The clean-slate
    // set() just below empties publishLog, so this decision can't be deferred
    // until after it — reading get().publishLog there always sees [].
    const reuseRunId = (() => {
      const s = get();
      return s.runId && !s.publishLog.some((l) => l.status === "ok")
        ? s.runId
        : null;
    })();
    // A published run's checkpoint can never be reached again once we mint a
    // fresh id, so drop it rather than leaving an orphan row behind.
    const supersededRunId = (() => {
      const s = get();
      return !reuseRunId && s.runId && s.resumable ? s.runId : null;
    })();
    if (supersededRunId) void deleteCheckpoint(supersededRunId).catch(() => {});
    // A fresh analyze replaces the whole draft, so an unfinished follow-up
    // against the OLD draft can never be resumed meaningfully — drop its row
    // rather than leave it to be adopted when this run reaches review.
    const supersededRefineId = get().refineResumable?.runId ?? null;
    if (supersededRefineId) {
      void deleteCheckpoint(supersededRefineId).catch(() => {});
    }
    const runId = reuseRunId ?? newRunId();
    set({
      phase: "analyzing",
      stepLabel: "Reading suite…",
      activityLog: [],
      error: null,
      errorPhase: null,
      // Minted up front (not at the review transition) so a run that dies
      // mid-flight still has an id its checkpoint and tab can be keyed by.
      runId,
      stepsUsed: 0,
      stepCap: SURFACE_STEP_CAPS.generator,
      tokensUsed: 0,
      tokenBudget: SURFACE_TOKEN_BUDGETS.generator,
      tokensInput: null,
      tokensCached: null,
      peakPromptTokens: null,
      analyzeStartedAt: Date.now(),
      resumable: null,
      // Clean-slate the prior run's RESULT state (mirrors tryAgain). When
      // analyze is reached from a reopened published/draft run via the input
      // breadcrumb, goToInput preserves everything — without this, the new
      // generation inherits the previous run's publishLog (false "already
      // published" banner, stale "done" breadcrumb) and refine history.
      cases: [],
      bugs: [],
      rawText: "",
      publishLog: [],
      durationMs: null,
      refineRounds: [],
      refineHistory: [],
      // A fresh analyze invalidates any prior refine snapshot — there's no
      // previous batch to restore once we kick a brand new run.
      refineUndoSnapshot: null,
      refineResumable: null,
    });

    // Minted before the prep awaits so a cancel during them already-aborts
    // the signal — the model call then rejects immediately instead of
    // running (and billing) to completion behind the discarded result.
    const analyzeAc = new AbortController();
    analyzeAbort = analyzeAc;
    // Only clear our own handle — a cancelled run's cleanup can land after the
    // user already started a fresh run with a new controller.
    const releaseAnalyzeClaim = () => {
      if (analyzeAbort === analyzeAc) analyzeAbort = null;
    };
    // No checkpoint exists until the prompt is assembled — a failure before
    // that point spent nothing, so there's nothing to resume.
    analyzeWriter = null;
    analyzeCheckpointPayload = null;
    analyzePartialText = "";

    let existingCaseTitles: { id: number; title: string }[] = [];
    let existingCases: {
      id: number;
      title: string;
      steps: { action: string; expected: string }[];
    }[] = [];
    let targetContext: TargetContext | null = null;
    let relatedCases: RelatedCase[] = [];
    if (planId && suiteId) {
      try {
        existingCaseTitles = (await listSuiteCases(planId, suiteId)).map(
          (c) => ({ id: c.id, title: c.title }),
        );
      } catch (e) {
        // Non-fatal — duplicate detection just won't fire.
        console.warn("[generator] couldn't load existing cases:", e);
      }
      // Pull full steps for the existing cases (capped) so the analyst reads
      // prior coverage in detail and writes complementary, style-matched
      // cases — not just a title-level dedup. Best-effort + parallel; a
      // failed fetch falls back to title-only for that case.
      if (existingCaseTitles.length > 0) {
        set({ stepLabel: "Reading existing cases…" });
        const subset = existingCaseTitles.slice(0, 20);
        existingCases = await Promise.all(
          subset.map(async (t) => {
            try {
              const full = await getCase(t.id);
              return {
                id: full.id,
                title: full.title,
                steps: full.steps.map((s) => ({
                  action: s.action,
                  expected: s.expected,
                })),
              };
            } catch {
              return { id: t.id, title: t.title, steps: [] };
            }
          }),
        );
        // Keep the remaining (uncapped) titles available for dedup context.
        for (const t of existingCaseTitles.slice(20)) {
          existingCases.push({ id: t.id, title: t.title, steps: [] });
        }
      }
      try {
        targetContext = await buildTargetContext(planId, suiteId);
        // Mirror the resolved suite type onto the session so the review UI can
        // badge it and publish() can gate on it without a second lookup.
        set({
          targetSuiteType: targetContext.suiteType ?? null,
          // From the suite ref, not the fetched body — a failed requirement
          // fetch shouldn't lose which work item the suite is bound to.
          targetRequirementId:
            targetContext.requirementId ?? targetContext.requirement?.id ?? null,
          targetRequirement: targetContext.requirement ?? null,
        });
        // Refuse a target Azure DevOps will never accept cases into, BEFORE
        // spending a multi-minute agentic run on it. publish() has the same
        // guard, but reaching it means the user already paid for the tokens
        // and waited — which is the exact failure this whole feature exists
        // to prevent. This is the backstop for every entry point into
        // analyze(), including ones added later.
        const targetCaps = suiteCapabilities({
          suiteType: targetContext.suiteType,
        });
        if (!targetCaps.canAddCases) {
          // Release the slot like every other exit from analyze() does. A
          // pinned analyzeAbort makes resumeAnalyze a silent no-op for the
          // life of this store — see the regression test in
          // useGenerationSession.checkpoint.test.ts.
          releaseAnalyzeClaim();
          set({
            phase: "error",
            errorPhase: "analyze",
            stepLabel: "",
            error:
              suiteRestriction({ suiteType: targetContext.suiteType }, "addCases") ??
              "This suite doesn't accept new test cases.",
          });
          return;
        }
      } catch (e) {
        // Non-fatal — the run still works, the prompt just lacks the chip.
        console.warn("[generator] couldn't build target context:", e);
      }
      try {
        // Pattern-awareness context: case titles from neighboring suites.
        // Strictly supplementary — see qaAnalystPrompt.ts for the priority
        // ordering the analyst is told to respect.
        relatedCases = await fetchRelatedCaseTitles(planId, suiteId);
      } catch (e) {
        // Non-fatal — the analyst just won't see related-case context.
        console.warn("[generator] couldn't load related cases:", e);
      }
    }

    const chat = useChatStore.getState();
    const keys = await chat.ensureApiKeys();
    // Per-generation override wins over the global default. Resetting on
    // startNew keeps each new run anchored to the latest default unless the
    // user explicitly picks a model again.
    const modelId = overrideModelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const { blocks: bpBlocks } = await loadBestPracticeBlocks(
      prefs.bestPracticeFiles,
      { visionCapable: supportsVision(modelId) },
    );
    // #mentioned work items → read-only context blocks, merged with
    // best-practices. Fetched here (at analyze time) so the chips only hold
    // lightweight refs until they're actually needed.
    const bugBlocks =
      attachedWorkItems.length > 0
        ? await bugsToContextBlocks(attachedWorkItems.map((w) => w.id))
        : [];
    const contextBlocks = [...bpBlocks, ...bugBlocks];

    // Every configured repo unless the user narrowed this run — the app can't
    // know which repos a spec touches, so narrowing is their explicit act.
    const repos = prefs.codeSearchEnabled
      ? scopedRepos(prefs.repos, repoScope)
      : [];
    const customInstructions = prefs.customInstructions || undefined;
    const prepared = prepareQaAnalystRun({
      requirements,
      changesets,
      attachments,
      existingCaseTitles,
      existingCases,
      relatedCases,
      targetContext,
      coverage,
      suggestBugs,
      keys,
      modelId,
      repos,
      contextBlocks,
      customInstructions,
    });

    // A cancel during the prefetch flipped us back to input and found no
    // writer to flush — so bail before creating one. Writing the row here
    // would leave a cancelled run with an inputs-only checkpoint (lastOutcome
    // null) that survives restart and reads as resumable, for a run that never
    // reached the provider and spent nothing.
    if (get().phase !== "analyzing") {
      releaseAnalyzeClaim();
      return;
    }

    // Everything above is recoverable input; from here on the run costs money,
    // so the resume point goes to disk BEFORE the provider is touched.
    const createdAt = new Date().toISOString();
    const writer = createCheckpointWriter({
      runId,
      surface: "generator",
      cwd: null,
      createdAt,
    });
    analyzeWriter = writer;
    const basePayload: GeneratorCheckpointV2 = {
      v: 2,
      surface: "generator",
      runId,
      createdAt,
      modelId,
      repos,
      customInstructions,
      form: {
        requirements,
        changesets,
        attachments,
        attachedWorkItems,
        planId,
        planName: targetContext?.planName ?? null,
        suiteId,
        suiteName: targetContext?.suiteName ?? null,
        targetSuiteType: targetContext?.suiteType ?? null,
        // Off the suite ref, like the session mirror above — a checkpoint
        // written after a failed requirement fetch must still resume knowing
        // which work item the suite is bound to.
        targetRequirementId:
          targetContext?.requirementId ?? targetContext?.requirement?.id ?? null,
        coverage,
        suggestBugs,
        tagSourceBranch: get().tagSourceBranch,
        // The scope as the user set it, NOT the resolved `repos` above: a
        // checkpoint loaded back into the form has to re-render the chips, and
        // an all-repos run must stay all-repos even if the registry grew.
        repoScope,
        overrideModelId,
      },
      prepared: {
        userPrompt: prepared.userPrompt,
        attachments: toCheckpointAttachments(prepared.attachments),
      },
      activity: [],
      transcript: null,
      lastOutcome: null,
    };
    let transcript: TranscriptCheckpoint | null = null;
    const buildPayload = (
      outcome: CheckpointOutcome | null,
    ): GeneratorCheckpointV2 => ({
      ...basePayload,
      activity: get().activityLog,
      transcript: withPartialText(transcript, analyzePartialText),
      lastOutcome: outcome,
    });
    analyzeCheckpointPayload = buildPayload;
    await writer.flush(basePayload);

    try {
      set({ stepLabel: "Calling model…" });
      const result: RunResult = await executeQaAnalystRun(prepared, {
        keys,
        local: localProviderConfig(prefs),
        onActivity: onRunActivity,
        onCheckpoint: (cp) => {
          // A step that finishes in the same tick as cancel()/settle would
          // otherwise queue a live-run payload on top of the terminal outcome
          // they just wrote. Same phase signal the catch below guards on.
          if (get().phase !== "analyzing") return;
          set({
            stepsUsed: cp.stepsUsed,
            tokensUsed: stepSpend(cp.usage),
            // Absent (not 0) when no step reported it — the accumulator only
            // writes a usage field a provider actually sent.
            tokensInput: cp.usage.inputTokens ?? null,
            tokensCached: cp.usage.cacheReadTokens ?? null,
          });
          transcript = toTranscript(cp, null);
          writer.save(buildPayload(null));
        },
        onContextSignal: (s) => set(peakFrom(s.promptTokens)),
        onText: (delta) => {
          if (!analyzePartialText) set({ stepLabel: "Writing output…" });
          analyzePartialText += delta;
        },
        signal: analyzeAc.signal,
      });
      await settleAnalyzeRun({
        runId,
        result,
        existingCaseTitles,
        planName: targetContext?.planName ?? null,
        suiteName: targetContext?.suiteName ?? null,
        budget: GENERATOR_BUDGET,
        writer,
        buildPayload,
      });
    } catch (e) {
      // A cancelled run rejects with AbortError after cancel() already moved
      // us back to input — the phase guard swallows it like any late result.
      // (That guard is also what keeps cancel()'s flush the only "cancelled"
      // write: we never reach the flush below on the cancel path.)
      if (get().phase !== "analyzing") return;
      if (isCancelledError(e)) return;
      // Log the raw value too — `[object Object]` in the UI is a dead-end
      // for debugging; keeping the original here lets devtools surface the
      // full shape even when our stringifier had to fall back.
      console.error("[generator] analyze failed:", e);
      const outcome: CheckpointOutcome = {
        at: new Date().toISOString(),
        kind: "error",
        errorKind: classifyForResume(e).kind,
        message: errToString(e),
      };
      const payload = buildPayload(outcome);
      set({
        phase: "error",
        error: errToString(e),
        errorPhase: "analyze",
        stepLabel: "",
        resumable: resumableFrom(payload, outcome),
      });
      await writer.flush(payload);
      notifyHistoryUpdated(runId);
    } finally {
      releaseAnalyzeClaim();
      if (analyzeWriter === writer) {
        analyzeWriter = null;
        analyzeCheckpointPayload = null;
      }
    }
  },

  resumeAnalyze: async () => {
    const start = get();
    if (start.phase !== "input" && start.phase !== "error") return;
    const runId = start.runId;
    if (!runId) return;
    // Claim the analyze slot synchronously — every gate below awaits, so
    // without this a double-click starts two runs on the same checkpoint.
    if (analyzeAbort) return;
    const resumeAc = new AbortController();
    analyzeAbort = resumeAc;
    const releaseClaim = () => {
      if (analyzeAbort === resumeAc) analyzeAbort = null;
    };

    let row: Awaited<ReturnType<typeof getCheckpoint>> = null;
    try {
      row = await getCheckpoint(runId);
    } catch (e) {
      console.warn("[generator] couldn't read the checkpoint:", e);
    }
    if (!row) {
      releaseClaim();
      set({ resumable: null });
      return;
    }
    const payload = row.payload;
    if (payload.surface !== "generator") {
      releaseClaim();
      void deleteCheckpoint(runId).catch(() => {});
      set({ resumable: null });
      return;
    }
    // The transcript is pinned to the model that produced it, so a retired id
    // can't be resumed. Keep the row — the user may still want its inputs.
    if (!isKnownModelId(payload.modelId)) {
      releaseClaim();
      set({
        phase: "error",
        error: `This run used ${payload.modelId}, which is no longer available, so it can't be resumed. Run it again from scratch with a current model.`,
        errorPhase: "analyze",
        stepLabel: "",
        resumable: null,
      });
      return;
    }
    if (!payload.prepared) {
      // It died before the prompt was assembled — nothing model-side was
      // spent, and the form is still in state, so just run it normally.
      releaseClaim();
      await get().analyze();
      return;
    }

    const { cap, tokens, resumeMessages, maxOutputTokens } =
      resumeBudget(payload);
    const base = payload.transcript;
    const baseSteps = base?.stepsUsed ?? 0;
    const baseTokens = stepSpend(base?.usage);

    // Same reasoning as analyze(): the resumed run re-derives the whole draft,
    // so a follow-up against the previous one is unreachable from here.
    const supersededRefineId = get().refineResumable?.runId ?? null;
    if (supersededRefineId) {
      void deleteCheckpoint(supersededRefineId).catch(() => {});
    }

    set({
      phase: "analyzing",
      stepLabel: "Resuming…",
      // Seeded from the checkpoint so the log reads as one continuous run.
      activityLog: payload.activity,
      analyzeStartedAt: Date.now(),
      // Displayed ceilings, not the runner's budgets. Both counters keep
      // climbing cumulatively across resumes, so each readout's ceiling has to
      // be the prior total plus this call's grant. Showing the raw grant is what
      // once made a topped-up resume read "step 27/8"; in the unit that now
      // rations the run it would read "~1.2M / 500k tokens" on a run with plenty
      // of room left.
      stepCap: baseSteps + cap,
      stepsUsed: baseSteps,
      tokenBudget: baseTokens + tokens,
      tokensUsed: baseTokens,
      tokensInput: base?.usage?.inputTokens ?? null,
      tokensCached: base?.usage?.cacheReadTokens ?? null,
      // Not carried across a resume: the checkpoint records what the run SPENT,
      // not how big any one request got, so the peak has to be re-measured from
      // this attempt's own steps rather than invented from the total.
      peakPromptTokens: null,
      error: null,
      errorPhase: null,
      resumable: null,
      cases: [],
      bugs: [],
      rawText: "",
      publishLog: [],
      durationMs: null,
      refineRounds: [],
      refineHistory: [],
      refineUndoSnapshot: null,
      refineResumable: null,
    });

    const writer = createCheckpointWriter({
      runId,
      surface: "generator",
      cwd: null,
      createdAt: payload.createdAt,
    });
    analyzeWriter = writer;
    analyzePartialText = "";
    let transcript: TranscriptCheckpoint | null = base;
    const buildPayload = (
      outcome: CheckpointOutcome | null,
    ): GeneratorCheckpointV2 => ({
      ...payload,
      activity: get().activityLog,
      transcript: withPartialText(transcript, analyzePartialText),
      lastOutcome: outcome,
    });
    analyzeCheckpointPayload = buildPayload;

    const prepared: PreparedAnalystRun = {
      modelId: payload.modelId,
      userPrompt: payload.prepared.userPrompt,
      attachments: payload.prepared.attachments,
      repos: payload.repos,
      customInstructions: payload.customInstructions,
    };

    try {
      const prefs = usePreferencesStore.getState();
      const keys = await useChatStore.getState().ensureApiKeys();
      const result: RunResult = await executeQaAnalystRun(prepared, {
        keys,
        local: localProviderConfig(prefs),
        maxSteps: cap,
        tokenBudget: tokens,
        maxOutputTokens,
        resumeMessages,
        onActivity: onRunActivity,
        onCheckpoint: (cp) => {
          if (get().phase !== "analyzing") return;
          // cp.messages already carries the resumed prefix (the runner
          // prepends it), so only the COUNTERS need the earlier totals added.
          transcript = toTranscript(cp, base);
          set({
            stepsUsed: baseSteps + cp.stepsUsed,
            tokensUsed: baseTokens + stepSpend(cp.usage),
            tokensInput: addReported(
              base?.usage?.inputTokens,
              cp.usage.inputTokens,
            ),
            tokensCached: addReported(
              base?.usage?.cacheReadTokens,
              cp.usage.cacheReadTokens,
            ),
          });
          writer.save(buildPayload(null));
        },
        onContextSignal: (s) => set(peakFrom(s.promptTokens)),
        onText: (delta) => {
          if (!analyzePartialText) set({ stepLabel: "Writing output…" });
          analyzePartialText += delta;
        },
        signal: resumeAc.signal,
      });
      await settleAnalyzeRun({
        runId,
        result,
        // A resume never re-reads the suite, so there are no titles to match
        // against — the draft just loses its "similar to #N" chips.
        existingCaseTitles: [],
        planName: payload.form.planName,
        suiteName: payload.form.suiteName,
        budget: { tokens, steps: cap },
        writer,
        buildPayload,
      });
    } catch (e) {
      if (get().phase !== "analyzing") return;
      if (isCancelledError(e)) return;
      console.error("[generator] resume failed:", e);
      const outcome: CheckpointOutcome = {
        at: new Date().toISOString(),
        kind: "error",
        errorKind: classifyForResume(e).kind,
        message: errToString(e),
      };
      const failed = buildPayload(outcome);
      set({
        phase: "error",
        error: errToString(e),
        errorPhase: "analyze",
        stepLabel: "",
        resumable: resumableFrom(failed, outcome),
      });
      await writer.flush(failed);
      notifyHistoryUpdated(runId);
    } finally {
      releaseClaim();
      if (analyzeWriter === writer) {
        analyzeWriter = null;
        analyzeCheckpointPayload = null;
      }
    }
  },

  loadCheckpoint: (payload, updatedAt) => {
    const form = payload.form;
    set({
      ...initialState,
      phase: "input",
      requirements: form.requirements,
      changesets: form.changesets,
      attachments: form.attachments,
      attachedWorkItems: form.attachedWorkItems,
      planId: form.planId,
      planName: form.planName,
      suiteId: form.suiteId,
      suiteName: form.suiteName,
      targetSuiteType: form.targetSuiteType ?? null,
      targetRequirementId: form.targetRequirementId ?? null,
      coverage: form.coverage,
      suggestBugs: form.suggestBugs,
      tagSourceBranch: form.tagSourceBranch,
      repoScope: form.repoScope ?? null,
      overrideModelId: form.overrideModelId,
      runId: payload.runId,
      activityLog: payload.activity,
      stepsUsed: payload.transcript?.stepsUsed ?? null,
      resumable: {
        stepsUsed: payload.transcript?.stepsUsed ?? 0,
        hasTranscript: hasReplayableTranscript(payload.transcript),
        outputCapRaisable: canRaiseOutputCap(payload.modelId, payload.lastOutcome),
        totalTokens: payload.transcript?.usage?.totalTokens ?? null,
        updatedAt,
        outcome: payload.lastOutcome,
      },
    });
  },

  discardCheckpoint: () => {
    const id = get().runId;
    if (id) {
      void deleteCheckpoint(id)
        .catch(() => {})
        .then(() => notifyHistoryUpdated(id));
    }
    set({ resumable: null });
  },

  cancel: () => {
    const phase = get().phase;
    if (phase === "analyzing") {
      set({ phase: "input", stepLabel: "", error: null, errorPhase: null });
      // Abort AFTER the phase flip so the rejection lands on the guard above.
      analyzeAbort?.abort();
      // …and that guard is why this is the only place a "cancelled" outcome
      // gets written: the run's own catch returns before it can flush.
      const writer = analyzeWriter;
      const buildPayload = analyzeCheckpointPayload;
      if (writer && buildPayload) {
        const outcome: CheckpointOutcome = {
          at: new Date().toISOString(),
          kind: "cancelled",
        };
        const payload = buildPayload(outcome);
        set({ resumable: resumableFrom(payload, outcome) });
        const runId = get().runId;
        // Notify AFTER the flush lands so a History refresh reads the
        // cancelled checkpoint, not the pre-cancel row. This is what makes a
        // tab closed mid-analyze (dispose → cancel) appear in History at all.
        void writer.flush(payload).then(() => notifyHistoryUpdated(runId));
      }
    }
  },

  tryAgain: () => {
    // Surgical reset: only the run-result + phase signals get cleared. Every
    // input-form field (requirements, attachments, plan/suite/mode, code
    // search toggle, model override) is explicitly preserved by NOT being
    // listed here. Past behavior was the same, but spelling it out makes
    // sure a future "clear X here too" never sneaks the spec out from under
    // the user. `resumable` belongs to that preserved set too — clearing it
    // would strand the checkpoint the user still has the option to continue.
    set({
      phase: "input",
      stepLabel: "",
      activityLog: [],
      error: null,
      errorPhase: null,
      cases: [],
      bugs: [],
      rawText: "",
      publishLog: [],
      durationMs: null,
    });
  },

  setCaseDecision: (uid, decision) => {
    set((s) => {
      const nextCases = s.cases.map((c) =>
        c.uid === uid ? { ...c, decision } : c,
      );
      // Cascade skip: when a case flips to "skip", any bug whose parent
      // points at it must also skip — otherwise publish would silently
      // drop the bug with "no parent case to link to". The flip is a soft
      // cascade: re-keeping the parent doesn't re-keep dependent bugs,
      // since the user might have wanted them off independently.
      if (decision === "skip") {
        const skippedIdx = nextCases.findIndex((c) => c.uid === uid);
        if (skippedIdx >= 0) {
          const nextBugs = s.bugs.map((b) =>
            b.linkedDraftCaseIndex === skippedIdx
              ? { ...b, decision: "skip" as const }
              : b,
          );
          return {
            cases: reconcileAutoOutcomes(nextCases, nextBugs),
            bugs: nextBugs,
          };
        }
      }
      return { cases: reconcileAutoOutcomes(nextCases, s.bugs) };
    });
    schedulePersistDraft();
  },
  setBugDecision: (uid, decision) => {
    set((s) => {
      // Guard: a bug can't be "keep" when its parent case is "skip" — the
      // publish path would fail. If the user tries to keep a bug whose
      // parent is gone, leave it as skip until they re-link to a kept case.
      const bug = s.bugs.find((b) => b.uid === uid);
      if (decision === "keep" && bug) {
        const idx = bug.linkedDraftCaseIndex;
        const parent =
          idx != null && idx >= 0 && idx < s.cases.length
            ? s.cases[idx]
            : null;
        if (!parent || parent.decision !== "keep") {
          return {}; // refuse the keep — UI surfaces a "re-link first" hint
        }
      }
      const nextBugs = s.bugs.map((b) =>
        b.uid === uid ? { ...b, decision } : b,
      );
      return { bugs: nextBugs, cases: reconcileAutoOutcomes(s.cases, nextBugs) };
    });
    schedulePersistDraft();
  },
  setBugParent: (bugUid, caseUid) => {
    set((s) => {
      const idx =
        caseUid === null ? null : s.cases.findIndex((c) => c.uid === caseUid);
      if (caseUid !== null && (idx === null || idx < 0)) return {};
      const nextBugs = s.bugs.map((b) =>
        b.uid === bugUid ? { ...b, linkedDraftCaseIndex: idx ?? null } : b,
      );
      return { bugs: nextBugs, cases: reconcileAutoOutcomes(s.cases, nextBugs) };
    });
    schedulePersistDraft();
  },

  restoreCaseContent: (uid, from) => {
    set((s) => {
      const nextCases = s.cases.map((c) =>
        // Keep the live uid, position, and keep/skip choice; restore everything
        // else (title, steps, description, verdict, outcome…) to the snapshot.
        c.uid === uid ? { ...from, uid: c.uid, decision: c.decision } : c,
      );
      // The snapshot may carry a stale auto outcome; reconcile so it agrees with
      // the case's current bug/verdict state instead of resurrecting it blindly.
      return { cases: reconcileAutoOutcomes(nextCases, s.bugs) };
    });
    schedulePersistDraft();
  },
  restoreBugContent: (uid, from) => {
    set((s) => {
      // Restoring can re-point the bug's parent (from.linkedDraftCaseIndex), so
      // recompute auto outcomes against the new bug array.
      const nextBugs = s.bugs.map((b) =>
        b.uid === uid ? { ...from, uid: b.uid, decision: b.decision } : b,
      );
      return { bugs: nextBugs, cases: reconcileAutoOutcomes(s.cases, nextBugs) };
    });
    schedulePersistDraft();
  },
  restoreRemovedCase: (from) => {
    // Idempotent: re-adding is a no-op if it's already back (double-click safe).
    set((s) => {
      if (s.cases.some((c) => c.uid === from.uid)) return {};
      const nextCases = [...s.cases, from];
      return { cases: reconcileAutoOutcomes(nextCases, s.bugs) };
    });
    schedulePersistDraft();
  },
  restoreRemovedBug: (from) => {
    set((s) => {
      if (s.bugs.some((b) => b.uid === from.uid)) return {};
      const nextBugs = [...s.bugs, from];
      return { bugs: nextBugs, cases: reconcileAutoOutcomes(s.cases, nextBugs) };
    });
    schedulePersistDraft();
  },

  setCaseTitle: (uid, title) => {
    set((s) => ({
      cases: s.cases.map((c) => (c.uid === uid ? { ...c, title } : c)),
    }));
    schedulePersistDraft();
  },
  setCaseRationale: (uid, rationale) => {
    set((s) => ({
      cases: s.cases.map((c) => (c.uid === uid ? { ...c, rationale } : c)),
    }));
    schedulePersistDraft();
  },
  setCaseOutcome: (uid, outcome) => {
    set((s) => ({
      cases: s.cases.map((c) =>
        // A manual pick clears the auto flag so a later re-evaluation respects
        // the reviewer's choice instead of overwriting it.
        c.uid === uid
          ? { ...c, desiredOutcome: outcome ?? undefined, outcomeAuto: false }
          : c,
      ),
    }));
    schedulePersistDraft();
  },
  setCaseVerdict: (uid, verdict) => {
    set((s) => {
      const nextCases = s.cases.map((c) =>
        c.uid === uid ? { ...c, verdict } : c,
      );
      // Recompute auto-managed outcomes now that this case has a verdict: a
      // decisive verdict (confident Pass, or any Fail/Blocked) flips the status,
      // unless an attached bug already forced Failed or the reviewer set it by
      // hand. The reviewer can always override afterward (clears outcomeAuto).
      return { cases: reconcileAutoOutcomes(nextCases, s.bugs) };
    });
    schedulePersistDraft();
  },
  setCaseUpdateTarget: (uid, caseId) => {
    set((s) => ({
      cases: s.cases.map((c) =>
        c.uid === uid ? { ...c, updateTargetCaseId: caseId } : c,
      ),
    }));
    schedulePersistDraft();
  },
  // Editing steps invalidates a prior confidence verdict — it was graded
  // against the old steps, and showing a stale "92% pass-ready" after an edit
  // could trick a reviewer into auto-passing a case that no longer matches.
  // Clearing it flips the chip back to "Evaluate" so the score is never stale.
  setCaseStep: (uid, stepIndex, patch) => {
    set((s) => ({
      cases: s.cases.map((c) => {
        if (c.uid !== uid) return c;
        return {
          ...c,
          steps: c.steps.map((st, i) =>
            i === stepIndex ? { ...st, ...patch } : st,
          ),
          verdict: undefined,
        };
      }),
    }));
    schedulePersistDraft();
  },
  addCaseStep: (uid) => {
    set((s) => ({
      cases: s.cases.map((c) =>
        c.uid === uid
          ? {
              ...c,
              steps: [...c.steps, { action: "", expected: "" }],
              verdict: undefined,
            }
          : c,
      ),
    }));
    schedulePersistDraft();
  },
  removeCaseStep: (uid, stepIndex) => {
    set((s) => ({
      cases: s.cases.map((c) => {
        if (c.uid !== uid) return c;
        if (c.steps.length <= 1) return c;
        return {
          ...c,
          steps: c.steps.filter((_, i) => i !== stepIndex),
          verdict: undefined,
        };
      }),
    }));
    schedulePersistDraft();
  },
  setBugTitle: (uid, title) => {
    set((s) => ({
      bugs: s.bugs.map((b) => (b.uid === uid ? { ...b, title } : b)),
    }));
    schedulePersistDraft();
  },
  setBugReproSteps: (uid, reproSteps) => {
    set((s) => ({
      bugs: s.bugs.map((b) => (b.uid === uid ? { ...b, reproSteps } : b)),
    }));
    schedulePersistDraft();
  },
  setBugAssignee: (uid, assignedTo) => {
    set((s) => ({
      bugs: s.bugs.map((b) =>
        b.uid === uid ? { ...b, assignedTo: assignedTo ?? null } : b,
      ),
    }));
    schedulePersistDraft();
  },
  setAllBugsAssignee: (assignedTo) => {
    set((s) => ({
      bugs: s.bugs.map((b) =>
        b.decision === "keep" ? { ...b, assignedTo: assignedTo ?? null } : b,
      ),
    }));
    schedulePersistDraft();
  },

  publish: async () => {
    // Publishing is the end of the line for the draft as it stands. A pending
    // follow-up must not outlive it: resuming one after publish re-mints every
    // case's uid, which breaks the okByUid idempotency map below and makes the
    // next Publish create a DUPLICATE set of work items in ADO. Drop the
    // affordance and its row (and stop a still-running round) up front, so it
    // can't be reached from the review breadcrumb or resurrected by the probe
    // after a restart.
    get().cancelRefine();
    const pendingRefine = get().refineResumable;
    if (pendingRefine) {
      void deleteCheckpoint(pendingRefine.runId).catch(() => {});
      set({ refineResumable: null });
    }
    const { cases, bugs, planId, suiteId, tagSourceBranch } = get();
    if (!planId || !suiteId) {
      set({
        phase: "error",
        error: "Pick a Test Plan and Suite first.",
        errorPhase: "publish",
      });
      return;
    }
    // Belt-and-braces against a target restored from an older draft: Azure
    // DevOps fills a query-based suite from its own query and rejects every
    // hand-added case, so this would otherwise fail per-case with an opaque
    // server error after already creating orphan work items.
    // A draft saved before suite types existed has `targetSuiteType: null`,
    // which `suiteCapabilities` treats as permissive ("never gate on
    // ignorance"). That's the right default for a badge, but the wrong one
    // here: publish is where orphan work items get created, so resolve the
    // real type once rather than letting an unknown sail through. Cheap
    // (one list call, once, on an action the user takes rarely) and
    // best-effort — an ADO failure falls back to the permissive default
    // rather than blocking a publish that would have worked.
    let { targetSuiteType } = get();
    if (
      normalizeSuiteType(targetSuiteType) === "unknown" &&
      planId != null &&
      suiteId != null
    ) {
      try {
        const suites = await listSuites(planId);
        const fresh = suites.find((s) => s.id === suiteId);
        if (fresh) {
          targetSuiteType = fresh.suiteType ?? null;
          set({ targetSuiteType });
        }
      } catch {
        // Leave it unknown → permissive.
      }
    }
    if (!suiteCapabilities({ suiteType: targetSuiteType }).canAddCases) {
      set({
        phase: "error",
        error:
          "Query-based suites are filled by Azure DevOps from their work-item query — pick a static or requirement-based suite to publish into.",
        errorPhase: "publish",
      });
      return;
    }
    const keptCases = cases.filter((c) => c.decision === "keep");
    const keptBugs = bugs.filter((b) => b.decision === "keep");

    // Idempotent publish: if the user re-enters review after a successful
    // publish and clicks Publish again, we should NOT create duplicate work
    // items in ADO. Preserve the prior "ok" entries so the loops below skip
    // those uids, while still queuing fresh "pending" rows for anything
    // that hasn't been pushed yet (newly-added cases, retried failures).
    const prevLog = get().publishLog;
    const okByUid = new Map(
      prevLog.filter((l) => l.status === "ok").map((l) => [l.uid, l] as const),
    );

    const log: PublishLogEntry[] = [
      ...keptCases.map<PublishLogEntry>((c) => {
        const prior = okByUid.get(c.uid);
        if (prior) return prior; // already published — keep the row as-is
        return { uid: c.uid, kind: "case", title: c.title, status: "pending" };
      }),
      ...keptBugs.map<PublishLogEntry>((b) => {
        const prior = okByUid.get(b.uid);
        if (prior) return prior;
        return { uid: b.uid, kind: "bug", title: b.title, status: "pending" };
      }),
    ];
    set({ phase: "publishing", publishLog: log });

    const caseIdByDraftUid = new Map<string, number>();
    // Seed the case-id map with anything already published so bugs created
    // in this re-publish can link to their parent cases without re-creating
    // those cases. Result objects survive in publishLog from the prior run.
    for (const c of keptCases) {
      const prior = okByUid.get(c.uid);
      if (prior?.result?.id) caseIdByDraftUid.set(c.uid, prior.result.id);
    }
    let orgUrl = "";
    let project = "";
    // The repos a link's `<repo>/…` prefix is resolved against. One list for
    // the whole publish, read once — a repo added mid-publish would otherwise
    // rename links written after it.
    const publishRepos = getRepos();
    try {
      const conn = await getConnection();
      orgUrl = conn.orgUrl ?? "";
      project = conn.project ?? "";
    } catch {
      // Non-fatal — the published rows just lose their "open in ADO" links.
    }

    // Branch and HEAD sha PER REPO, captured once at publish time, so a batch
    // that cites two repos stamps each link with the branch it was actually
    // read from rather than whichever repo happens to sit first in the
    // registry. Code links always track the live working-dir branch — there is
    // no fixed-branch option. Either value can come back null (a folder that
    // isn't a git repo, or a detached HEAD, which has a commit but no branch);
    // null stamps nothing rather than a "main" the user never generated from.
    //
    // ONE gate for the whole map: a case's source links and the bugs hanging
    // off it must never disagree about where the code came from — and with
    // tagging off nothing is stamped, so the probes would be pure cost.
    const provenance = new Map<string, RepoProvenance>();
    if (tagSourceBranch) {
      await Promise.all(
        namedRepos(keptCases, keptBugs, publishRepos).map(async (repo) => {
          try {
            const info = await invoke<{
              branch: string | null;
              commit: string | null;
            }>("git_repo_info", { path: repo.root });
            provenance.set(repo.id, {
              branch: info?.branch ?? null,
              sha: info?.commit ?? null,
            });
          } catch {
            // Non-fatal, and per repo — one unreadable root must not cost the
            // repos that do answer their provenance stamp.
          }
        }),
      );
    }

    for (const c of keptCases) {
      // Skip cases that were already published successfully — re-running
      // publish would create a duplicate work item in ADO. The row stays
      // visible in the log with its original "ok" status + result link.
      if (okByUid.has(c.uid)) continue;
      try {
        const sourceLinksBlock = renderSourceLinksBlock(
          c.sourceLinks,
          publishRepos,
          provenance,
        );
        const steps = c.steps.map((s, i) => ({
          index: i + 1,
          action: s.action,
          expected: s.expected,
        }));

        // Either UPDATE an existing case the reviewer matched this draft to, or
        // CREATE a new one. Both paths converge on `caseId` for the shared
        // confidence + run-outcome writes below.
        let caseId: number;
        // Set when ADO gave the new case no test point — it's in the suite but
        // won't show under Execute, and no outcome can be recorded against it.
        let pointWarning: string | null = null;
        if (c.updateTargetCaseId != null) {
          caseId = c.updateTargetCaseId;
          await updateWorkItemTitle(caseId, c.title);
          await updateCaseDescription(
            caseId,
            sourceLinksBlock
              ? `${c.description}\n${sourceLinksBlock}`
              : c.description,
          );
          await updateCaseSteps(caseId, steps);
          updateLog(set, c.uid, {
            status: "ok",
            result: {
              id: caseId,
              url: "",
              webUrl: caseWebUrl(orgUrl, project, caseId),
            },
          });
        } else {
          const draft: AdoDraftCase = {
            title: c.title,
            description: c.description,
            steps,
            tags: c.tags,
            areaPath: c.areaPath ?? undefined,
            iterationPath: c.iterationPath ?? undefined,
            sourceLinksBlock,
          };
          const created = await createCaseInSuite(planId, suiteId, draft);
          caseId = created.id;
          pointWarning = created.pointWarning ?? null;
          updateLog(set, c.uid, { status: "ok", result: created });
        }
        caseIdByDraftUid.set(c.uid, caseId);

        // Carry the generation-time confidence verdict onto the published /
        // updated case. The confidence store is keyed by the real ADO case id —
        // without this, opening the case shows no readiness score even though we
        // evaluated it during review. Best-effort; never fails the publish.
        if (c.verdict) {
          try {
            await saveConfidence(caseId, c.verdict);
          } catch {
            // non-essential
          }
        }

        // Record the reviewer's chosen run outcome against the case's test
        // point. ADO can briefly lag creating the point for a just-added case,
        // so retry once; on failure surface a non-fatal warning rather than
        // failing the whole publish.
        //
        // When the backend already told us there's no test point at all, report
        // that instead — it's the reason any outcome write would fail, and a
        // retry loop against a point that will never exist just wastes time.
        if (pointWarning) {
          updateLog(set, c.uid, {
            // Say the outcome was dropped. Without a point there's nothing to
            // record it against, and silently ignoring a choice the reviewer
            // made is how "it published fine" turns into a wrong test report.
            error: c.desiredOutcome
              ? `${pointWarning} Its "${c.desiredOutcome}" outcome wasn't recorded.`
              : pointWarning,
          });
        } else if (c.desiredOutcome) {
          try {
            let points = await listTestPoints(planId, suiteId, caseId);
            if (points.length === 0) {
              await new Promise((r) => setTimeout(r, 600));
              points = await listTestPoints(planId, suiteId, caseId);
            }
            const point = points[0];
            if (!point) throw new Error("no test point in this suite yet");
            await setTestPointOutcome({
              planId,
              suiteId,
              pointId: point.id,
              caseId,
              outcome: c.desiredOutcome,
            });
          } catch (e) {
            updateLog(set, c.uid, {
              error: `Published, but couldn't set the run outcome: ${errToString(e)}`,
            });
          }
        }
      } catch (e) {
        updateLog(set, c.uid, {
          status: "failed",
          error: errToString(e),
        });
      }
    }

    for (const b of keptBugs) {
      // Same idempotence guard: don't re-create bugs that already landed.
      if (okByUid.has(b.uid)) continue;
      // linkedDraftCaseIndex indexes the full `cases` array (not keptCases) —
      // resolve through it so skipping an earlier case can't mislink the bug.
      const parentUid = bugParentCaseUid(b.linkedDraftCaseIndex, cases);
      const targetCaseId = parentUid
        ? caseIdByDraftUid.get(parentUid) ?? null
        : null;
      if (!targetCaseId) {
        updateLog(set, b.uid, {
          status: "failed",
          error: "Bug had no successfully-published case to link to.",
        });
        continue;
      }
      try {
        const created = await createBugAndLink(targetCaseId, {
          title: b.title,
          reproSteps: b.reproSteps,
          severity: b.severity,
          assignedTo: b.assignedTo ?? null,
          codeLinks: (b.codeRefs ?? []).map((r) => {
            const repo = splitRepoPath(r.file, publishRepos)?.repo;
            return {
              file: r.file,
              startLine: r.startLine,
              endLine: r.endLine ?? undefined,
              // The commit the bug was found against, read from the ref's OWN
              // repo, so its code refs survive future drift the same way case
              // source-links do. Null renders without the commit chip in
              // BugPane; the user can still navigate by file/line.
              commitSha: repo ? provenance.get(repo.id)?.sha ?? null : null,
            };
          }),
        });
        updateLog(set, b.uid, { status: "ok", result: created });
      } catch (e) {
        updateLog(set, b.uid, { status: "failed", error: errToString(e) });
      }
    }

    set({ phase: "done" });

    // Persist (or upsert) the publish snapshot. Reuses the runId allocated
    // at review time so the row that was sitting as a "draft" flips to
    // "published" in place instead of producing a duplicate entry.
    try {
      const s = get();
      // Index the log once by uid instead of a linear .find per case/bug.
      const logByUid = new Map(s.publishLog.map((l) => [l.uid, l] as const));
      const run: GenerationRun = {
        id: s.runId ?? newRunId(),
        timestamp: newTimestamp(),
        planId: s.planId,
        // Names aren't tracked in the session yet — the history pane shows
        // ids and falls back to the plan/suite lookup if it has them cached.
        planName: null,
        suiteId: s.suiteId,
        suiteName: null,
        mode: describeGeneration(s.coverage, s.suggestBugs),
        specExcerpt: specExcerpt(s.requirements ?? ""),
        cases: keptCases.map((c) => ({
          title: c.title,
          adoId: caseIdByDraftUid.get(c.uid) ?? null,
          webUrl: logByUid.get(c.uid)?.result?.webUrl ?? null,
        })),
        bugs: keptBugs.map((b) => ({
          title: b.title,
          severity: b.severity,
          adoId: logByUid.get(b.uid)?.result?.id ?? null,
          webUrl: logByUid.get(b.uid)?.result?.webUrl ?? null,
        })),
        publishLog: s.publishLog.map((l) => ({
          uid: l.uid,
          kind: l.kind,
          title: l.title,
          status: l.status === "pending" ? "skipped" : l.status,
          error: l.error ?? null,
        })),
        status: "published",
        // Persist the full draft body even on publish so a reopened run can
        // navigate Done → Review and re-publish edits. Without this, opening
        // a finished run only shows the publish summary and the review/input
        // breadcrumbs are stranded.
        draftPayload: {
          requirements: s.requirements,
          changesets: s.changesets,
          coverage: s.coverage,
          suggestBugs: s.suggestBugs,
          overrideModelId: s.overrideModelId,
          cases: s.cases,
          bugs: s.bugs,
          rawText: s.rawText,
          planId: s.planId,
          planName: s.planName,
          suiteId: s.suiteId,
          suiteName: s.suiteName,
          targetSuiteType: s.targetSuiteType,
          targetRequirementId: s.targetRequirementId,
          refineRounds: s.refineRounds,
          refineUndoSnapshot: s.refineUndoSnapshot,
          attachments: s.attachments,
        },
      };
      void saveRun(run);
    } catch {
      // Persisting is non-essential — the run still completed.
    }
  },

  setPublishLogTitle: (uid, title) => {
    set((s) => ({
      publishLog: s.publishLog.map((e) =>
        e.uid === uid ? { ...e, title } : e,
      ),
    }));
  },

  // Both wipe the session out from under any follow-up that's still running.
  // The round's terminal handler refuses to write into a session it doesn't
  // belong to, but only cancelling actually stops the provider request — and
  // the billing — instead of leaving it to finish into the void.
  reset: () => {
    get().cancelRefine();
    set({ ...initialState });
  },
  startNew: () => {
    get().cancelRefine();
    set({ ...initialState });
  },

  refine: async (instruction: string, workItemIds?: number[]) => {
    const s = get();
    if (s.phase !== "review" || s.isRefining) return;
    const text = instruction.trim();
    if (!text) return;

    // Snapshot BEFORE we mutate anything so undo can restore even if the
    // refine call partially fails (errors set isRefining=false but leave
    // the prior batch intact; the snapshot stays available either way).
    const snapshot = {
      cases: s.cases,
      bugs: s.bugs,
      rawText: s.rawText,
    };
    const round: RefineRoundMeta = {
      instruction: text,
      startedAt: newTimestamp(),
      beforeCases: s.cases.length,
      beforeBugs: s.bugs.length,
    };
    const sessionRunId = s.runId;

    // A new follow-up supersedes the one the user walked away from: nothing
    // points at that row any more, so drop it rather than leave it waiting to
    // be adopted the next time this draft is opened.
    const superseded = s.refineResumable?.runId ?? null;
    if (superseded) void deleteCheckpoint(superseded).catch(() => {});

    const seq = ++refineSeq;
    set({
      isRefining: true,
      activityLog: [],
      stepLabel: "Routing follow-up to the model…",
      error: null,
      errorPhase: null,
      refineError: null,
      refineResumable: null,
      // Zeroed, not left from the last round: the strip is reporting THIS
      // follow-up, and a round that starts at the previous one's total reads
      // as having spent it before making a request.
      refineSpend: {
        stepsUsed: 0,
        stepCap: GENERATOR_BUDGET.steps,
        tokensUsed: 0,
        tokenBudget: GENERATOR_BUDGET.tokens,
        tokensInput: null,
        tokensCached: null,
        peakPromptTokens: null,
        startedAt: Date.now(),
      },
    });

    // Minted before the prep awaits so a cancel during them already-aborts
    // the signal — the model call then rejects immediately.
    const refineAc = new AbortController();
    refineAbort = refineAc;

    // Out here so the catch can flush a terminal outcome from the run's own
    // scope. Null until the prompt is assembled: a failure before that point
    // (ADO context, keys, best-practice files) spent nothing model-side, so it
    // must not leave a row that reads as resumable.
    let cp: RefineCheckpointCtx | null = null;

    try {
      // Rebuild the target/related context the same way analyze() does so the
      // model sees the same plan/suite framing. Falls through gracefully if
      // ADO is unreachable — refine still works from spec + attachments.
      let targetContext: TargetContext | null = null;
      let relatedCases: RelatedCase[] = [];
      if (s.planId && s.suiteId) {
        try {
          targetContext = await buildTargetContext(s.planId, s.suiteId);
        } catch {
          // non-fatal
        }
        try {
          relatedCases = await fetchRelatedCaseTitles(s.planId, s.suiteId);
        } catch {
          // non-fatal
        }
      }

      const keptCases = s.cases.filter((c) => c.decision === "keep");
      const skippedCases = s.cases.filter((c) => c.decision !== "keep");
      const keptBugs = s.bugs.filter((b) => b.decision === "keep");
      const skippedBugs = s.bugs.filter((b) => b.decision !== "keep");

      const userPrompt = buildRefineUserPrompt({
        requirements: s.requirements,
        changesets: s.changesets,
        attachments: s.attachments,
        coverage: s.coverage,
        suggestBugs: s.suggestBugs,
        targetContext,
        relatedCases,
        keptCases,
        skippedCases,
        keptBugs,
        skippedBugs,
        draftCases: s.cases,
        draftBugs: s.bugs,
        // Read BEFORE this round mutates anything: `refineUndoSnapshot` is
        // still the previous round's undo point, so it pairs with the draft as
        // it stands right now to describe what that round actually changed.
        refineRounds: s.refineRounds,
        lastRefineSnapshot: s.refineUndoSnapshot,
        instruction: text,
      });

      const chat = useChatStore.getState();
      const keys = await chat.ensureApiKeys();
      const modelId = s.overrideModelId ?? chat.selectedModelId;
      const prefs = usePreferencesStore.getState();
      const { blocks: bpBlocks } = await loadBestPracticeBlocks(
        prefs.bestPracticeFiles,
        { visionCapable: supportsVision(modelId) },
      );
      // Attach any #id-mentioned work items as read-only grounding context.
      const bugBlocks =
        workItemIds && workItemIds.length > 0
          ? await bugsToContextBlocks(workItemIds)
          : [];
      const contextBlocks = [...bpBlocks, ...bugBlocks];
      const repos = prefs.codeSearchEnabled
        ? scopedRepos(prefs.repos, s.repoScope)
        : [];

      // Assemble the prompt separately from running it, exactly as analyze
      // does — that split is what lets the round be checkpointed BEFORE the
      // provider is touched and replayed later without rebuilding anything
      // (no second ADO prefetch, no re-read of the best-practice files).
      const prepared = prepareQaAnalystRun({
        requirements: s.requirements,
        attachments: s.attachments,
        existingCaseTitles: [],
        relatedCases,
        targetContext,
        coverage: s.coverage,
        suggestBugs: s.suggestBugs,
        keys,
        modelId,
        repos,
        contextBlocks,
        userPromptOverride: userPrompt,
      });

      // A cancel during the prep — or a newer round claiming the slot — spent
      // nothing model-side. Bailing before the writer exists is what keeps a
      // cancelled-during-prep follow-up from leaving an inputs-only row that
      // survives a restart and reads as resumable.
      if (seq !== refineSeq) return;
      refineAc.signal.throwIfAborted();

      // Everything above is recoverable input; from here on the round costs
      // money, so the resume point goes to disk BEFORE the provider is touched.
      let transcript: TranscriptCheckpoint | null = null;
      if (sessionRunId) {
        const createdAt = new Date().toISOString();
        const refineRunId = newRefineRunId();
        const writer = createCheckpointWriter({
          runId: refineRunId,
          surface: "generator-refine",
          // The `cwd` column is the store's generic scope key (SQL filters on
          // it; commit-review scopes by source dir). Scoping by the draft's
          // runId turns the review pane's probe into a one-row lookup instead
          // of "fetch the 10 newest payloads and filter in TS", and makes
          // "drop every row for this draft" a single list call.
          cwd: sessionRunId,
          createdAt,
        });
        const basePayload: GeneratorRefineCheckpointV2 = {
          v: 2,
          surface: "generator-refine",
          runId: refineRunId,
          sessionRunId,
          createdAt,
          modelId,
          repos,
          customInstructions: prepared.customInstructions,
          round,
          prepared: {
            userPrompt: prepared.userPrompt,
            attachments: toCheckpointAttachments(prepared.attachments),
          },
          activity: [],
          transcript: null,
          lastOutcome: null,
        };
        const buildPayload = (
          outcome: CheckpointOutcome | null,
        ): GeneratorRefineCheckpointV2 => ({
          ...basePayload,
          activity: get().activityLog,
          transcript,
          lastOutcome: outcome,
        });
        cp = { writer, buildPayload };
        await writer.flush(basePayload);
      }

      const liveCp = cp;
      const result: RunResult = await executeQaAnalystRun(prepared, {
        keys,
        local: localProviderConfig(prefs),
        onActivity: onRunActivity,
        onCheckpoint: (checkpoint) => {
          // A step finishing in the same tick as a cancel (or after a newer
          // round took over) must not queue a live payload on top of the
          // terminal outcome that was just written.
          if (seq !== refineSeq) return;
          set(refineSpendFrom(checkpoint));
          // Metering is guarded on the round only, NOT on `liveCp`: a draft
          // with no runId can't be checkpointed but still spends real money,
          // and that is exactly the round whose cost was invisible.
          if (!liveCp) return;
          transcript = toTranscript(checkpoint, null);
          liveCp.writer.save(liveCp.buildPayload(null));
        },
        onContextSignal: (sig) => {
          if (seq !== refineSeq) return;
          set(refinePeakFrom(sig.promptTokens));
        },
        signal: refineAc.signal,
      });

      await settleRefineRun({
        seq,
        sessionRunId,
        resumed: false,
        result,
        round,
        snapshot,
        budget: GENERATOR_BUDGET,
        cp,
      });
    } catch (e) {
      await settleRefineFailure({
        seq,
        sessionRunId,
        resumed: false,
        round,
        error: e,
        cp,
      });
    } finally {
      if (refineAbort === refineAc) refineAbort = null;
    }
  },

  resumeRefine: async () => {
    const start = get();
    if (start.phase !== "review" || start.isRefining) return;
    const target = start.refineResumable;
    if (!target) return;
    // Claim the refine slot synchronously — every gate below awaits, so
    // without this a double-click starts two runs on the same checkpoint.
    const seq = ++refineSeq;
    set({
      isRefining: true,
      stepLabel: "Resuming follow-up…",
      error: null,
      errorPhase: null,
      refineError: null,
      refineResumable: null,
      // A resume is a fresh call under its own (topped-up) grant, so the strip
      // reports what THIS attempt spends. What the interrupted attempt cost is
      // already on the resume card the user just clicked.
      refineSpend: {
        stepsUsed: 0,
        stepCap: GENERATOR_BUDGET.steps,
        tokensUsed: 0,
        tokenBudget: GENERATOR_BUDGET.tokens,
        tokensInput: null,
        tokensCached: null,
        peakPromptTokens: null,
        startedAt: Date.now(),
      },
    });
    // Minted before the checkpoint read, like refine() does before its prep:
    // ESC during that read has to have something to abort, or the round would
    // start anyway once the row came back.
    const refineAc = new AbortController();
    refineAbort = refineAc;
    /** Give the slot back — but only if nothing newer claimed it meanwhile,
     *  otherwise this bail would un-stick a round that IS running. */
    const bail = (patch: Partial<SessionState>): void => {
      if (seq !== refineSeq) return;
      set({ isRefining: false, stepLabel: "", ...patch });
    };

    let row: Awaited<ReturnType<typeof getCheckpoint>> = null;
    try {
      row = await getCheckpoint(target.runId);
    } catch (e) {
      console.warn("[generator] couldn't read the refine checkpoint:", e);
    }
    // Cancelled (or superseded) while the row was being read — the resume
    // never reached the provider, so there's nothing to record. The row is
    // untouched, so put the affordance back rather than stranding a resume
    // point the user can no longer see.
    if (seq !== refineSeq || refineAc.signal.aborted) {
      bail({ refineResumable: target });
      return;
    }
    if (!row || row.payload.surface !== "generator-refine") {
      bail({
        refineResumable: null,
        refineError:
          "The saved progress for that follow-up is gone — send it again.",
      });
      return;
    }
    const payload = row.payload;
    // The transcript is pinned to the model that produced it, so a retired id
    // can't be resumed. Keep the row (harmless) but drop the affordance —
    // clicking Resume could only ever fail.
    if (!isKnownModelId(payload.modelId)) {
      bail({
        refineResumable: null,
        refineError: `This follow-up ran on ${payload.modelId}, which is no longer available, so it can't be resumed. Send it again with a current model.`,
      });
      return;
    }
    // A row truncated by an older/partial write has no prompt to replay.
    // parseCheckpointRow only validates the envelope, so guard here rather
    // than let the deref below reject outside the try and pin the composer to
    // its running strip. (resumeAnalyze guards the same field.)
    if (!payload.prepared?.userPrompt) {
      bail({
        refineResumable: null,
        refineError:
          "That follow-up's saved progress is incomplete — send it again.",
      });
      void deleteCheckpoint(payload.runId).catch(() => {});
      return;
    }

    const { cap, tokens, resumeMessages, maxOutputTokens } =
      resumeBudget(payload);
    // Known only now, and usually NOT the surface budget: a round that stopped
    // without answering resumes on a top-up. The strip has to show the grant
    // THIS attempt has, or its meter reads a fraction of the wrong ceiling.
    set((s) =>
      s.refineSpend
        ? {
            refineSpend: { ...s.refineSpend, stepCap: cap, tokenBudget: tokens },
          }
        : {},
    );
    const base = payload.transcript;
    // Re-read: the draft is what the user sees NOW, which is the undo point a
    // completed resume should restore, and the basis for carrying verdicts /
    // update-bindings forward. (Nothing can edit it while a refine runs.)
    const live = get();
    const snapshot = {
      cases: live.cases,
      bugs: live.bugs,
      rawText: live.rawText,
    };
    // Seeded from the checkpoint so the log reads as one continuous round.
    set({ activityLog: payload.activity });

    const writer = createCheckpointWriter({
      runId: payload.runId,
      surface: "generator-refine",
      cwd: payload.sessionRunId,
      createdAt: payload.createdAt,
    });
    let transcript: TranscriptCheckpoint | null = base;
    const buildPayload = (
      outcome: CheckpointOutcome | null,
    ): GeneratorRefineCheckpointV2 => ({
      ...payload,
      activity: get().activityLog,
      transcript,
      lastOutcome: outcome,
    });
    const cp: RefineCheckpointCtx = { writer, buildPayload };

    // Every input is frozen at what the round started with — re-assembling the
    // prompt here would refine a draft the transcript never saw.
    const prepared: PreparedAnalystRun = {
      modelId: payload.modelId,
      userPrompt: payload.prepared.userPrompt,
      attachments: payload.prepared.attachments,
      repos: payload.repos,
      customInstructions: payload.customInstructions,
    };

    try {
      const prefs = usePreferencesStore.getState();
      const keys = await useChatStore.getState().ensureApiKeys();
      const result: RunResult = await executeQaAnalystRun(prepared, {
        keys,
        local: localProviderConfig(prefs),
        maxSteps: cap,
        tokenBudget: tokens,
        maxOutputTokens,
        resumeMessages,
        onActivity: onRunActivity,
        onCheckpoint: (checkpoint) => {
          if (seq !== refineSeq) return;
          set(refineSpendFrom(checkpoint));
          // checkpoint.messages already carries the resumed prefix (the runner
          // prepends it), so only the COUNTERS need the earlier totals added.
          transcript = toTranscript(checkpoint, base);
          writer.save(buildPayload(null));
        },
        onContextSignal: (sig) => {
          if (seq !== refineSeq) return;
          set(refinePeakFrom(sig.promptTokens));
        },
        signal: refineAc.signal,
      });
      await settleRefineRun({
        seq,
        sessionRunId: payload.sessionRunId,
        resumed: true,
        result,
        round: payload.round,
        snapshot,
        budget: { tokens, steps: cap },
        cp,
      });
    } catch (e) {
      await settleRefineFailure({
        seq,
        sessionRunId: payload.sessionRunId,
        resumed: true,
        round: payload.round,
        error: e,
        cp,
      });
    } finally {
      if (refineAbort === refineAc) refineAbort = null;
    }
  },

  discardRefineCheckpoint: () => {
    const target = get().refineResumable;
    if (!target) return;
    void deleteCheckpoint(target.runId).catch(() => {});
    set({ refineResumable: null });
  },

  probeRefineCheckpoint: async () => {
    const s = get();
    // Nothing to adopt over: a live round owns the slot, and an affordance
    // that's already showing came from this session's own terminal write.
    if (s.isRefining || s.refineResumable) return;
    if (s.phase !== "review") return;
    const sessionRunId = s.runId;
    if (!sessionRunId) return;

    let entries: Awaited<ReturnType<typeof listCheckpoints>>;
    try {
      // Scoped in SQL by the draft's runId (see the writer's cwd comment), so
      // opening a draft that never ran a follow-up costs one list call and
      // zero payload reads.
      entries = await listCheckpoints("generator-refine", sessionRunId);
    } catch {
      return;
    }
    // Newest first (the Rust list orders by updated_at DESC), so the first
    // match is the follow-up the user last had running. Bounded anyway: a
    // draft shouldn't cost N round-trips to open however it got its rows.
    for (const entry of entries.slice(0, 10)) {
      let cp: Awaited<ReturnType<typeof getCheckpoint>> = null;
      try {
        cp = await getCheckpoint(entry.runId);
      } catch {
        continue;
      }
      if (!cp || cp.payload.surface !== "generator-refine") continue;
      const p = cp.payload;
      if (p.sessionRunId !== sessionRunId) continue;
      // Same gate as every Resume affordance: a round that died non-resumably,
      // or answered badly with nothing banked, would just re-fail.
      const progress = {
        stepsUsed: p.transcript?.stepsUsed ?? 0,
        hasTranscript: hasReplayableTranscript(p.transcript),
        outputCapRaisable: canRaiseOutputCap(p.modelId, p.lastOutcome),
      };
      if (
        !canOfferResume(p.lastOutcome, p.lastOutcome?.message ?? null, progress)
      ) {
        continue;
      }
      // Re-validate in the same synchronous step as the patch — the user may
      // have sent a new follow-up (or closed the draft) during the awaits.
      const now = get();
      if (now.isRefining || now.refineResumable || now.runId !== sessionRunId) {
        return;
      }
      set({
        refineResumable: {
          runId: p.runId,
          instruction: p.round.instruction,
          ...progress,
          totalTokens: p.transcript?.usage?.totalTokens ?? null,
          updatedAt: cp.updatedAt,
          outcome: p.lastOutcome,
        },
      });
      return;
    }
  },

  cancelRefine: () => {
    const { isRefining } = get();
    if (!isRefining) return;
    // Un-stick the UI immediately, then abort the model run — the rejection
    // lands in refine()'s catch as a cancelled round (no error banner).
    set({ isRefining: false, stepLabel: "" });
    refineAbort?.abort();
  },

  dismissRefineError: () => set({ refineError: null }),

  sendChatMessage: async (question: string, bugIds?: number[]) => {
    const text = question.trim();
    if (!text) return;
    const s = get();
    if (s.chatBusy) return;
    const userMsg: ChatMessage = {
      id: newChatMessageId(),
      role: "user",
      content: text,
      timestamp: newTimestamp(),
    };
    const priorHistory = s.chatMessages;
    // Append the user turn AND an empty assistant placeholder we'll stream
    // tokens into — same live-bubble pattern as the suite chat.
    const assistantId = newChatMessageId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: newTimestamp(),
    };
    set({
      chatBusy: true,
      chatError: null,
      chatStreamingId: assistantId,
      chatMessages: [...priorHistory, userMsg, assistantMsg],
    });

    // Minted before the prep awaits so a cancel during them already-aborts
    // the signal — the model call then rejects immediately.
    const chatAc = new AbortController();
    chatAbort = chatAc;

    const appendDelta = (delta: string) =>
      set((curr) => ({
        chatMessages: curr.chatMessages.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        ),
      }));

    // The model-facing record of this turn, refreshed after every step. Kept in
    // a local rather than written straight to the message so a cancelled turn
    // banks whatever it had read at the moment it stopped — the terminal paths
    // below decide what to keep.
    let turnTranscript: ModelMessage[] = [];

    // Tool activity (Read/Glob/Grep) → upsert onto the assistant message by id
    // so a running tool later completes in place. Surfaces the same live strip
    // the other chats use.
    const mergeToolEvent = (e: ActivityEntry) =>
      set((curr) => ({
        chatMessages: curr.chatMessages.map((m) => {
          if (m.id !== assistantId) return m;
          const prior = m.toolEvents ?? [];
          const idx = prior.findIndex((x) => x.id === e.id);
          const toolEvents =
            idx >= 0
              ? prior.map((x, i) => (i === idx ? { ...x, ...e } : x))
              : [...prior, e];
          return { ...m, toolEvents };
        }),
      }));

    const chat = useChatStore.getState();
    const keys = await chat.ensureApiKeys();
    const modelId = s.overrideModelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const { blocks: bpBlocks } = await loadBestPracticeBlocks(
      prefs.bestPracticeFiles,
      { visionCapable: supportsVision(modelId) },
    );
    const bugBlocks =
      bugIds && bugIds.length > 0 ? await bugsToContextBlocks(bugIds) : [];
    const chatContextBlocks = [...bpBlocks, ...bugBlocks];

    // A draft reopened from History — or a resumed run — restores
    // `targetRequirementId` but deliberately not the body. Without this the
    // block renders its "could NOT be loaded from Azure DevOps" variant and
    // the model is told something false: nothing was ever attempted. Hydrate
    // once, here, on the surface that actually asks coverage questions.
    let requirement = get().targetRequirement;
    const requirementId = get().targetRequirementId;
    if (requirement == null && requirementId != null) {
      requirement = await getBug(requirementId)
        .then(toTargetRequirement)
        .catch(() => null);
      // Cache even a null result's counterpart: on success this spares every
      // later message the same fetch. On failure the block correctly reports
      // the requirement as unreadable, because now it genuinely is.
      if (requirement) set({ targetRequirement: requirement });
    }

    try {
      const run = await streamChatTask({
        requirements: s.requirements,
        changesets: s.changesets,
        attachments: s.attachments,
        cases: s.cases,
        bugs: s.bugs,
        // The Ask sits beside the Refine dock in the same pane, so questions
        // about the draft are routinely questions about a follow-up the user
        // ran. It had the draft but no account of how the draft got that way.
        refineRounds: s.refineRounds,
        lastRefineSnapshot: s.refineUndoSnapshot,
        // Was `null`, which meant draft-chat couldn't answer "does this cover
        // the acceptance criteria?" for a requirement-bound suite. Normally the
        // body is whatever analyze() already resolved — the hydrate above only
        // fires for a draft reopened from History or a resumed run, where the
        // id survived but the body deliberately didn't.
        targetContext:
          s.planId != null && s.suiteId != null
            ? {
                planId: s.planId,
                planName: s.planName,
                suiteId: s.suiteId,
                suiteName: s.suiteName,
                suitePath: [],
                areaPath: null,
                iterationPath: null,
                suiteType: s.targetSuiteType ?? undefined,
                requirement,
                requirementId,
              }
            : null,
        history: priorHistory,
        newQuestion: text,
        keys,
        modelId,
        local: localProviderConfig(prefs),
        contextBlocks: chatContextBlocks,
        repos: prefs.codeSearchEnabled
          ? scopedRepos(prefs.repos, s.repoScope)
          : [],
        customInstructions: prefs.customInstructions || undefined,
        onText: appendDelta,
        onToolEvent: mergeToolEvent,
        onTranscript: (messages) => {
          turnTranscript = messages;
        },
        signal: chatAc.signal,
      });
      // What SETTLES in the thread is what the runner returns, which is not
      // always what streamed. A turn that stalled mid-read streams its
      // narration live — the user should see it working — and then comes back
      // with the answer alone, so the saved message is the answer rather than
      // "I'll dig into the collect code…" followed by it. Falls back to the
      // streamed text, then to a placeholder, so an empty bubble never renders.
      const settled = run.text.trim();
      set((curr) => ({
        chatBusy: false,
        chatStreamingId: null,
        chatMessages: curr.chatMessages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content:
                  settled ||
                  (m.content.trim() === "" ? "(empty response)" : m.content),
                ...bankTranscript(turnTranscript),
              }
            : m,
        ),
      }));
    } catch (e) {
      const cancelled = isCancelledError(e);
      if (!cancelled) console.error("[generator] chat failed:", e);
      // Drop the placeholder if nothing streamed (keep a partial answer on
      // cancel — that text is still useful to the user). A turn that survives
      // keeps its transcript too: the reads are paid for either way, and
      // carrying them is what stops the retry from making all of them again.
      set((curr) => ({
        chatBusy: false,
        chatStreamingId: null,
        chatMessages: curr.chatMessages.flatMap((m) => {
          if (m.id !== assistantId) return [m];
          if (m.content.trim() === "") return [];
          return [{ ...m, ...bankTranscript(turnTranscript) }];
        }),
        chatError: cancelled ? null : errToString(e),
      }));
    } finally {
      if (chatAbort === chatAc) chatAbort = null;
    }
  },

  cancelChat: () => {
    const { chatBusy } = get();
    if (!chatBusy) return;
    // Un-stick the UI immediately, then abort the streaming run — the
    // rejection lands in sendChatMessage's catch, which keeps any partial
    // answer and suppresses the error banner for cancels.
    set({ chatBusy: false });
    chatAbort?.abort();
  },

  clearChat: () => set({ chatMessages: [], chatError: null }),

  dismissChatError: () => set({ chatError: null }),

  goToInput: () => {
    const phase = get().phase;
    // Don't yank the user out of analyzing / publishing — those are in-flight
    // and the natural exit is cancel(). Anything else is safe to swap.
    if (phase === "analyzing" || phase === "publishing") return;
    set({ phase: "input", error: null, errorPhase: null });
  },

  goToReview: () => {
    const s = get();
    if (s.cases.length === 0 && s.bugs.length === 0) return;
    set({ phase: "review", error: null, errorPhase: null });
  },

  goToDone: () => {
    const s = get();
    // Refuse the jump if no publish has actually happened — landing on a
    // success screen with an empty log is just confusing. Also refuse mid-
    // flight phases; the natural exit there is cancel(), not a sideways
    // breadcrumb click.
    if (s.publishLog.length === 0) return;
    if (s.phase === "analyzing" || s.phase === "publishing") return;
    set({ phase: "done", error: null, errorPhase: null });
  },

  undoRefine: () => {
    set((curr) => {
      if (!curr.refineUndoSnapshot) return {};
      return {
        cases: curr.refineUndoSnapshot.cases,
        bugs: curr.refineUndoSnapshot.bugs,
        rawText: curr.refineUndoSnapshot.rawText,
        refineUndoSnapshot: null,
      };
    });
  },

  loadDraft: (run) => {
    // Only "draft" rows with an embedded payload can be restored — published
    // rows have nothing structured to put on screen, and legacy drafts
    // (saved before the payload field existed) only have titles, which can't
    // round-trip back to a publishable review state.
    const payload = run.draftPayload;
    if (!payload || !payload.cases) return false;
    const rounds = payload.refineRounds ?? [];
    // Derive the dedup'd recall list from the structured rounds so the
    // history popover keeps working after a window restart, even though
    // we don't persist the flat list separately.
    const refineHistoryFromRounds: string[] = [];
    for (let i = rounds.length - 1; i >= 0; i--) {
      const inst = rounds[i].instruction;
      if (!refineHistoryFromRounds.includes(inst)) {
        refineHistoryFromRounds.push(inst);
      }
      if (refineHistoryFromRounds.length >= REFINE_HISTORY_MAX) break;
    }
    set({
      ...initialState,
      phase: "review",
      requirements: payload.requirements ?? "",
      changesets: payload.changesets ?? "",
      // Prefer the two-axis fields; fall back to deriving from a legacy draft's
      // single `mode` so pre-split drafts still restore correctly.
      coverage: payload.coverage ?? modeToAxes(payload.mode).coverage,
      suggestBugs: payload.suggestBugs ?? modeToAxes(payload.mode).suggestBugs,
      overrideModelId: payload.overrideModelId ?? null,
      cases: reconcileAutoOutcomes(payload.cases ?? [], payload.bugs ?? []),
      bugs: payload.bugs ?? [],
      rawText: payload.rawText ?? "",
      planId: payload.planId ?? run.planId ?? null,
      suiteId: payload.suiteId ?? run.suiteId ?? null,
      // Restore the cached display names so the reopened tab's title
      // doesn't briefly say "Generate cases" before re-resolving.
      planName: payload.planName ?? run.planName ?? null,
      suiteName: payload.suiteName ?? run.suiteName ?? null,
      targetSuiteType: payload.targetSuiteType ?? run.suiteType ?? null,
      targetRequirementId: payload.targetRequirementId ?? null,
      runId: run.id,
      refineRounds: rounds,
      refineHistory: refineHistoryFromRounds,
      // Restore the pre-refine snapshot so the "Last refine" changes panel
      // reappears exactly as it was when the draft was saved.
      refineUndoSnapshot: payload.refineUndoSnapshot ?? null,
      // Bring back the session attachments so a reopened draft refines with
      // the same images/files the model originally saw.
      attachments: payload.attachments ?? [],
    });
    return true;
  },

  loadPublishedRun: (run) => {
    if (run.publishLog.length === 0) return false;
    // The persisted publish-log entry doesn't carry the CreatedWorkItem
    // result — only kind/uid/status/title. Reconstruct each row's `result`
    // by walking publishLog in order and zipping the OK rows against
    // run.cases / run.bugs (which are stored in publish order, kept rows
    // only). Failed rows keep result=undefined, which matches what the
    // live publish path produces.
    const caseSummaries = run.cases;
    const bugSummaries = run.bugs;
    let caseI = 0;
    let bugI = 0;
    const reconstructedLog: PublishLogEntry[] = run.publishLog.map((e) => {
      let result: CreatedWorkItem | undefined;
      if (e.kind === "case") {
        const cs = caseSummaries[caseI++];
        if (e.status === "ok" && cs && cs.adoId && cs.webUrl) {
          result = { id: cs.adoId, url: cs.webUrl, webUrl: cs.webUrl };
        }
      } else {
        const bs = bugSummaries[bugI++];
        if (e.status === "ok" && bs && bs.adoId && bs.webUrl) {
          result = { id: bs.adoId, url: bs.webUrl, webUrl: bs.webUrl };
        }
      }
      return {
        uid: e.uid,
        kind: e.kind,
        title: e.title,
        // "skipped" is a persisted-only status (we drop pending writes to
        // "skipped" on save). For a reopened published run we map it back
        // to "failed" since that's how the done view groups error rows.
        status: e.status === "skipped" ? "failed" : e.status,
        result,
        error: e.error ?? undefined,
      };
    });

    // If the row also carries a draft payload (we now always persist this
    // on publish so re-publishing edits is possible — see publish() below),
    // restore cases + bugs so the review breadcrumb is reachable. Older
    // rows without a payload land on done-only.
    const payload = run.draftPayload;
    const rounds = payload?.refineRounds ?? [];

    set({
      ...initialState,
      phase: "done",
      publishLog: reconstructedLog,
      runId: run.id,
      planId: payload?.planId ?? run.planId ?? null,
      suiteId: payload?.suiteId ?? run.suiteId ?? null,
      planName: payload?.planName ?? run.planName ?? null,
      suiteName: payload?.suiteName ?? run.suiteName ?? null,
      requirements: payload?.requirements ?? "",
      changesets: payload?.changesets ?? "",
      coverage: payload?.coverage ?? modeToAxes(payload?.mode).coverage,
      suggestBugs: payload?.suggestBugs ?? modeToAxes(payload?.mode).suggestBugs,
      overrideModelId: payload?.overrideModelId ?? null,
      cases: payload?.cases ?? [],
      bugs: payload?.bugs ?? [],
      rawText: payload?.rawText ?? "",
      refineRounds: rounds,
      refineUndoSnapshot: payload?.refineUndoSnapshot ?? null,
    });
    return true;
  },
    });
  });
}

/** React Context for the active generator tab's session store. Wrap each
 *  GeneratorPane in a Provider so multiple tabs can each hold their own
 *  draft, attachments, and refine history without trampling each other. */
const GenerationSessionContext = createContext<GenerationSessionStore | null>(
  null,
);

export function GenerationSessionProvider({
  store,
  children,
}: {
  store: GenerationSessionStore;
  children: ReactNode;
}) {
  return createElement(
    GenerationSessionContext.Provider,
    { value: store },
    children,
  );
}

/** Subscribe to a slice of the active session store. Throws when used
 *  outside of a GenerationSessionProvider — every caller MUST be wrapped. */
export function useGenerationSession<T>(selector: (s: SessionState) => T): T {
  const store = useContext(GenerationSessionContext);
  if (!store) {
    throw new Error(
      "useGenerationSession must be used inside a <GenerationSessionProvider>",
    );
  }
  return useStore(store, selector);
}

/** Imperatively access the active session store — for callers that need
 *  `.getState()` / `.subscribe()` semantics (e.g. tab-title syncing). */
export function useGenerationSessionStore(): GenerationSessionStore {
  const store = useContext(GenerationSessionContext);
  if (!store) {
    throw new Error(
      "useGenerationSessionStore must be used inside a <GenerationSessionProvider>",
    );
  }
  return store;
}

function updateLog(
  set: (
    fn: (s: SessionState) => Partial<SessionState>,
  ) => void,
  uid: string,
  patch: Partial<PublishLogEntry>,
) {
  set((s) => ({
    publishLog: s.publishLog.map((e) =>
      e.uid === uid ? { ...e, ...patch } : e,
    ),
  }));
}

/** One repo's HEAD at publish time. Either half can be null — a folder that
 *  isn't a git repo has neither; a detached HEAD has the commit but no branch. */
type RepoProvenance = { branch: string | null; sha: string | null };

/** The repo a draft source link belongs to: the path's `<repo>/…` prefix first,
 *  which is what the prompts now ask for, then the deprecated `repoName` an
 *  older draft still carries. One precedence for both the name that gets
 *  published and the HEAD that gets stamped, so a link can never claim one repo
 *  while carrying another's branch. Null ⇒ no configured repo claims it. */
function linkRepo(
  link: DraftSourceLink,
  repos: WorkspaceRepo[],
): WorkspaceRepo | null {
  const split = splitRepoPath(link.filePath, repos);
  if (split) return split.repo;
  const legacy = link.repoName?.trim().toLowerCase();
  if (!legacy) return null;
  return repos.find((r) => r.name.toLowerCase() === legacy) ?? null;
}

/** The repos a batch's links and code refs actually name — the only ones worth
 *  a git probe at publish time. Deduped, so N cases citing one repo cost one
 *  subprocess, and a repo nobody linked to costs none. */
function namedRepos(
  cases: ReviewedCase[],
  bugs: ReviewedBug[],
  repos: WorkspaceRepo[],
): WorkspaceRepo[] {
  const byId = new Map<string, WorkspaceRepo>();
  for (const c of cases) {
    for (const l of c.sourceLinks ?? []) {
      const repo = linkRepo(l, repos);
      if (repo) byId.set(repo.id, repo);
    }
  }
  for (const b of bugs) {
    for (const r of b.codeRefs ?? []) {
      const repo = splitRepoPath(r.file, repos)?.repo;
      if (repo) byId.set(repo.id, repo);
    }
  }
  return [...byId.values()];
}

/** `trackingBranch` and `generationSha` are the provenance stamp, taken from
 *  the link's OWN repo — a case citing two repos records each link against the
 *  branch it was read from. Both empty when the user published without
 *  source-branch tagging (the map is then empty by design), in which case the
 *  link still records repo + path, just nothing about where it came from.
 *
 *  A link that names no repo — no usable prefix, no legacy `repoName` — is
 *  DROPPED rather than written blank: `parseSourceLinks` requires a repo, so a
 *  blank one publishes a line that can never be read back, a dead link sitting
 *  in the user's ADO description forever. */
function renderSourceLinksBlock(
  links: DraftSourceLink[] | undefined,
  repos: WorkspaceRepo[],
  provenance: Map<string, RepoProvenance>,
): string | null {
  if (!links || links.length === 0) return null;
  const sl: SourceLink[] = [];
  for (const l of links) {
    const repo = linkRepo(l, repos);
    const repoName = repo?.name ?? l.repoName;
    if (!repoName) continue;
    const stamp = repo ? provenance.get(repo.id) : undefined;
    const branch = stamp?.branch ?? "";
    sl.push({
      repoId: l.repoId ?? repoName,
      repoName,
      filePath: l.filePath,
      symbol: l.symbol ?? undefined,
      lineRange: l.lineRange ?? undefined,
      generationBranch: branch,
      generationSha: stamp?.sha ?? "",
      trackingBranch: branch,
    });
  }
  return sl.length > 0 ? renderBlock(sl) : null;
}

/** Resolve plan + suite metadata into the structured TargetContext that the
 *  analyst engines embed at the top of the user prompt. Walks the suite tree
 *  to build the parent path so the model sees "Auth › Sign-in › 2FA" instead
 *  of an orphan suite id.
 *
 *  When the target is a requirement-based suite this also pulls in the work
 *  item it tracks, so cases are grounded in the story's own acceptance
 *  criteria. That's DERIVED here, never stored on the session: re-targeting to
 *  a different suite recomputes it on the next analyze with no state to undo,
 *  and no requirement body bloats a saved draft. */
async function buildTargetContext(
  planId: number,
  suiteId: number,
): Promise<TargetContext> {
  const [plans, suites] = await Promise.all([
    listPlans().catch<TestPlanRef[]>(() => []),
    listSuites(planId).catch<SuiteRef[]>(() => []),
  ]);
  const plan = plans.find((p) => p.id === planId) ?? null;
  const suite = suites.find((s) => s.id === suiteId) ?? null;
  const byId = new Map(suites.map((s) => [s.id, s]));
  const path: string[] = [];
  let cursor = suite?.parentSuiteId ?? null;
  // Cap traversal depth — a real ADO tree is shallow but a corrupt parent
  // ref shouldn't be able to spin this loop forever.
  let guard = 0;
  while (cursor != null && guard++ < 64) {
    const parent = byId.get(cursor);
    if (!parent) break;
    path.unshift(parent.name);
    cursor = parent.parentSuiteId ?? null;
  }
  let requirement: TargetRequirement | null = null;
  if (suite && isRequirementSuite(suite) && suite.requirementId != null) {
    try {
      // getBug is a plain work-item fetch despite the name — it's type-agnostic.
      requirement = toTargetRequirement(await getBug(suite.requirementId));
    } catch (e) {
      // Non-fatal, same contract as this function's own callers: the run still
      // works, it just isn't grounded in the requirement.
      console.warn("[generator] couldn't load target requirement:", e);
    }
  }

  return {
    planId,
    planName: plan?.name ?? null,
    suiteId,
    suiteName: suite?.name ?? null,
    suitePath: path,
    areaPath: plan?.areaPath ?? null,
    iterationPath: plan?.iteration ?? null,
    suiteType: suite?.suiteType,
    requirement,
    requirementId:
      suite && isRequirementSuite(suite) ? suite.requirementId ?? null : null,
  };
}

function errToString(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "Error";
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      // ADO Rust commands reject with discriminated unions tagged by `kind`.
      return adoErrorMessage(toAdoError(e));
    }
    // Generic SDK / fetch errors typically carry a `.message` field.
    if (typeof obj.message === "string" && obj.message) return obj.message;
    // Last-resort serialization. `String(obj)` would give "[object Object]";
    // JSON at least surfaces keys the user can quote in a bug report.
    try {
      const json = JSON.stringify(e);
      if (json && json !== "{}") return json;
    } catch {
      // Cyclic or otherwise unserialisable — fall through.
    }
  }
  const s = String(e);
  return s === "[object Object]" ? "Unknown error" : s;
}
