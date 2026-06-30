// Global orchestrator for status-bar branch switching. One switcher at a time:
// it decides clean-vs-dirty, drives the confirm dialog, runs checkout → pull,
// and feeds the glass capsule toast. State lives in a module-level store (not a
// component) so an in-flight switch survives any re-render of the status bar.

import { create } from "zustand";
import {
  emitSourceGitChanged,
  gitCheckout,
  gitPull,
  gitStashRestore,
  gitStatusSummary,
  type CheckoutMode,
  type GitPullResult,
  type GitStatusSummary,
} from "./gitOps";

/** Drives the bottom-left capsule. `done` auto-dismisses; `error` lingers longer. */
export type BranchSwitchToast =
  | { kind: "switching"; branch: string; stashing: boolean }
  | { kind: "pulling"; branch: string }
  | { kind: "restoring" }
  | { kind: "done"; message: string; tone: "ok" | "info" }
  | { kind: "error"; message: string };

/** Drives the dirty-tree confirm dialog. */
export type BranchSwitchConfirm = {
  cwd: string;
  /** The branch we're switching TO. */
  branch: string;
  /** The branch we're leaving (where changes get parked). */
  from: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Set when a "carry" checkout already failed — only the leave path proceeds. */
  blocked: boolean;
};

type State = {
  toast: BranchSwitchToast | null;
  confirm: BranchSwitchConfirm | null;
  /** Entry point from the switcher: clean tree → switch now; dirty → ask first. */
  requestSwitch: (cwd: string, branch: string, status: GitStatusSummary) => void;
  /** From the dialog: proceed with the chosen change-handling mode. */
  confirmSwitch: (mode: CheckoutMode) => void;
  cancelConfirm: () => void;
  /** Pull the current branch without switching (status-bar "Pull latest"). */
  pullOnly: (cwd: string, branch: string) => void;
  /** Restore changes parked on the current branch (status-bar "Restore"). */
  restoreStash: (cwd: string) => void;
  dismissToast: () => void;
};

// Module-scoped so they survive store recreation and re-renders.
let dismissTimer: number | null = null;
// Bumped on every new operation so a stale async result can't clobber a newer one.
let opToken = 0;

