// TS wrappers over the source-dir git status + write commands (git.rs /
// git_ops.rs). Camel-cased payloads mirror the Rust structs.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Branch + short SHA of one repo — echoes Rust `GitRepoInfo`.
 *
 *  Deliberately narrow: this is the shape the status bar polls for every
 *  configured repo every 30 s, so each field here costs a `git` subprocess per
 *  repo per tick. Anything only one surface needs gets its own command —
 *  see {@link gitRemoteUrl}. */
export type GitRepoInfo = {
  branch: string | null;
  commit: string | null;
  isRepo: boolean;
  detached: boolean;
};

export const EMPTY_REPO_INFO: GitRepoInfo = {
  branch: null,
  commit: null,
  isRepo: false,
  detached: false,
};

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
    /** A fast-forward would overwrite uncommitted edits — git refused, tree intact. */
    | "local-changes"
    | "offline"
    | "error";
  message: string;
};

/** Read the branch + short SHA of one repo. */
export async function gitRepoInfo(path: string): Promise<GitRepoInfo> {
  return invoke<GitRepoInfo>("git_repo_info", { path });
}

/** `origin`'s URL, or null when the repo has no `origin` (or isn't a repo).
 *
 *  Its own command rather than a field on {@link GitRepoInfo}: only the ADO
 *  binder reads it, and `gitRepoInfo` is on the status bar's 30 s poll for
 *  every configured repo. */
export async function gitRemoteUrl(path: string): Promise<string | null> {
  return invoke<string | null>("git_remote_url", { path });
}

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

/** What {@link emitSourceGitChanged} carries. `root` narrows the refresh to the
 *  one repo that changed; listeners must treat its absence as "refresh all", so
 *  a caller that doesn't know which repo moved still works. */
export type SourceGitChanged = { root?: string; nonce?: string };

// Globally unique per window, so a nonce this window minted can never be
// mistaken for one another window minted.
const EMITTER_ID = Math.random().toString(36).slice(2);
let nonceSeq = 0;

export function emitSourceGitChanged(root?: string): void {
  // Same-window consumers (the Commit Review pane) get the synchronous DOM
  // event. The Settings window is a SEPARATE webview, so also broadcast over
  // the Tauri bus (mirrors emitKeysChanged) — its live "Links use <branch>"
  // readout then refreshes promptly instead of lagging until its 30 s poll.
  const detail: SourceGitChanged = { root, nonce: `${EMITTER_ID}-${++nonceSeq}` };
  window.dispatchEvent(new CustomEvent(SOURCE_GIT_CHANGED_EVENT, { detail }));
  void emit(SOURCE_GIT_CHANGED_EVENT, detail).catch(() => {});
}

/** Subscribe to git changes on BOTH buses: the DOM event (same window) and the
 *  Tauri bus (another window). Listening to one only is how a switch made in
 *  Settings used to refresh the branch label but not the dirty chips. */
export function onSourceGitChanged(
  cb: (root: string | undefined) => void,
): () => void {
  // Tauri's `emit` broadcasts back to the emitting window too, so in the window
  // that fired it both buses deliver the same change. Collapsing the pair by
  // nonce keeps one branch switch from costing two git spawns per repo.
  const seen = new Set<string>();
  const handle = (payload: SourceGitChanged | null | undefined) => {
    const nonce = payload?.nonce;
    if (nonce) {
      if (seen.has(nonce)) return;
      seen.add(nonce);
      // Only the echo of a just-fired event needs recognising; bound the set.
      if (seen.size > 32) seen.delete(seen.values().next().value as string);
    }
    cb(payload?.root);
  };

  const onDom = (e: Event) => handle((e as CustomEvent<SourceGitChanged>).detail);
  window.addEventListener(SOURCE_GIT_CHANGED_EVENT, onDom);

  let cancelled = false;
  let unlistenBus: UnlistenFn | null = null;
  void listen<SourceGitChanged | null>(SOURCE_GIT_CHANGED_EVENT, (e) =>
    handle(e.payload),
  )
    .then((un) => {
      if (cancelled) un();
      else unlistenBus = un;
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    window.removeEventListener(SOURCE_GIT_CHANGED_EVENT, onDom);
    if (unlistenBus) unlistenBus();
  };
}
