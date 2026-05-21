import { create } from "zustand";
import {
  adoErrorMessage,
  createCaseInSuite,
  createBugAndLink,
  getConnection,
  indexCaseLinks,
  listSuiteCases,
  toAdoError,
  type AdoError,
  type CreatedWorkItem,
  type DraftCase as AdoDraftCase,
} from "@/modules/ado";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  type GenerationMode as Mode,
  type RunResult,
  runQaAnalyst,
} from "../lib/qaAnalystRun";
import { runQaAnalystClaude } from "../lib/qaAnalystRunClaude";
import { selectEngine } from "@/modules/ai/lib/engine";
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

export type SessionState = {
  phase: Phase;
  // Input phase
  requirements: string;
  attachments: Array<{ path: string; content: string }>;
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
  durationMs: number | null;
  // Review
  cases: ReviewedCase[];
  bugs: ReviewedBug[];
  rawText: string;
  // Publishing
  publishLog: PublishLogEntry[];
  // Error
  error: AdoError | string | null;

  setRequirements: (s: string) => void;
  setMode: (m: GenerationMode) => void;
  setTarget: (planId: number | null, suiteId: number | null) => void;
  setAllowCodeSearch: (v: boolean) => void;
  addAttachment: (path: string, content: string) => void;
  removeAttachment: (path: string) => void;
  analyze: () => Promise<void>;
  /** Cancel an in-flight analyze and return to the input phase. The model
   *  request itself is not aborted (provider SDKs don't all support it) —
   *  this just dumps the result instead of moving to review. */
  cancel: () => void;
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
  | "removeAttachment"
  | "analyze"
  | "cancel"
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
  durationMs: null,
  cases: [],
  bugs: [],
  rawText: "",
  publishLog: [],
  error: null,
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
      return { attachments: [...s.attachments, { path, content }] };
    }),
  removeAttachment: (path) =>
    set((s) => ({
      attachments: s.attachments.filter((a) => a.path !== path),
    })),

  analyze: async () => {
    const { requirements, attachments, planId, suiteId, mode, allowCodeSearch } = get();
    if (!requirements.trim()) {
      set({ phase: "error", error: "Paste requirements first." });
      return;
    }
    set({ phase: "analyzing", stepLabel: "Reading suite…", error: null });

    let existingCaseTitles: { id: number; title: string }[] = [];
    if (planId && suiteId) {
      try {
        existingCaseTitles = (await listSuiteCases(planId, suiteId)).map(
          (c) => ({ id: c.id, title: c.title }),
        );
      } catch (e) {
        // Non-fatal — duplicate detection just won't fire.
        console.warn("[generator] couldn't load existing cases:", e);
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
          mode,
          modelId,
          // Gate the agent's file-system tools behind the user's explicit
          // toggle. When off (or no source root), the CLI runs without a
          // cwd and can only reason from the spec + any inline attachments.
          sourceRoot: allowCodeSearch ? prefs.sourceRoot : null,
          authMode: engineSel.authMode ?? "api-key",
          onStep: (label) => set({ stepLabel: label }),
        });
      } else {
        result = await runQaAnalyst({
          requirements,
          attachments,
          existingCaseTitles,
          mode,
          keys,
          modelId,
          onStep: (label) => set({ stepLabel: label }),
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
        stepLabel: "",
      });
    }
  },

  cancel: () => {
    const phase = get().phase;
    if (phase === "analyzing") {
      set({ phase: "input", stepLabel: "", error: null });
    }
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
      set({ phase: "error", error: "Pick a Test Plan and Suite first." });
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

function errToString(e: unknown): string {
  if (e && typeof e === "object" && "kind" in (e as Record<string, unknown>)) {
    return adoErrorMessage(toAdoError(e));
  }
  return e instanceof Error ? e.message : String(e);
}