function clearDismiss() {
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function scheduleDismiss(set: (p: Partial<State>) => void, ms: number) {
  clearDismiss();
  dismissTimer = window.setTimeout(() => {
    set({ toast: null });
    dismissTimer = null;
  }, ms);
}

function errStr(e: unknown): string {
  return typeof e === "string" ? e : (e as Error)?.message ?? String(e);
}

/** Compose the done-toast for a switch (+ its pull outcome). */
function composeSwitchDone(
  branch: string,
  from: string | null,
  stashed: boolean,
  pull: GitPullResult,
): { message: string; tone: "ok" | "info" } {
  const base = stashed
    ? `Switched to ${branch} · changes left on ${from ?? "the previous branch"}`
    : `Switched to ${branch}`;
  switch (pull.status) {
    case "updated":
      return { message: `${base} · pulled latest`, tone: "ok" };
    case "up-to-date":
      return { message: `${base} · up to date`, tone: "ok" };
    case "no-upstream":
      return { message: base, tone: "ok" };
    case "diverged":
      return { message: `${base} · pull skipped, branch diverged`, tone: "info" };
    case "local-changes":
      return { message: `${base} · pull skipped, uncommitted changes`, tone: "info" };
    case "offline":
      return { message: `${base} · couldn't reach remote`, tone: "info" };
    default:
      return { message: `${base} · pull failed`, tone: "info" };
  }
}

export const useBranchSwitch = create<State>((set, get) => {
  async function runSwitch(
    cwd: string,
    branch: string,
    mode: CheckoutMode,
    from: string | null,
  ) {
    const token = ++opToken;
    clearDismiss();
    set({ toast: { kind: "switching", branch, stashing: mode === "stash" } });

    let res;
    try {
      res = await gitCheckout(cwd, branch, mode);
    } catch (e) {
      if (token !== opToken) return;
      set({ toast: { kind: "error", message: errStr(e) } });
      scheduleDismiss(set, 7000);
      return;
    }
    if (token !== opToken) return;

    if (res.status === "blocked") {
      // A carry-over checkout was refused — the changes conflict with the
      // target branch. Re-read the live status (the poll that drove the original
      // decision may have been stale) so the re-prompt shows real file counts,
      // then re-open the dialog with only the "leave them" path available.
      let staged = 0;
      let unstaged = 0;
      let untracked = 0;
      try {
        const st = await gitStatusSummary(cwd);
        staged = st.staged;
        unstaged = st.unstaged;
        untracked = st.untracked;
      } catch {
        // Keep zeros — the dialog copy degrades to a generic message.
      }
      if (token !== opToken) return;
      set({
        toast: null,
        confirm: { cwd, branch, from, staged, unstaged, untracked, blocked: true },
      });
      return;
    }
    if (res.status === "error") {
      set({
        toast: {
          kind: "error",
          message: res.message || "Couldn't switch branches.",
        },
      });
      scheduleDismiss(set, 8000);
      emitSourceGitChanged();
      return;
    }

    // Switched. Reflect the new branch in the bar right away, then pull.
    const switched = res.branch ?? branch;
    emitSourceGitChanged();
    set({ toast: { kind: "pulling", branch: switched } });

    let pull: GitPullResult;
    try {
      pull = await gitPull(cwd);
    } catch {
      pull = { status: "error", message: "" };
    }
    if (token !== opToken) return;

    const { message, tone } = composeSwitchDone(switched, from, res.stashed, pull);
    set({ toast: { kind: "done", message, tone } });
    scheduleDismiss(set, tone === "ok" ? 5000 : 8000);
    emitSourceGitChanged();
  }

  async function runRestore(cwd: string) {
    const token = ++opToken;
    clearDismiss();
    set({ toast: { kind: "restoring" } });

    let res;
    try {
      res = await gitStashRestore(cwd);
    } catch (e) {
      if (token !== opToken) return;
      set({ toast: { kind: "error", message: errStr(e) } });
      scheduleDismiss(set, 7000);
      return;
    }
    if (token !== opToken) return;
    emitSourceGitChanged();

    if (res.status === "restored") {
      set({ toast: { kind: "done", message: res.message, tone: "ok" } });
      scheduleDismiss(set, 4500);
    } else if (res.status === "conflict") {
      const n = res.conflictedFiles.length;
      set({
        toast: {
          kind: "done",
          message: `Restored with conflicts in ${n} file${n === 1 ? "" : "s"} — resolve them. Your stash is kept.`,
          tone: "info",
        },
      });
      scheduleDismiss(set, 9000);
    } else if (res.status === "none") {
      set({ toast: { kind: "done", message: "No changes to restore here.", tone: "info" } });
      scheduleDismiss(set, 4000);
    } else {
      set({
        toast: { kind: "error", message: res.message || "Couldn't restore your changes." },
      });
      scheduleDismiss(set, 8000);
    }
  }

  async function runPullOnly(cwd: string, branch: string) {
    const token = ++opToken;
    clearDismiss();
    set({ toast: { kind: "pulling", branch } });

    let pull: GitPullResult;
    try {
      pull = await gitPull(cwd);
    } catch (e) {
      pull = { status: "error", message: errStr(e) };
    }
    if (token !== opToken) return;

    let message: string;
    let tone: "ok" | "info";
    switch (pull.status) {
      case "updated":
        message = pull.message || `Pulled latest on ${branch}`;
        tone = "ok";
        break;
      case "up-to-date":
        message = `${branch} is already up to date`;
        tone = "ok";
        break;
      case "no-upstream":
        message = `${branch} isn't tracking a remote — nothing to pull`;
        tone = "info";
        break;
      case "local-changes":
        message =
          pull.message ||
          "You have uncommitted changes the update would overwrite. Commit or stash them, then pull.";
        tone = "info";
        break;
      default:
        message = pull.message || "Couldn't pull the latest changes.";
        tone = "info";
    }
    set({ toast: { kind: "done", message, tone } });
    scheduleDismiss(set, tone === "ok" ? 4500 : 8000);
    emitSourceGitChanged();
  }

  return {
    toast: null,
    confirm: null,

    requestSwitch: (cwd, branch, status) => {
      if (!branch || status.branch === branch) return;
      if (status.dirty) {
        // Clear any lingering result toast (and its pending auto-dismiss) so the
        // confirm prompt never opens alongside a stale "Switched…" capsule.
        clearDismiss();
        set({
          toast: null,
          confirm: {
            cwd,
            branch,
            from: status.branch,
            staged: status.staged,
            unstaged: status.unstaged,
            untracked: status.untracked,
            blocked: false,
          },
        });
      } else {
        void runSwitch(cwd, branch, "carry", status.branch);
      }
    },

    confirmSwitch: (mode) => {
      const c = get().confirm;
      if (!c) return;
      set({ confirm: null });
      void runSwitch(c.cwd, c.branch, mode, c.from);
    },

    cancelConfirm: () => set({ confirm: null }),

    pullOnly: (cwd, branch) => void runPullOnly(cwd, branch),

    restoreStash: (cwd) => void runRestore(cwd),

    dismissToast: () => {
      clearDismiss();
      set({ toast: null });
    },
  };
});
