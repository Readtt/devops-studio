// Global store driving the "Run confidence on all cases" bulk operation and its
// bottom-left progress capsule. It lives at module scope (like useTestPlans) so
// a run survives TestPlansPanel unmounts and pane restructures — the capsule
// keeps counting even if the user navigates away.
//
// Flow: start() does discovery (list cases → skip already-scored → large-suite
// confirm gate), then runBatch() iterates via scoreCases(). The AbortController
// and the auto-dismiss timer live outside the store, mirroring useTestPlans's
// module-level abort maps.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listSuiteCases } from "@/modules/ado";
import { hasKeyForModel } from "@/modules/ai";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { primaryRepoRoot } from "@/modules/settings/store";
import type { GitRepoInfo } from "@/modules/git";
import { getConfidenceMany } from "../lib/confidenceApi";
import { verdictSourceState, type ConfidenceVerdict } from "../lib/confidence";
import { scoreCases, type ScoreTarget } from "../lib/runSuiteConfidence";

/** Live source-dir HEAD short sha (when code search is on and it's a repo), for
 *  deciding which stored verdicts are stale before a bulk run. Best-effort. */
async function currentSourceSha(): Promise<string | null> {
  const prefs = usePreferencesStore.getState();
  const root = prefs.codeSearchEnabled ? primaryRepoRoot(prefs.repos) : null;
  if (!root) return null;
  try {
    const info = await invoke<GitRepoInfo>("git_repo_info", { path: root });
    return info.commit ?? null;
  } catch {
    return null;
  }
}

/** Suites larger than this prompt for confirmation before spending tokens. */
export const LARGE_SUITE_THRESHOLD = 20;

export type ScoreFailure = { caseId: number; title: string; message: string };

/** A discovered batch waiting on the user's confirm (large-suite gate). */
export type PendingConfirm = {
  planId: number;
  suiteId: number;
  suiteName: string | null;
  targets: ScoreTarget[];
};

type Phase = "idle" | "discovering" | "scoring" | "done";

type State = {
  phase: Phase;
  suiteName: string | null;
  total: number;
  done: number;
  currentTitle: string | null;
  failures: ScoreFailure[];
  /** Terminal one-liner ("Every case already scored", key missing, …). */
  notice: string | null;
  pendingConfirm: PendingConfirm | null;
  /** Verdicts produced during the current run, keyed by case id. An open
   *  TestCasePane subscribes to its own id here and updates the instant its case
   *  is scored — no reopen, no SQLite round-trip. */
  scored: Map<number, ConfidenceVerdict>;
  /** Case ids currently being evaluated by ANY surface (bulk run or a manual
   *  re-analyze). The shared lock that stops the same case being scored twice at
   *  once. TestCasePane subscribes to its own id to reflect "being scored". */
  inFlight: Set<number>;

  /** Kick off discovery for a suite (no-op if a run/confirm is already live). */
  start: (planId: number, suiteId: number, suiteName: string | null) => Promise<void>;
  /** Proceed with a confirmed large batch. */
  confirmPending: () => void;
  /** Dismiss the large-suite confirm without running. */
  cancelPending: () => void;
  /** Abort an in-flight run. */
  cancel: () => void;
  /** Clear the finished/notice capsule. */
  dismiss: () => void;
  /** Reserve a case for evaluation; false if another evaluation already owns it.
   *  Shared by the bulk run and TestCasePane's manual re-analyze. */
  beginCaseEval: (caseId: number) => boolean;
  /** Release a reservation taken by beginCaseEval. */
  endCaseEval: (caseId: number) => void;
};

// --- Module-level run state (survives React, like useTestPlans's aborts) ----
let bulkAbort: AbortController | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic run id: a cancelled-then-restarted run must not let stragglers from
// the old run mutate the new run's progress.
let runSeq = 0;

function clearDismiss() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

/** Auto-clear a terminal capsule after a few seconds (only if still terminal). */
function scheduleDismiss() {
  clearDismiss();
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (useSuiteConfidence.getState().phase === "done") {
      useSuiteConfidence.getState().dismiss();
    }
  }, 4500);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function finishWithNotice(suiteName: string | null, notice: string) {
  useSuiteConfidence.setState({
    phase: "done",
    suiteName,
    total: 0,
    done: 0,
    currentTitle: null,
    failures: [],
    notice,
    pendingConfirm: null,
  });
  scheduleDismiss();
}

