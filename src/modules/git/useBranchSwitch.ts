// Global orchestrator for status-bar branch switching. Everything is keyed by
// repo root (`cwd`): it decides clean-vs-dirty, drives the confirm dialog, runs
// checkout → pull, and feeds the glass capsule toast. State lives in a
// module-level store (not a component) so an in-flight switch survives any
// re-render of the status bar.
//
// Per-cwd rather than singleton because repos are independent: a switch started
// in one repo must not cancel, or steal the toast of, one already running in
// another.

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
  /** Live toast per repo root. Rendered as a stack. */
  toasts: Map<string, BranchSwitchToast>;
  /** Pending dirty-tree question per repo root. The dialog asks them one at a time. */
  confirms: Map<string, BranchSwitchConfirm>;
  /** Entry point from the switcher: clean tree → switch now; dirty → ask first. */
  requestSwitch: (cwd: string, branch: string, status: GitStatusSummary) => void;
  /** From the dialog: proceed with the chosen change-handling mode. */
  confirmSwitch: (cwd: string, mode: CheckoutMode) => void;
  cancelConfirm: (cwd: string) => void;
  /** Pull the current branch without switching (status-bar "Pull latest"). */
  pullOnly: (cwd: string, branch: string) => void;
  /** Restore changes parked on the current branch (status-bar "Restore"). */
  restoreStash: (cwd: string) => void;
  dismissToast: (cwd: string) => void;
};

// Module-scoped so they survive store recreation and re-renders.
const dismissTimers = new Map<string, number>();
// Bumped per repo on every new operation so a stale async result can't clobber
// a newer one — and so an operation in one repo can't cancel another's.
const opTokens = new Map<string, number>();

function nextToken(cwd: string): number {
  const token = (opTokens.get(cwd) ?? 0) + 1;
  opTokens.set(cwd, token);
  return token;
}

function isStale(cwd: string, token: number): boolean {
  return opTokens.get(cwd) !== token;
}

function clearDismiss(cwd: string) {
  const timer = dismissTimers.get(cwd);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    dismissTimers.delete(cwd);
  }
}

/** True while `cwd` has an operation running — the switcher locks itself then. */
export function isBranchOpBusy(toast: BranchSwitchToast | undefined): boolean {
  return (
    toast?.kind === "switching" ||
    toast?.kind === "pulling" ||
    toast?.kind === "restoring"
  );
}

