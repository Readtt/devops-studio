import { createContext, createElement, useContext } from "react";
import type { ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import {
  adoErrorMessage,
  createCaseInSuite,
  createBugAndLink,
  getConnection,
  getCase,
  listPlans,
  listSuiteCases,
  listSuites,
  listTestPoints,
  setTestPointOutcome,
  toAdoError,
  type AdoError,
  type CreatedWorkItem,
  type DraftCase as AdoDraftCase,
  type ExecutionOutcome,
  type SuiteRef,
  type TestPlanRef,
} from "@/modules/ado";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { cancelClaudeRun, claudeErrorMessage } from "@/modules/ai/lib/claude";
import {
  type GenerationMode as Mode,
  type RunResult,
  type TargetContext,
  runQaAnalyst,
} from "../lib/qaAnalystRun";
import { runQaAnalystClaude } from "../lib/qaAnalystRunClaude";
import { resolveClaudeModelId, selectEngine } from "@/modules/ai/lib/engine";
import { resolveTrackingBranch } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import type {
  DraftSourceLink,
  ReviewedBug,
  ReviewedCase,
} from "../lib/draftBatchSchema";
import { findSimilarCases } from "../lib/similarity";
import {
  fetchRelatedCaseTitles,
  type RelatedCase,
} from "../lib/relatedCases";
import { renderBlock } from "@/modules/test-plans/lib/sourceLinksParser";
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
  streamQaChat,
  streamQaChatClaude,
  newChatMessageId,
  type ChatMessage,
} from "../lib/qaChatRun";

export type GenerationMode = Mode;

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

import { supportsVision, type ModelId } from "@/modules/ai/config";
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
  mode: GenerationMode;
  /** Let the Claude Code agent search the user's source directory while
   *  generating. Only meaningful when engine === "claude-agent-sdk" AND a
   *  source root is set. Defaults to true so first-time users get the
   *  better experience without having to find a hidden toggle. */
  allowCodeSearch: boolean;
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
  /** History run id assigned when the session reaches review. The draft
   *  snapshot is saved under this id; the later publish path upserts on the
   *  same id so the row reads "published" instead of creating a duplicate. */
  runId: string | null;
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
  setMode: (m: GenerationMode) => void;
  setTarget: (planId: number | null, suiteId: number | null) => void;
  /** Backfill plan/suite display names when they were missing from a
   *  loaded draft. Triggers a draft autosave so subsequent reopens use
   *  the resolved labels without another ADO lookup. */
  setPlanSuiteNames: (planName: string | null, suiteName: string | null) => void;
  setAllowCodeSearch: (v: boolean) => void;
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
  /** Cancel an in-flight analyze and return to the input phase. The model
   *  request itself is not aborted (provider SDKs don't all support it) —
   *  this just dumps the result instead of moving to review. */
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
  /** Re-link a bug to a different draft case (by case uid). The picker on
   *  the bug card uses this when the user explicitly chooses a new parent
   *  after the original case was skipped. */
  setBugParent: (bugUid: string, caseUid: string | null) => void;
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
  /** Re-prompt the model with the current draft + a follow-up instruction.
   *  Replaces cases/bugs on success and stashes the previous state for
   *  undoRefine(). Errors are surfaced via refineError without leaving review. */
  refine: (instruction: string, workItemIds?: number[]) => Promise<void>;
  /** Kill the in-flight refine subprocess and return the UI to the composer.
   *  ESC during refine wires here. Tolerated when nothing is running. */
  cancelRefine: () => void;
  /** Run id of the active claude subprocess (analyze or refine), if any.
   *  Populated via the runner's onRunStart callback so cancel commands have
   *  a target to signal. Cleared when the run settles. */
  activeClaudeRunId: string | null;

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
  /** Run id of the in-flight chat subprocess, when the engine is Claude
   *  CLI. Lets a cancel button abort the round mid-stream. */
  chatActiveClaudeRunId: string | null;
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