/** Score a resolved target list, wiring progress into the store. */
async function runBatch(
  suiteName: string | null,
  targets: ScoreTarget[],
  target: { planId: number; suiteId: number },
) {
  clearDismiss();
  const myRun = ++runSeq;
  const ac = new AbortController();
  bulkAbort = ac;
  // Ignore any straggler callbacks from a previous (cancelled) run.
  const live = () => runSeq === myRun;
  const bump = () => useSuiteConfidence.setState((s) => ({ done: s.done + 1 }));

  useSuiteConfidence.setState({
    phase: "scoring",
    suiteName,
    total: targets.length,
    done: 0,
    currentTitle: null,
    failures: [],
    notice: null,
    pendingConfirm: null,
    scored: new Map(),
  });

  await scoreCases(targets, {
    signal: ac.signal,
    claim: (id) => useSuiteConfidence.getState().beginCaseEval(id),
    release: (id) => useSuiteConfidence.getState().endCaseEval(id),
    onCaseStart: (_id, title) => {
      if (live()) useSuiteConfidence.setState({ currentTitle: title });
    },
    onCaseDone: (caseId, verdict) => {
      if (!live()) return;
      useSuiteConfidence.setState((s) => ({
        done: s.done + 1,
        // New Map each time so the per-case selector in TestCasePane fires.
        scored: new Map(s.scored).set(caseId, verdict),
      }));
    },
    onCaseSkip: () => {
      if (live()) bump();
    },
    onCaseFailure: (caseId, title, error) => {
      if (!live()) return;
      useSuiteConfidence.setState((s) => ({
        done: s.done + 1,
        failures: [...s.failures, { caseId, title, message: errMsg(error) }],
      }));
    },
  }, target);

  if (bulkAbort === ac) bulkAbort = null;
  // cancel() flips phase to "idle"; only finalize if this run still owns it.
  if (live() && useSuiteConfidence.getState().phase === "scoring") {
    useSuiteConfidence.setState({ phase: "done", currentTitle: null });
    scheduleDismiss();
  }
}

export const useSuiteConfidence = create<State>((set, get) => ({
  phase: "idle",
  suiteName: null,
  total: 0,
  done: 0,
  currentTitle: null,
  failures: [],
  notice: null,
  pendingConfirm: null,
  scored: new Map(),
  inFlight: new Set(),

  start: async (planId, suiteId, suiteName) => {
    const s = get();
    if (s.phase === "discovering" || s.phase === "scoring" || s.pendingConfirm) {
      return; // one batch at a time
    }
    clearDismiss();

    // Pre-flight: don't launch a doomed batch of N key-error failures. Await
    // key hydration first so a cold-start run doesn't false-negative on the
    // all-null placeholder (the run engine reads the same store).
    await useChatStore.getState().ensureApiKeys();
    if (!hasKeyForModel(useChatStore.getState().selectedModelId)) {
      finishWithNotice(
        suiteName,
        "No API key for the selected model — add one in Settings → Models.",
      );
      return;
    }

    set({
      phase: "discovering",
      suiteName,
      total: 0,
      done: 0,
      currentTitle: null,
      failures: [],
      notice: null,
      pendingConfirm: null,
    });

    let targets: ScoreTarget[];
    let totalCases: number;
    try {
      const refs = await listSuiteCases(planId, suiteId);
      totalCases = refs.length;
      const existing = await getConfidenceMany(refs.map((r) => r.id));
      // A bulk run should leave the suite scored against the CURRENT source.
      // Skip a case only when its stored verdict was graded against the code
      // that's checked out now (fresh), or when we can't tell (a legacy verdict
      // with no source stamp, or no repo) — never silently keep a verdict we can
      // prove was graded against a different branch / older commit.
      const currentSha = await currentSourceSha();
      targets = refs
        .filter((r) => {
          const v = existing.get(r.id);
          if (!v) return true; // never scored
          return verdictSourceState(v, currentSha).kind === "stale";
        })
        .map((r) => ({ id: r.id, title: r.title }));
    } catch {
      finishWithNotice(suiteName, "Couldn't load this suite's cases.");
      return;
    }

    // Cancelled while discovery was in flight — don't kick off a run.
    if (get().phase !== "discovering") return;

    if (totalCases === 0) {
      finishWithNotice(suiteName, "This suite has no cases to score.");
      return;
    }

    if (targets.length === 0) {
      finishWithNotice(suiteName, "Every case in this suite is already scored.");
      return;
    }

    if (targets.length > LARGE_SUITE_THRESHOLD) {
      // Park the resolved batch and wait for the confirm dialog.
      set({
        phase: "idle",
        pendingConfirm: { planId, suiteId, suiteName, targets },
      });
      return;
    }

    await runBatch(suiteName, targets, { planId, suiteId });
  },

  confirmPending: () => {
    const p = get().pendingConfirm;
    if (!p) return;
    set({ pendingConfirm: null });
    void runBatch(p.suiteName, p.targets, {
      planId: p.planId,
      suiteId: p.suiteId,
    });
  },

  cancelPending: () => set({ pendingConfirm: null }),

  cancel: () => {
    bulkAbort?.abort();
    bulkAbort = null;
    clearDismiss();
    set({ phase: "idle", currentTitle: null });
  },

  dismiss: () => {
    clearDismiss();
    set({
      phase: "idle",
      notice: null,
      currentTitle: null,
      failures: [],
      scored: new Map(),
    });
  },

  beginCaseEval: (caseId) => {
    if (get().inFlight.has(caseId)) return false; // already being evaluated
    set((s) => ({ inFlight: new Set(s.inFlight).add(caseId) }));
    return true;
  },

  endCaseEval: (caseId) =>
    set((s) => {
      if (!s.inFlight.has(caseId)) return s;
      const next = new Set(s.inFlight);
      next.delete(caseId);
      return { inFlight: next };
    }),
}));