export const useBranchSwitch = create<State>((set, get) => {
  /** Set (or with `null`, clear) one repo's toast without touching the others. */
  function putToast(cwd: string, toast: BranchSwitchToast | null) {
    const next = new Map(get().toasts);
    if (toast) next.set(cwd, toast);
    else next.delete(cwd);
    set({ toasts: next });
  }

  function putConfirm(cwd: string, confirm: BranchSwitchConfirm | null) {
    const next = new Map(get().confirms);
    if (confirm) next.set(cwd, confirm);
    else next.delete(cwd);
    set({ confirms: next });
  }

  function scheduleDismiss(cwd: string, ms: number) {
    clearDismiss(cwd);
    dismissTimers.set(
      cwd,
      window.setTimeout(() => {
        dismissTimers.delete(cwd);
        putToast(cwd, null);
      }, ms),
    );
  }

  async function runSwitch(
    cwd: string,
    branch: string,
    mode: CheckoutMode,
    from: string | null,
  ) {
    const token = nextToken(cwd);
    clearDismiss(cwd);
    putToast(cwd, { kind: "switching", branch, stashing: mode === "stash" });

    let res;
    try {
      res = await gitCheckout(cwd, branch, mode);
    } catch (e) {
      if (isStale(cwd, token)) return;
      putToast(cwd, { kind: "error", message: errStr(e) });
      scheduleDismiss(cwd, 7000);
      return;
    }
    if (isStale(cwd, token)) return;

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
      if (isStale(cwd, token)) return;
      putToast(cwd, null);
      putConfirm(cwd, {
        cwd,
        branch,
        from,
        staged,
        unstaged,
        untracked,
        blocked: true,
      });
      return;
    }
    if (res.status === "error") {
      putToast(cwd, {
        kind: "error",
        message: res.message || "Couldn't switch branches.",
      });
      scheduleDismiss(cwd, 8000);
      emitSourceGitChanged(cwd);
      return;
    }

    // Switched. Reflect the new branch in the bar right away, then pull.
    const switched = res.branch ?? branch;
    emitSourceGitChanged(cwd);
    putToast(cwd, { kind: "pulling", branch: switched });

    let pull: GitPullResult;
    try {
      pull = await gitPull(cwd);
    } catch {
      pull = { status: "error", message: "" };
    }
    if (isStale(cwd, token)) return;

    const { message, tone } = composeSwitchDone(switched, from, res.stashed, pull);
    putToast(cwd, { kind: "done", message, tone });
    scheduleDismiss(cwd, tone === "ok" ? 5000 : 8000);
    emitSourceGitChanged(cwd);
  }

  async function runRestore(cwd: string) {
    const token = nextToken(cwd);
    clearDismiss(cwd);
    putToast(cwd, { kind: "restoring" });

    let res;
    try {
      res = await gitStashRestore(cwd);
    } catch (e) {
      if (isStale(cwd, token)) return;
      putToast(cwd, { kind: "error", message: errStr(e) });
      scheduleDismiss(cwd, 7000);
      return;
    }
    if (isStale(cwd, token)) return;
    emitSourceGitChanged(cwd);

    if (res.status === "restored") {
      putToast(cwd, { kind: "done", message: res.message, tone: "ok" });
      scheduleDismiss(cwd, 4500);
    } else if (res.status === "conflict") {
      const n = res.conflictedFiles.length;
      putToast(cwd, {
        kind: "done",
        message: `Restored with conflicts in ${n} file${n === 1 ? "" : "s"} — resolve them. Your stash is kept.`,
        tone: "info",
      });
      scheduleDismiss(cwd, 9000);
    } else if (res.status === "none") {
      putToast(cwd, {
        kind: "done",
        message: "No changes to restore here.",
        tone: "info",
      });
      scheduleDismiss(cwd, 4000);
    } else {
      putToast(cwd, {
        kind: "error",
        message: res.message || "Couldn't restore your changes.",
      });
      scheduleDismiss(cwd, 8000);
    }
  }

  async function runPullOnly(cwd: string, branch: string) {
    const token = nextToken(cwd);
    clearDismiss(cwd);
    putToast(cwd, { kind: "pulling", branch });

    let pull: GitPullResult;
    try {
      pull = await gitPull(cwd);
    } catch (e) {
      pull = { status: "error", message: errStr(e) };
    }
    if (isStale(cwd, token)) return;

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
    putToast(cwd, { kind: "done", message, tone });
    scheduleDismiss(cwd, tone === "ok" ? 4500 : 8000);
    emitSourceGitChanged(cwd);
  }

  return {
    toasts: new Map(),
    confirms: new Map(),

    requestSwitch: (cwd, branch, status) => {
      if (!branch || status.branch === branch) return;
      if (status.dirty) {
        // Clear any lingering result toast (and its pending auto-dismiss) so the
        // confirm prompt never opens alongside a stale "Switched…" capsule.
        clearDismiss(cwd);
        putToast(cwd, null);
        putConfirm(cwd, {
          cwd,
          branch,
          from: status.branch,
          staged: status.staged,
          unstaged: status.unstaged,
          untracked: status.untracked,
          blocked: false,
        });
      } else {
        void runSwitch(cwd, branch, "carry", status.branch);
      }
    },

    confirmSwitch: (cwd, mode) => {
      const c = get().confirms.get(cwd);
      if (!c) return;
      putConfirm(cwd, null);
      void runSwitch(c.cwd, c.branch, mode, c.from);
    },

    cancelConfirm: (cwd) => putConfirm(cwd, null),

    pullOnly: (cwd, branch) => void runPullOnly(cwd, branch),

    restoreStash: (cwd) => void runRestore(cwd),

    dismissToast: (cwd) => {
      clearDismiss(cwd);
      putToast(cwd, null);
    },
  };
});

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
