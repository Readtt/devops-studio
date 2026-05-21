import { createContext, createElement, useContext } from "react";
import type { ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import {
  adoErrorMessage,
  createCaseInSuite,
  createBugAndLink,
  getConnection,
  indexCaseLinks,
  listPlans,
  listSuiteCases,
  listSuites,
  toAdoError,
  type AdoError,
  type CreatedWorkItem,
  type DraftCase as AdoDraftCase,
  type SuiteRef,
  type TestPlanRef,
} from "@/modules/ado";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { claudeErrorMessage } from "@/modules/ai/lib/claude";
import {
  type GenerationMode as Mode,
  type RunResult,
  type TargetContext,
  runQaAnalyst,
} from "../lib/qaAnalystRun";
import { runQaAnalystClaude } from "../lib/qaAnalystRunClaude";
import { resolveClaudeModelId, selectEngine } from "@/modules/ai/lib/engine";
import {
  isDynamicTrackingBranch,
  resolveTrackingBranch,
} from "@/modules/git";
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

import type { ModelId } from "@/modules/ai/config";

export type AttachmentKind = "text" | "image" | "binary";

export type Attachment = {
  /** Display name. For dropped files this is the original filename; for
   *  clipboard images we synthesize "pasted-<timestamp>.<ext>". */
  path: string;
  /** Text content for kind="text"; base64 data URL for kind="image"; empty
   *  string for kind="binary" (we don't ship binary blobs through the LLM,
   *  only the filename is surfaced). */
  content: string;
  kind: AttachmentKind;
  mime?: string;
  sizeBytes?: number;
};

export type SessionState = {
  phase: Phase;
  // Input phase
  requirements: string;
  attachments: Attachment[];
  planId: number | null;
  suiteId: number | null;
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
  setMode: (m: GenerationMode) => void;
  setTarget: (planId: number | null, suiteId: number | null) => void;
  setAllowCodeSearch: (v: boolean) => void;
  /** Set or clear (null) the per-generation model override. */
  setOverrideModelId: (id: ModelId | null) => void;
  /** Add a text attachment. Convenience wrapper around `addRichAttachment`
   *  for the existing single-string-content callers. */
  addAttachment: (path: string, content: string) => void;
  /** Add an attachment of any supported kind. Dedups by `path`. */
  addRichAttachment: (attachment: Attachment) => void;
  removeAttachment: (path: string) => void;
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
  refine: (instruction: string) => Promise<void>;
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
  reset: () => void;
  startNew: () => void;
  /** Hydrate the session from a saved draft history row. Returns true when
   *  the row carried a full draft payload (so the caller can confirm the
   *  open-in-review action actually worked). Returns false for legacy rows
   *  that only persisted titles — those can't be restored to review. */
  loadDraft: (run: GenerationRun) => boolean;
};

let uidCounter = 0;
const uid = () => `u${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

const initialState: Omit<
  SessionState,
  | "setRequirements"
  | "setMode"
  | "setTarget"
  | "setAllowCodeSearch"
  | "setOverrideModelId"
  | "addAttachment"
  | "addRichAttachment"
  | "removeAttachment"
  | "analyze"
  | "cancel"
  | "tryAgain"
  | "setCaseDecision"
  | "setBugDecision"
  | "setBugParent"
  | "setCaseTitle"
  | "setCaseRationale"
  | "setCaseStep"
  | "addCaseStep"
  | "removeCaseStep"
  | "setBugTitle"
  | "setBugReproSteps"
  | "publish"
  | "reset"
  | "startNew"
  | "loadDraft"
  | "refine"
  | "undoRefine"
  | "dismissRefineError"
  | "goToInput"
  | "goToReview"
> = {
  phase: "input",
  requirements: "",
  attachments: [],
  planId: null,
  suiteId: null,
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
  refineUndoSnapshot: null,
  refineError: null,
  refineHistory: [],
  refineRounds: [],
};

const REFINE_HISTORY_MAX = 12;

/** Debounce window for auto-persisting draft edits. Snappy enough that a
 *  close-the-window after a single edit is safe; long enough that
 *  typing-through-a-textarea doesn't hammer the Rust history store. */
const DRAFT_AUTOSAVE_MS = 350;

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
        planName: null,
        suiteId: s.suiteId,
        suiteName: null,
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
          mode: s.mode,
          cases: s.cases,
          bugs: s.bugs,
          rawText: s.rawText,
          planId: s.planId,
          suiteId: s.suiteId,
          refineRounds: s.refineRounds,
        },
      };
      void saveRun(run);
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
  setMode: (m) => set({ mode: m }),
  setTarget: (planId, suiteId) => set({ planId, suiteId }),
  setAllowCodeSearch: (v) => set({ allowCodeSearch: v }),
  setOverrideModelId: (id) => set({ overrideModelId: id }),
  addAttachment: (path, content) =>
    set((s) => {
      if (s.attachments.some((a) => a.path === path)) return s;
      return {
        attachments: [
          ...s.attachments,
          {
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
      // Replace on duplicate path so re-pasting a file gets the latest copy
      // instead of silently being ignored.
      const without = s.attachments.filter((a) => a.path !== attachment.path);
      return { attachments: [...without, attachment] };
    }),
  removeAttachment: (path) =>
    set((s) => ({
      attachments: s.attachments.filter((a) => a.path !== path),
    })),

  analyze: async () => {
    const { requirements, attachments, planId, suiteId, mode, allowCodeSearch, overrideModelId } = get();
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

    try {
      set({ stepLabel: "Calling model…" });
      let result: RunResult;
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
        result = await runQaAnalystClaude({
          requirements,
          attachments,
          existingCaseTitles,
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
          onActivity,
        });
      } else {
        result = await runQaAnalyst({
          requirements,
          attachments,
          existingCaseTitles,
          relatedCases,
          targetContext,
          mode,
          keys,
          modelId,
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
            mode: s.mode,
            cases: s.cases,
            bugs: s.bugs,
            rawText: s.rawText,
            planId: s.planId,
            planName: targetContext?.planName ?? null,
            suiteId: s.suiteId,
            suiteName: targetContext?.suiteName ?? null,
            refineRounds: s.refineRounds,
          },
        };
        void saveRun(draftRun);
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
    const log: PublishLogEntry[] = [
      ...keptCases.map<PublishLogEntry>((c) => ({
        uid: c.uid,
        kind: "case",
        title: c.title,
        status: "pending",
      })),
      ...keptBugs.map<PublishLogEntry>((b) => ({
        uid: b.uid,
        kind: "bug",
        title: b.title,
        status: "pending",
      })),
    ];
    set({ phase: "publishing", publishLog: log });

    const caseIdByDraftUid = new Map<string, number>();
    // Pull the default tracking branch once for staleness baselines. If the
    // user configured `$current`, resolve to the live source-dir branch so
    // each generation is indexed on the branch the user is actually working
    // on, not whatever was saved at setup time.
    let trackingBranch = "main";
    try {
      const conn = await getConnection();
      const saved = conn.defaultTrackingBranch ?? "";
      let sourceDirBranch: string | null = null;
      if (isDynamicTrackingBranch(saved)) {
        const sourceRoot = usePreferencesStore.getState().sourceRoot;
        if (sourceRoot) {
          try {
            const info = await invoke<{ branch: string | null }>(
              "git_repo_info",
              { path: sourceRoot },
            );
            sourceDirBranch = info?.branch ?? null;
          } catch {
            // If git_repo_info fails we'll fall through to the "main" fallback.
          }
        }
      }
      trackingBranch = resolveTrackingBranch(saved, sourceDirBranch);
    } catch {
      // Non-fatal — falls back to "main".
    }

    for (const c of keptCases) {
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

        // Populate the staleness index for future scans. The case itself
        // succeeded — if indexing fails we keep the publish "ok" but surface
        // the indexing miss as an inline warning on the log entry so the
        // user knows staleness won't track this case until they re-publish.
        if (c.sourceLinks.length > 0) {
          try {
            await indexCaseLinks(
              created.id,
              c.sourceLinks.map((l) => ({
                repoId: l.repoId ?? l.repoName,
                branch: trackingBranch,
                filePath: l.filePath,
                symbol: l.symbol ?? undefined,
              })),
            );
          } catch (e) {
            updateLog(set, c.uid, {
              error: `Published, but staleness indexing failed: ${errToString(e)}`,
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
            commitSha: null,
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
      };
      void saveRun(run);
    } catch {
      // Persisting is non-essential — the run still completed.
    }
  },

  reset: () => set({ ...initialState }),
  startNew: () => set({ ...initialState }),

  refine: async (instruction: string) => {
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

    try {
      let result: RunResult;
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
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
          onActivity,
          userPromptOverride: userPrompt,
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
      console.error("[generator] refine failed:", e);
      const errorText = errToString(e);
      set((curr) => ({
        isRefining: false,
        stepLabel: "",
        refineError: errorText,
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
            outcome: "failed",
            error: errorText,
          },
        ],
      }));
      schedulePersistDraft();
    }
  },

  dismissRefineError: () => set({ refineError: null }),

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
      mode: payload.mode ?? "thorough",
      cases: payload.cases ?? [],
      bugs: payload.bugs ?? [],
      rawText: payload.rawText ?? "",
      planId: payload.planId ?? run.planId ?? null,
      suiteId: payload.suiteId ?? run.suiteId ?? null,
      runId: run.id,
      refineRounds: rounds,
      refineHistory: refineHistoryFromRounds,
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
