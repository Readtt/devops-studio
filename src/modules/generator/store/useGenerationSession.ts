import { create } from "zustand";
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
import { renderBlock } from "@/modules/test-plans/lib/sourceLinksParser";
import type { SourceLink } from "@/modules/ado";
import {
  newRunId,
  newTimestamp,
  saveRun,
  specExcerpt,
  type GenerationRun,
} from "../lib/history";
import { entryToLabel, type ActivityEntry } from "../lib/activityLog";

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
  // Analyzing
  stepLabel: string;
  /** Streaming activity from the analyst engines: tool calls, results, and
   *  thinking steps. The AnalyzingPhase renders this as a log so the user
   *  can see what the agent is doing (which files it read, what it grepped). */
  activityLog: ActivityEntry[];
  durationMs: number | null;
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
  publish: () => Promise<void>;
  reset: () => void;
  startNew: () => void;
};

let uidCounter = 0;
const uid = () => `u${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

const initialState: Omit<
  SessionState,
  | "setRequirements"
  | "setMode"
  | "setTarget"
  | "setAllowCodeSearch"
  | "addAttachment"
  | "addRichAttachment"
  | "removeAttachment"
  | "analyze"
  | "cancel"
  | "tryAgain"
  | "setCaseDecision"
  | "setBugDecision"
  | "publish"
  | "reset"
  | "startNew"
> = {
  phase: "input",
  requirements: "",
  attachments: [],
  planId: null,
  suiteId: null,
  mode: "thorough",
  allowCodeSearch: true,
  stepLabel: "",
  activityLog: [],
  durationMs: null,
  cases: [],
  bugs: [],
  rawText: "",
  publishLog: [],
  error: null,
  errorPhase: null,
};

export const useGenerationSession = create<SessionState>((set, get) => ({
  ...initialState,

  setRequirements: (s) => set({ requirements: s }),
  setMode: (m) => set({ mode: m }),
  setTarget: (planId, suiteId) => set({ planId, suiteId }),
  setAllowCodeSearch: (v) => set({ allowCodeSearch: v }),
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
    const { requirements, attachments, planId, suiteId, mode, allowCodeSearch } = get();
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
    }

    const chat = useChatStore.getState();
    const keys = chat.apiKeys;
    const modelId = chat.selectedModelId;
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
      set({
        phase: "review",
        cases,
        bugs,
        rawText: result.rawText,
        durationMs: result.durationMs,
        stepLabel: "",
      });
    } catch (e) {
      if (get().phase !== "analyzing") return;
      set({
        phase: "error",
        error: e instanceof Error ? e.message : String(e),
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
    // Return to input keeping requirements / plan / suite / mode / attachments
    // intact so the user can fix whatever caused the error (missing key,
    // wrong target) without re-pasting their spec.
    set({ phase: "input", error: null, errorPhase: null, stepLabel: "" });
  },

  setCaseDecision: (uid, decision) =>
    set((s) => ({
      cases: s.cases.map((c) => (c.uid === uid ? { ...c, decision } : c)),
    })),
  setBugDecision: (uid, decision) =>
    set((s) => ({
      bugs: s.bugs.map((b) => (b.uid === uid ? { ...b, decision } : b)),
    })),

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
          codeLinks: [],
        });
        updateLog(set, b.uid, { status: "ok", result: created });
      } catch (e) {
        updateLog(set, b.uid, { status: "failed", error: errToString(e) });
      }
    }

    set({ phase: "done" });

    // Persist a snapshot of the run so the user can revisit it from the
    // Generation history sidebar tab. Best-effort: failures here don't fail
    // the publish flow.
    try {
      const s = get();
      const run: GenerationRun = {
        id: newRunId(),
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
      };
      void saveRun(run);
    } catch {
      // Persisting is non-essential — the run still completed.
    }
  },

  reset: () => set({ ...initialState }),
  startNew: () => set({ ...initialState }),
}));

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

function errToString(e: unknown): string {
  if (e && typeof e === "object" && "kind" in (e as Record<string, unknown>)) {
    return adoErrorMessage(toAdoError(e));
  }
  return e instanceof Error ? e.message : String(e);
}