const initialState: Omit<
  SessionState,
  | "setRequirements"
  | "setChangesets"
  | "setMode"
  | "setTarget"
  | "setPlanSuiteNames"
  | "setAllowCodeSearch"
  | "setOverrideModelId"
  | "addAttachment"
  | "addRichAttachment"
  | "removeAttachment"
  | "addWorkItem"
  | "removeWorkItem"
  | "clearWorkItems"
  | "analyze"
  | "cancel"
  | "tryAgain"
  | "setCaseDecision"
  | "setBugDecision"
  | "setBugParent"
  | "setCaseTitle"
  | "setCaseRationale"
  | "setCaseOutcome"
  | "setCaseVerdict"
  | "setCaseStep"
  | "addCaseStep"
  | "removeCaseStep"
  | "setBugTitle"
  | "setBugReproSteps"
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
  mode: "thorough",
  allowCodeSearch: true,
  overrideModelId: null,
  stepLabel: "",
  activityLog: [],
  durationMs: null,
  runId: null,
  cases: [],
  bugs: [],
  rawText: "",
  publishLog: [],
  error: null,
  errorPhase: null,
  isRefining: false,
  activeClaudeRunId: null,
  refineUndoSnapshot: null,
  refineError: null,
  refineHistory: [],
  refineRounds: [],
  chatMessages: [],
  chatBusy: false,
  chatStreamingId: null,
  chatError: null,
  chatActiveClaudeRunId: null,
};

