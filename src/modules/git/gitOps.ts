// TS wrappers over the source-dir git status + write commands (git.rs /
// git_ops.rs). Camel-cased payloads mirror the Rust structs.

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

/** Working-tree state vs HEAD and upstream — echoes Rust `GitStatusSummary`. */
export type GitStatusSummary = {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  detached: boolean;
  /** Upstream ref (e.g. "origin/main"), or null when the branch tracks nothing. */
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Anything uncommitted (staged, unstaged, or untracked). */
  dirty: boolean;
  /** This branch has changes we parked (stashed) for it — surface Restore. */
  parkedHere: boolean;
};

export const EMPTY_STATUS: GitStatusSummary = {
  isRepo: false,
  branch: null,
  commit: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  dirty: false,
  parkedHere: false,
};

/** One branch in the switcher — echoes Rust `BranchListItem`. */
export type BranchListItem = {
  /** Ref as git names it: "feature/x" (local) or "origin/x" (remote). */
  name: string;
  /** Friendly short name (remote prefix stripped). */
  short: string;
  kind: "local" | "remote";
  /** Remote name (e.g. "origin") for remote branches; null for locals. */
  remote: string | null;
  isCurrent: boolean;
};

/** Result of a fetch — echoes Rust `GitFetchResult`. */
export type GitFetchResult = {
  status: "fetched" | "no-remote" | "offline" | "error";
  message: string;
};

/** Result of restoring parked changes — echoes Rust `GitStashRestoreResult`. */
export type GitStashRestoreResult = {
  status: "restored" | "conflict" | "none" | "error";
  conflictedFiles: string[];
  message: string;
};

/** How to treat uncommitted changes when switching branches. */
export type CheckoutMode = "carry" | "stash";

/** Result of a branch switch — echoes Rust `GitCheckoutResult`. */
export type GitCheckoutResult = {
  /** "switched" | "blocked" | "error". `blocked` means a carry-over checkout
   *  was refused because local changes would be overwritten — re-prompt with
   *  the stash option. */
  status: "switched" | "blocked" | "error";
  branch: string | null;
  /** True when changes were set aside in a stash to make the switch. */
  stashed: boolean;
  message: string;
};

/** Result of a fast-forward pull — echoes Rust `GitPullResult`. */
export type GitPullResult = {
  status:
    | "updated"
    | "up-to-date"
    | "no-upstream"
    | "diverged"
    | "offline"
    | "error";
  message: string;
};

/** Read the working-tree status summary. Returns a not-a-repo summary (never
 *  throws) when the path isn't a git repo. */
export async function gitStatusSummary(
  path: string,
): Promise<GitStatusSummary> {
  return invoke<GitStatusSummary>("git_status_summary", { path });
}

/** Structured branches for the switcher: locals (current first, recency-sorted)
 *  then remote-only branches, deduped and grouped. */
export async function gitBranches(cwd: string): Promise<BranchListItem[]> {
  return invoke<BranchListItem[]>("git_branches", { cwd });
}

/** Fetch all remotes (--prune) so new remote branches appear. Ref-only. */
export async function gitFetch(cwd: string): Promise<GitFetchResult> {
  return invoke<GitFetchResult>("git_fetch", { cwd });
}

/** Restore the changes parked on the current branch (apply, then drop on a
 *  clean apply; on conflict the stash is kept and the files are returned). */
export async function gitStashRestore(
  cwd: string,
): Promise<GitStashRestoreResult> {
  return invoke<GitStashRestoreResult>("git_stash_restore", { cwd });
}

/** Switch the source directory to `branch`, carrying or stashing local changes. */
export async function gitCheckout(
  cwd: string,
  branch: string,
  mode: CheckoutMode,
): Promise<GitCheckoutResult> {
  return invoke<GitCheckoutResult>("git_checkout", { cwd, branch, mode });
}

/** Fast-forward the current branch from its upstream. Never merges/rebases. */
export async function gitPull(cwd: string): Promise<GitPullResult> {
  return invoke<GitPullResult>("git_pull", { cwd });
}

/** Fired after a branch switch / pull / stash so live git readers refresh
 *  immediately instead of waiting for their 30 s poll. */
export const SOURCE_GIT_CHANGED_EVENT = "devops-studio:source-git-changed";

export function emitSourceGitChanged(): void {
  // Same-window consumers (the Commit Review pane) get the synchronous DOM
  // event. The Settings window is a SEPARATE webview, so also broadcast over
  // the Tauri bus (mirrors emitKeysChanged) — its live "Links use <branch>"
  // readout then refreshes promptly instead of lagging until its 30 s poll.
  window.dispatchEvent(new CustomEvent(SOURCE_GIT_CHANGED_EVENT));
  void emit(SOURCE_GIT_CHANGED_EVENT).catch(() => {});
}
