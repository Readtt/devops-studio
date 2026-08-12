import { create } from "zustand";

import { useActionToast } from "@/components/actionToastStore";
import { addRepo } from "@/modules/settings/store";

import {
  cancelClone,
  cloneRepo,
  nextCloneId,
  type CloneAuth,
  type CloneStatus,
} from "./cloneOps";
import { emitSourceGitChanged } from "./gitOps";

// idle → cloning → done
// Every repo that clones successfully joins the workspace; there is no "which
// one is THE source" question to ask, because every configured repo is read.
type ClonePhase = "idle" | "cloning" | "done";

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
    if (get().phase === "cloning" || jobs.length === 0) return;
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

    set({ phase: "done", repoLabel: null, gitPhase: null, pct: null });
    dismissTimer = setTimeout(() => get().dismiss(), 5000);

    const successes = outcomes.filter((o) => o.status === "cloned" && o.path);
    if (successes.length === 0) return;
    try {
      // Sequential: addRepo is read-modify-write against the shared registry,
      // so racing them would let later writes clobber earlier ones.
      for (const o of successes) await addRepo(o.path as string);
      emitSourceGitChanged();
      useActionToast.getState().show({
        tone: "ok",
        message:
          successes.length === 1
            ? `Added ${successes[0].label}`
            : `Added ${successes.length} repos`,
      });
    } catch {
      // The clones are on disk either way — say what didn't happen so the user
      // knows to add them from Settings rather than assuming they're in.
      useActionToast.getState().show({
        tone: "error",
        message:
          successes.length === 1
            ? `Cloned ${successes[0].label}, but couldn't add it to the workspace`
            : "Cloned, but couldn't add the repos to the workspace",
      });
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
}));