const REFINE_HISTORY_MAX = 12;

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
        mode: s.mode,
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
          mode: s.mode,
          overrideModelId: s.overrideModelId,
          cases: s.cases,
          bugs: s.bugs,
          rawText: s.rawText,
          planId: s.planId,
          planName: s.planName,
          suiteId: s.suiteId,
          suiteName: s.suiteName,
          refineRounds: s.refineRounds,
          refineUndoSnapshot: s.refineUndoSnapshot,
          attachments: s.attachments,
        },
      };
      // Fire-and-forget; the post-save event lets the History pane refresh.
      void saveRun(run).then(() => {
        try {
          window.dispatchEvent(
            new CustomEvent("devops-studio:history-updated", {
              detail: { runId: s.runId },
            }),
          );
        } catch {
          // Non-fatal — synchronous dispatch should never throw.
        }
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
    return ({
  ...initialState,

  setRequirements: (s) => set({ requirements: s }),
  setChangesets: (s) => set({ changesets: s }),
  setMode: (m) => set({ mode: m }),
  // Setting a target wipes the cached names — they'll be re-resolved at
  // analyze() time (or restored by loadDraft) so the tab title stays in
  // sync with whichever plan/suite is actually selected.
  setTarget: (planId, suiteId) =>
    set({ planId, suiteId, planName: null, suiteName: null }),
  setPlanSuiteNames: (planName, suiteName) => {
    set({ planName, suiteName });
    schedulePersistDraft();
  },
  setAllowCodeSearch: (v) => set({ allowCodeSearch: v }),
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
    const { requirements, changesets, attachments, attachedWorkItems, planId, suiteId, mode, allowCodeSearch, overrideModelId } = get();
    if (!requirements.trim()) {
      set({
        phase: "error",
        error: "Paste requirements first.",
        errorPhase: "validation",
      });
      return;
    }
    set({
      phase: "analyzing",
      stepLabel: "Reading suite…",
      activityLog: [],
      error: null,
      errorPhase: null,
      // A fresh analyze invalidates any prior refine snapshot — there's no
      // previous batch to restore once we kick a brand new run.
      refineUndoSnapshot: null,
    });

    // Each activity entry either appends (new id) or replaces an earlier
    // entry (same id — used when a tool_use is later completed by its
    // tool_result, carrying duration and output). The most recent entry
    // doubles as the transient stepLabel for compact displays.
    const onActivity = (entry: ActivityEntry) => {
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
    const keys = chat.apiKeys;
    // Per-generation override wins over the global default. Resetting on
    // startNew keeps each new run anchored to the latest default unless the
    // user explicitly picks a model again.
    const modelId = overrideModelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const usingClaude =
      engineSel.engine === "claude-agent-sdk" && engineSel.active;
    const { blocks: bpBlocks, warnings: bpWarnings } =
      await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
        visionCapable: usingClaude ? true : supportsVision(modelId),
      });
    if (bpWarnings.length > 0) {
      console.warn("[generator] best-practices skipped:", bpWarnings);
    }
    // #mentioned work items → read-only context blocks, merged with
    // best-practices. Fetched here (at analyze time) so the chips only hold
    // lightweight refs until they're actually needed.
    const bugBlocks =
      attachedWorkItems.length > 0
        ? await bugsToContextBlocks(attachedWorkItems.map((w) => w.id))
        : [];
    const contextBlocks = [...bpBlocks, ...bugBlocks];

    try {
      set({ stepLabel: "Calling model…" });
      let result: RunResult;
      if (usingClaude) {
        result = await runQaAnalystClaude({
          requirements,
          changesets,
          attachments,
          existingCaseTitles,
          existingCases,
          relatedCases,
          targetContext,
          mode,
          // Claude CLI only understands anthropic model ids; substitute a
          // safe default when the user's globally-selected model is from a
          // different provider so the run doesn't fail on `--model gpt-…`.
          modelId: resolveClaudeModelId(modelId) as typeof modelId,
          // Gate the agent's file-system tools behind the user's explicit
          // toggle. When off (or no source root), the CLI runs without a
          // cwd and can only reason from the spec + any inline attachments.
          sourceRoot: allowCodeSearch ? prefs.sourceRoot : null,
          authMode: engineSel.authMode ?? "api-key",
          contextBlocks,
          onActivity,
          onRunStart: (rid) => set({ activeClaudeRunId: rid }),
        });
      } else {
        result = await runQaAnalyst({
          requirements,
          changesets,
          attachments,
          existingCaseTitles,
          existingCases,
          relatedCases,
          targetContext,
          mode,
          keys,
          modelId,
          contextBlocks,
          onActivity,
        });
      }
      const cases: ReviewedCase[] = result.batch.cases.map((c) => ({
        ...c,
        uid: uid(),
        decision: "keep",
        similarMatches: findSimilarCases(c.title, existingCaseTitles),
      }));
      const bugs: ReviewedBug[] = result.batch.bugs.map((b) => ({
        ...b,
        uid: uid(),
        decision: "keep",
      }));
      // If the user cancelled while the model was running, don't drop them
      // into review — the cancel() action already moved us back to input.
      if (get().phase !== "analyzing") return;
      const runId = get().runId ?? newRunId();
      set({
        phase: "review",
        cases,
        bugs,
        rawText: result.rawText,
        durationMs: result.durationMs,
        stepLabel: "",
        runId,
        // Seed display names from the resolved target context so the tab
        // title can render "<Plan> · <Suite>" without an extra ADO fetch.
        planName: targetContext?.planName ?? null,
        suiteName: targetContext?.suiteName ?? null,
      });

      // Persist a draft snapshot as soon as we reach review so a closed
      // window or restart doesn't lose the generated cases. The publish
      // path later upserts on the same id with status=published. We embed
      // the full draft payload (cases, bugs, spec, mode) so the history
      // pane's "Open draft" action can fully restore review state.
      try {
        const s = get();
        const draftRun: GenerationRun = {
          id: runId,
          timestamp: newTimestamp(),
          planId: s.planId,
          planName: targetContext?.planName ?? null,
          suiteId: s.suiteId,
          suiteName: targetContext?.suiteName ?? null,
          mode: s.mode,
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
            mode: s.mode,
            overrideModelId: s.overrideModelId,
            cases: s.cases,
            bugs: s.bugs,
            rawText: s.rawText,
            planId: s.planId,
            planName: targetContext?.planName ?? null,
            suiteId: s.suiteId,
            suiteName: targetContext?.suiteName ?? null,
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
    } catch (e) {
      if (get().phase !== "analyzing") return;
      // Log the raw value too — `[object Object]` in the UI is a dead-end
      // for debugging; keeping the original here lets devtools surface the
      // full shape even when our stringifier had to fall back.
      console.error("[generator] analyze failed:", e);
      set({
        phase: "error",
        error: errToString(e),
        errorPhase: "analyze",
        stepLabel: "",
      });
    }
  },

  cancel: () => {
    const phase = get().phase;
    if (phase === "analyzing") {
      set({ phase: "input", stepLabel: "", error: null, errorPhase: null });
    }
  },

  tryAgain: () => {
    // Surgical reset: only the run-result + phase signals get cleared. Every
    // input-form field (requirements, attachments, plan/suite/mode, code
    // search toggle, model override) is explicitly preserved by NOT being
    // listed here. Past behavior was the same, but spelling it out makes
    // sure a future "clear X here too" never sneaks the spec out from under
    // the user.
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
          return { cases: nextCases, bugs: nextBugs };
        }
      }
      return { cases: nextCases };
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
      return {
        bugs: s.bugs.map((b) => (b.uid === uid ? { ...b, decision } : b)),
      };
    });
    schedulePersistDraft();
  },
  setBugParent: (bugUid, caseUid) => {
    set((s) => {
      const idx =
        caseUid === null ? null : s.cases.findIndex((c) => c.uid === caseUid);
      if (caseUid !== null && (idx === null || idx < 0)) return {};
      return {
        bugs: s.bugs.map((b) =>
          b.uid === bugUid
            ? { ...b, linkedDraftCaseIndex: idx ?? null }
            : b,
        ),
      };
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
        c.uid === uid ? { ...c, desiredOutcome: outcome ?? undefined } : c,
      ),
    }));
    schedulePersistDraft();
  },
  setCaseVerdict: (uid, verdict) => {
    set((s) => ({
      cases: s.cases.map((c) => (c.uid === uid ? { ...c, verdict } : c)),
    }));
    schedulePersistDraft();
  },
  setCaseStep: (uid, stepIndex, patch) => {
    set((s) => ({
      cases: s.cases.map((c) => {
        if (c.uid !== uid) return c;
        return {
          ...c,
          steps: c.steps.map((st, i) =>
            i === stepIndex ? { ...st, ...patch } : st,
          ),
        };
      }),
    }));
    schedulePersistDraft();
  },
  addCaseStep: (uid) => {
    set((s) => ({
      cases: s.cases.map((c) =>
        c.uid === uid
          ? { ...c, steps: [...c.steps, { action: "", expected: "" }] }
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
        return { ...c, steps: c.steps.filter((_, i) => i !== stepIndex) };
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

  publish: async () => {
    const { cases, bugs, planId, suiteId } = get();
    if (!planId || !suiteId) {
      set({
        phase: "error",
        error: "Pick a Test Plan and Suite first.",
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
    // Resolve the tracking branch once so published cases' code-link chips
    // point at the right branch. If the user configured `$current`, resolve to
    // the live source-dir branch instead of whatever was saved at setup time.
    // We also capture the source-dir HEAD SHA here so bug code refs can be
    // stamped with the same commit.
    let trackingBranch = "main";
    let sourceDirSha: string | null = null;
    try {
      const conn = await getConnection();
      const saved = conn.defaultTrackingBranch ?? "";
      let sourceDirBranch: string | null = null;
      const sourceRoot = usePreferencesStore.getState().sourceRoot;
      if (sourceRoot) {
        try {
          const info = await invoke<{
            branch: string | null;
            commit: string | null;
          }>("git_repo_info", { path: sourceRoot });
          sourceDirBranch = info?.branch ?? null;
          sourceDirSha = info?.commit ?? null;
        } catch {
          // If git_repo_info fails we'll fall through to the "main" fallback.
        }
      }
      trackingBranch = resolveTrackingBranch(saved, sourceDirBranch);
    } catch {
      // Non-fatal — falls back to "main".
    }

    for (const c of keptCases) {
      // Skip cases that were already published successfully — re-running
      // publish would create a duplicate work item in ADO. The row stays
      // visible in the log with its original "ok" status + result link.
      if (okByUid.has(c.uid)) continue;
      try {
        const sourceLinksBlock = renderSourceLinksBlock(
          c.sourceLinks,
          trackingBranch,
        );
        const draft: AdoDraftCase = {
          title: c.title,
          description: c.description,
          steps: c.steps.map((s, i) => ({
            index: i + 1,
            action: s.action,
            expected: s.expected,
          })),
          tags: c.tags,
          areaPath: c.areaPath ?? undefined,
          iterationPath: c.iterationPath ?? undefined,
          sourceLinksBlock,
        };
        const created = await createCaseInSuite(planId, suiteId, draft);
        caseIdByDraftUid.set(c.uid, created.id);
        updateLog(set, c.uid, { status: "ok", result: created });

        // Record the reviewer's chosen run outcome against the new case's
        // test point. ADO can briefly lag creating the point for a just-added
        // case, so retry once; on failure surface a non-fatal warning rather
        // than failing the whole publish.
        if (c.desiredOutcome) {
          try {
            let points = await listTestPoints(planId, suiteId, created.id);
            if (points.length === 0) {
              await new Promise((r) => setTimeout(r, 600));
              points = await listTestPoints(planId, suiteId, created.id);
            }
            const point = points[0];
            if (!point) throw new Error("no test point in this suite yet");
            await setTestPointOutcome({
              planId,
              suiteId,
              pointId: point.id,
              caseId: created.id,
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
      const target =
        b.linkedDraftCaseIndex !== undefined &&
        b.linkedDraftCaseIndex !== null
          ? keptCases[b.linkedDraftCaseIndex]
          : null;
      const targetCaseId = target ? caseIdByDraftUid.get(target.uid) : null;
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
          codeLinks: (b.codeRefs ?? []).map((r) => ({
            file: r.file,
            startLine: r.startLine,
            endLine: r.endLine ?? undefined,
            // Stamp the source-dir HEAD SHA so the bug's code refs survive
            // future drift the same way case source-links do. Null fallback
            // is fine — older bugs without a SHA render without the commit
            // chip in BugPane and the user can still navigate by file/line.
            commitSha: sourceDirSha,
          })),
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
      const run: GenerationRun = {
        id: s.runId ?? newRunId(),
        timestamp: newTimestamp(),
        planId: s.planId,
        // Names aren't tracked in the session yet — the history pane shows
        // ids and falls back to the plan/suite lookup if it has them cached.
        planName: null,
        suiteId: s.suiteId,
        suiteName: null,
        mode: s.mode,
        specExcerpt: specExcerpt(s.requirements ?? ""),
        cases: keptCases.map((c) => ({
          title: c.title,
          adoId: caseIdByDraftUid.get(c.uid) ?? null,
          webUrl:
            s.publishLog.find((l) => l.uid === c.uid)?.result?.webUrl ?? null,
        })),
        bugs: keptBugs.map((b) => ({
          title: b.title,
          severity: b.severity,
          adoId:
            s.publishLog.find((l) => l.uid === b.uid)?.result?.id ?? null,
          webUrl:
            s.publishLog.find((l) => l.uid === b.uid)?.result?.webUrl ?? null,
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
          mode: s.mode,
          overrideModelId: s.overrideModelId,
          cases: s.cases,
          bugs: s.bugs,
          rawText: s.rawText,
          planId: s.planId,
          planName: s.planName,
          suiteId: s.suiteId,
          suiteName: s.suiteName,
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

  reset: () => set({ ...initialState }),
  startNew: () => set({ ...initialState }),

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
    const roundStartedAt = newTimestamp();
    const beforeCases = s.cases.length;
    const beforeBugs = s.bugs.length;

    set({
      isRefining: true,
      activityLog: [],
      stepLabel: "Routing follow-up to the model…",
      error: null,
      errorPhase: null,
      refineError: null,
    });

    const onActivity = (entry: ActivityEntry) => {
      set((curr) => {
        const i = curr.activityLog.findIndex((e) => e.id === entry.id);
        const next = curr.activityLog.slice();
        if (i >= 0) {
          next[i] = { ...next[i], ...entry };
        } else {
          next.push(entry);
        }
        return { activityLog: next, stepLabel: entryToLabel(entry) };
      });
    };

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
      mode: s.mode,
      targetContext,
      relatedCases,
      keptCases,
      skippedCases,
      keptBugs,
      skippedBugs,
      instruction: text,
    });

    const chat = useChatStore.getState();
    const keys = chat.apiKeys;
    const modelId = s.overrideModelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const usingClaude =
      engineSel.engine === "claude-agent-sdk" && engineSel.active;
    const { blocks: bpBlocks, warnings: bpWarnings } =
      await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
        visionCapable: usingClaude ? true : supportsVision(modelId),
      });
    if (bpWarnings.length > 0) {
      console.warn("[generator] best-practices skipped:", bpWarnings);
    }
    // Attach any #id-mentioned work items as read-only grounding context.
    const bugBlocks =
      workItemIds && workItemIds.length > 0
        ? await bugsToContextBlocks(workItemIds)
        : [];
    const contextBlocks = [...bpBlocks, ...bugBlocks];

    try {
      let result: RunResult;
      if (usingClaude) {
        result = await runQaAnalystClaude({
          requirements: s.requirements,
          attachments: s.attachments,
          existingCaseTitles: [],
          relatedCases,
          targetContext,
          mode: s.mode,
          modelId: resolveClaudeModelId(modelId) as typeof modelId,
          sourceRoot: s.allowCodeSearch ? prefs.sourceRoot : null,
          authMode: engineSel.authMode ?? "api-key",
          contextBlocks,
          onActivity,
          userPromptOverride: userPrompt,
          // Hand the runId up to the store so cancelRefine() has a target
          // to signal. Without this an ESC press would only un-stick the UI
          // — the subprocess would keep burning model tokens in the
          // background until it finished on its own.
          onRunStart: (rid) => set({ activeClaudeRunId: rid }),
        });
      } else {
        result = await runQaAnalyst({
          requirements: s.requirements,
          attachments: s.attachments,
          existingCaseTitles: [],
          relatedCases,
          targetContext,
          mode: s.mode,
          keys,
          modelId,
          contextBlocks,
          onActivity,
          userPromptOverride: userPrompt,
        });
      }

      // Bail out gracefully when the model returned nothing structured —
      // better to keep the user's existing batch than to wipe it for an
      // empty refine response. Surface inline so the user stays in review.
      if (
        result.batch.cases.length === 0 &&
        result.batch.bugs.length === 0
      ) {
        set((curr) => ({
          isRefining: false,
          stepLabel: "",
          refineError:
            "The model returned an empty refine result — your previous draft is unchanged. Try a more specific instruction.",
          refineRounds: [
            ...curr.refineRounds,
            {
              timestamp: roundStartedAt,
              instruction: text,
              activityLog: curr.activityLog,
              beforeCases,
              afterCases: beforeCases,
              beforeBugs,
              afterBugs: beforeBugs,
              outcome: "empty",
            },
          ],
        }));
        schedulePersistDraft();
        return;
      }

      const nextCases: ReviewedCase[] = result.batch.cases.map((c) => ({
        ...c,
        uid: uid(),
        decision: "keep",
        // Similarity is computed against ADO-side existing cases, not the
        // in-session draft. Reusing the snapshot's matches would be wrong;
        // leaving empty is the honest default until an ADO refresh runs.
        similarMatches: [],
      }));
      const nextBugs: ReviewedBug[] = result.batch.bugs.map((b) => ({
        ...b,
        uid: uid(),
        decision: "keep",
      }));

      set((curr) => ({
        isRefining: false,
        cases: nextCases,
        bugs: nextBugs,
        rawText: result.rawText,
        stepLabel: "",
        refineUndoSnapshot: snapshot,
        // Record the prompt in history (newest first, dedup'd, capped).
        refineHistory: [
          text,
          ...curr.refineHistory.filter((p) => p !== text),
        ].slice(0, REFINE_HISTORY_MAX),
        // And record the structured round so the user can later read
        // back the thinking process behind why the draft looks like
        // this. Survives a window close via the draft autosave path.
        refineRounds: [
          ...curr.refineRounds,
          {
            timestamp: roundStartedAt,
            instruction: text,
            activityLog: curr.activityLog,
            beforeCases,
            afterCases: nextCases.length,
            beforeBugs,
            afterBugs: nextBugs.length,
            outcome: "ok",
          },
        ],
      }));
      schedulePersistDraft();
    } catch (e) {
      // Refine errors stay inside the review phase — wiping the user back to
      // the input screen would lose their draft, which is exactly what they
      // were trying to refine. Surface the error inline; the user can read
      // it, fix the underlying issue, and try again.
      const cancelled =
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: string }).kind === "cancelled";
      if (!cancelled) {
        console.error("[generator] refine failed:", e);
      }
      const errorText = cancelled ? "" : errToString(e);
      set((curr) => ({
        isRefining: false,
        activeClaudeRunId: null,
        stepLabel: "",
        // Cancelled runs don't leave a banner — the user asked to abort, so
        // showing them an error after they pressed ESC is hostile UX.
        refineError: cancelled ? null : errorText,
        refineRounds: [
          ...curr.refineRounds,
          {
            timestamp: roundStartedAt,
            instruction: text,
            activityLog: curr.activityLog,
            beforeCases,
            afterCases: beforeCases,
            beforeBugs,
            afterBugs: beforeBugs,
            outcome: cancelled ? "empty" : "failed",
            error: cancelled ? "Cancelled before completion." : errorText,
          },
        ],
      }));
      schedulePersistDraft();
    } finally {
      set({ activeClaudeRunId: null });
    }
  },

  cancelRefine: () => {
    const { activeClaudeRunId, isRefining } = get();
    if (!isRefining) return;
    if (activeClaudeRunId) {
      // Fire-and-forget — the Rust side notifies the run task, which kills
      // the child and resolves the in-flight runQaAnalystClaude promise
      // with a Cancelled error. Our catch above handles the rest.
      void cancelClaudeRun(activeClaudeRunId).catch(() => {
        // Even if the IPC fails, the local catch path will eventually
        // settle the run; flipping isRefining here is a safety net so the
        // UI doesn't appear stuck.
        set({ isRefining: false, activeClaudeRunId: null, stepLabel: "" });
      });
    } else {
      // No subprocess to kill (e.g. Vercel SDK path mid-flight) — just
      // un-stick the UI; the in-flight promise will still complete but its
      // result handler is guarded by isRefining checks downstream.
      set({ isRefining: false, stepLabel: "" });
    }
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

    const appendDelta = (delta: string) =>
      set((curr) => ({
        chatMessages: curr.chatMessages.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        ),
      }));

    // Tool activity onto the assistant chat message, upserting by id.
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
    const keys = chat.apiKeys;
    const modelId = s.overrideModelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const usingClaude =
      engineSel.engine === "claude-agent-sdk" && engineSel.active;
    const { blocks: bpBlocks, warnings: bpWarnings } =
      await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
        visionCapable: usingClaude ? true : supportsVision(modelId),
      });
    if (bpWarnings.length > 0) {
      console.warn("[generator] best-practices skipped:", bpWarnings);
    }
    const bugBlocks =
      bugIds && bugIds.length > 0 ? await bugsToContextBlocks(bugIds) : [];
    const chatContextBlocks = [...bpBlocks, ...bugBlocks];

    try {
      if (usingClaude) {
        const runId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        set({ chatActiveClaudeRunId: runId });
        await streamQaChatClaude({
          runId,
          requirements: s.requirements,
          changesets: s.changesets,
          attachments: s.attachments,
          cases: s.cases,
          bugs: s.bugs,
          targetContext: null,
          history: priorHistory,
          newQuestion: text,
          modelId: resolveClaudeModelId(modelId) as typeof modelId,
          sourceRoot: s.allowCodeSearch ? prefs.sourceRoot : null,
          authMode: engineSel.authMode ?? "api-key",
          contextBlocks: chatContextBlocks,
          onText: appendDelta,
          onToolEvent: mergeToolEvent,
        });
      } else {
        await streamQaChat({
          requirements: s.requirements,
          changesets: s.changesets,
          attachments: s.attachments,
          cases: s.cases,
          bugs: s.bugs,
          targetContext: null,
          history: priorHistory,
          newQuestion: text,
          keys,
          modelId,
          contextBlocks: chatContextBlocks,
          onText: appendDelta,
        });
      }
      // Backfill a placeholder for a genuinely empty response so the bubble
      // doesn't render blank.
      set((curr) => ({
        chatBusy: false,
        chatActiveClaudeRunId: null,
        chatStreamingId: null,
        chatMessages: curr.chatMessages.map((m) =>
          m.id === assistantId && m.content.trim() === ""
            ? { ...m, content: "(empty response)" }
            : m,
        ),
      }));
    } catch (e) {
      const cancelled =
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: string }).kind === "cancelled";
      if (!cancelled) console.error("[generator] chat failed:", e);
      // Drop the placeholder if nothing streamed (keep a partial answer on
      // cancel — that text is still useful to the user).
      set((curr) => ({
        chatBusy: false,
        chatActiveClaudeRunId: null,
        chatStreamingId: null,
        chatMessages: curr.chatMessages.filter(
          (m) => m.id !== assistantId || m.content.trim() !== "",
        ),
        chatError: cancelled ? null : errToString(e),
      }));
    }
  },

  cancelChat: () => {
    const { chatActiveClaudeRunId, chatBusy } = get();
    if (!chatBusy) return;
    if (chatActiveClaudeRunId) {
      void cancelClaudeRun(chatActiveClaudeRunId).catch(() => {
        set({ chatBusy: false, chatActiveClaudeRunId: null });
      });
    } else {
      // No subprocess to kill (Vercel SDK path). The promise will still
      // resolve; the result handler runs but chatBusy is already false.
      set({ chatBusy: false });
    }
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
      mode: payload.mode ?? "thorough",
      overrideModelId: payload.overrideModelId ?? null,
      cases: payload.cases ?? [],
      bugs: payload.bugs ?? [],
      rawText: payload.rawText ?? "",
      planId: payload.planId ?? run.planId ?? null,
      suiteId: payload.suiteId ?? run.suiteId ?? null,
      // Restore the cached display names so the reopened tab's title
      // doesn't briefly say "Generate cases" before re-resolving.
      planName: payload.planName ?? run.planName ?? null,
      suiteName: payload.suiteName ?? run.suiteName ?? null,
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
      mode: payload?.mode ?? "thorough",
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

function renderSourceLinksBlock(
  links: DraftSourceLink[] | undefined,
  trackingBranch: string,
): string | null {
  if (!links || links.length === 0) return null;
  const sl: SourceLink[] = links.map((l) => ({
    repoId: l.repoId ?? l.repoName,
    repoName: l.repoName,
    filePath: l.filePath,
    symbol: l.symbol ?? undefined,
    lineRange: l.lineRange ?? undefined,
    generationBranch: trackingBranch,
    generationSha: "",
    trackingBranch,
  }));
  return renderBlock(sl);
}

/** Resolve plan + suite metadata into the structured TargetContext that the
 *  analyst engines embed at the top of the user prompt. Walks the suite tree
 *  to build the parent path so the model sees "Auth › Sign-in › 2FA" instead
 *  of an orphan suite id. */
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
  return {
    planId,
    planName: plan?.name ?? null,
    suiteId,
    suiteName: suite?.name ?? null,
    suitePath: path,
    areaPath: plan?.areaPath ?? null,
    iterationPath: plan?.iteration ?? null,
  };
}

/** ADO Rust commands and the Claude CLI bridge both reject with discriminated
 *  unions tagged by `kind`, but the sets of kinds are disjoint and need
 *  different formatters. Anything we don't recognise gets a best-effort
 *  serialization so the error UI never shows "[object Object]". */
const CLAUDE_ERROR_KINDS = new Set([
  "not-installed",
  "non-zero-exit",
  "api-error",
  "spawn-failed",
  "cancelled",
]);

function errToString(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "Error";
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      // Claude CLI errors carry kinds the ADO formatter doesn't know about
      // — route them to the matching formatter before the ADO fallback runs
      // and returns undefined.
      if (CLAUDE_ERROR_KINDS.has(obj.kind)) {
        return claudeErrorMessage(e);
      }
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
