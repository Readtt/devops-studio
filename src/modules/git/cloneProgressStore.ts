import { create } from "zustand";

import { useActionToast } from "@/components/actionToastStore";
import { setSourceRoot } from "@/modules/settings/store";

import {
  cancelClone,
  cloneRepo,
  nextCloneId,
  type CloneAuth,
  type CloneStatus,
} from "./cloneOps";
import { emitSourceGitChanged } from "./gitOps";

// idle → cloning → (choose-source | done)
//   choose-source: ≥1 repo cloned; the source-picker popup is up.
//   done: all failed, cancelled, or the user resolved the picker.
type ClonePhase = "idle" | "cloning" | "choose-source" | "done";

/** One repo to clone in a batch. Several of these run one-at-a-time (the Rust
 *  side clones a single repo; sequential keeps progress legible and avoids
 *  credential-helper races). */
export type CloneJob = {
  url: string;
  /** Resolved, collision-free subfolder name under the shared parent. */
  dirName: string;
  auth: CloneAuth;
  persistAuth: boolean;
  /** Human label for progress + the picker (the repo name). */
  repoLabel: string;
  /** Owning ADO project, shown as a chip in the picker to disambiguate. */
  project: string | null;
};

/** Terminal result of one job in the batch. */
export type CloneOutcome = {
  label: string;
  project: string | null;
  status: CloneStatus | "error";
  /** Absolute path of the clone, present only on success. */
  path: string | null;
  message: string | null;
};

export type CloneStartArgs = {
  jobs: CloneJob[];
  /** The shared parent folder, for the picker subtitle ("cloned into …"). */
  destParent: string;
};

type State = {
  phase: ClonePhase;
  /** Total jobs in the current batch. */
  total: number;
  /** 0-based index of the job cloning right now. */
  currentIndex: number;
  destParent: string | null;
  /** Current job's label / git sub-phase / percent (drives the capsule). */
  repoLabel: string | null;
  gitPhase: string | null;
  pct: number | null;
  /** Accumulated per-job results (only for jobs that actually ran). */
  outcomes: CloneOutcome[];
  /** True when the user cancelled the batch (vs. it running to completion). */
  cancelled: boolean;
  /** Current job's cancel handle. */
  requestId: number | null;
  /** Identity of the running batch; bumping it supersedes the in-flight loop. */
  runToken: number;

  /** Kick off a batch. No-ops if one is already running. Module-scoped, so it
   *  survives the wizard dialog closing. */
  startBatch: (args: CloneStartArgs) => Promise<void>;
  /** Stop the batch: kill the current clone, keep already-cloned repos. */
  cancel: () => void;
  /** Clear the capsule. */
  dismiss: () => void;
  /** Resolve the source-picker: adopt `path` as the source dir, or null to skip. */
  chooseSource: (path: string | null) => void;
};

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
function clearDismiss() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

const IDLE = {
  phase: "idle" as const,
  total: 0,
  currentIndex: 0,
  destParent: null,
  repoLabel: null,
  gitPhase: null,
  pct: null,
  outcomes: [] as CloneOutcome[],
  cancelled: false,
  requestId: null,
};

export const useCloneProgress = create<State>((set, get) => ({
  ...IDLE,
  runToken: 0,

  startBatch: async ({ jobs, destParent }) => {
    // Reject a new batch while one is still active — "cloning" OR "choose-source"
    // (clones landed and the source picker is still up). Restarting at
    // choose-source would wipe the pending picker's outcomes.
    const phase = get().phase;
    if (phase === "cloning" || phase === "choose-source" || jobs.length === 0) return;
    clearDismiss();
    const runToken = get().runToken + 1;
    set({
      phase: "cloning",
      total: jobs.length,
      currentIndex: 0,
      destParent,
      repoLabel: null,
      gitPhase: null,
      pct: null,
      outcomes: [],
      cancelled: false,
      requestId: null,
      runToken,
    });

    const outcomes: CloneOutcome[] = [];
    for (let i = 0; i < jobs.length; i++) {
      // A newer batch or a cancel superseded us.
      if (get().runToken !== runToken) return;
      const job = jobs[i];
      const requestId = nextCloneId();
      set({
        currentIndex: i,
        repoLabel: job.repoLabel,
        gitPhase: null,
        pct: null,
        requestId,
      });

      let status: CloneStatus | "error";
      let path: string | null;
      let message: string | null;
      try {
        const result = await cloneRepo(
          {
            url: job.url,
            destParent,
            dirName: job.dirName,
            auth: job.auth,
            persistAuth: job.persistAuth,
            requestId,
          },
          (p) => {
            if (get().requestId !== requestId || get().runToken !== runToken) return;
            set({ gitPhase: p.phase, pct: p.pct });
          },
        );
        status = result.status;
        path = result.path;
        message = result.message;
      } catch (e) {
        status = "error";
        path = null;
        message = e instanceof Error ? e.message : String(e);
      }

      // Cancel/supersede landed while this job was in flight — its outcome is
      // owned by cancel(), don't record or advance.
      if (get().runToken !== runToken) return;
      outcomes.push({ label: job.repoLabel, project: job.project, status, path, message });
      set({ outcomes: [...outcomes] });
    }

    if (get().runToken !== runToken) return;

    const successes = outcomes.filter((o) => o.status === "cloned" && o.path);
    if (successes.length > 0) {
      // Hand off to the source-picker popup — it owns the source-dir decision.
      set({ phase: "choose-source", repoLabel: null, gitPhase: null, pct: null });
    } else {
      set({ phase: "done", repoLabel: null, gitPhase: null, pct: null });
      dismissTimer = setTimeout(() => get().dismiss(), 5000);
    }
  },

  cancel: () => {
    const id = get().requestId;
    if (id != null) void cancelClone(id);
    clearDismiss();
    // Bump the token so the running loop bails without touching state, and show
    // the final tally of what completed before the stop.
    set({
      phase: "done",
      cancelled: true,
      repoLabel: null,
      gitPhase: null,
      pct: null,
      requestId: null,
      runToken: get().runToken + 1,
    });
    dismissTimer = setTimeout(() => get().dismiss(), 5000);
  },

  dismiss: () => {
    clearDismiss();
    set({ ...IDLE });
  },

  chooseSource: (path) => {
    clearDismiss();
    if (path) {
      const label = get().outcomes.find((o) => o.path === path)?.label ?? "the cloned repo";
      // Only claim success once the source-dir write actually lands. A failed
      // write must not leave a misleading "Now working in X" toast (and an
      // unhandled rejection) while the app still points at the old source.
      void setSourceRoot(path)
        .then(() => {
          emitSourceGitChanged();
          useActionToast.getState().show({ tone: "ok", message: `Now working in ${label}` });
        })
        .catch(() => {
          useActionToast.getState().show({
            tone: "error",
            message: `Couldn't switch to ${label}`,
          });
        });
    }
    set({ phase: "done" });
    dismissTimer = setTimeout(() => get().dismiss(), 2600);
  },
}));
