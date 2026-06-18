// Thin TS wrappers over the Rust single-commit git commands. Mirrors the
// camelCase payloads from `git.rs` (CommitMeta / CommitDiff).

import { invoke } from "@tauri-apps/api/core";

/** One row in the commit picker — echoes Rust `CommitMeta`. */
export type CommitMeta = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** ISO-8601 committer date. */
  date: string;
  /** Human relative date ("3 days ago"). */
  relativeDate: string;
  /** The repo's first commit (no parent). */
  isRoot: boolean;
};

/** Sentinel "sha" for the synthetic Local changes target. Matches the `sha`
 *  field the Rust `git_working_tree_diff` returns, so the selection key, the
 *  diff cache key, and the persisted row all agree. A real git SHA is 40 hex
 *  chars, so this never collides with one. */
export const LOCAL_CHANGES_SHA = "local";

/** The diff of a single commit plus its metadata — echoes Rust `CommitDiff`. */
export type CommitDiff = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  isRoot: boolean;
  isMerge: boolean;
  /** True for the synthetic "Local changes" diff (uncommitted edits vs HEAD). */
  isLocal: boolean;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  rawPatch: string;
  truncated: boolean;
  /** Short SHA of the working-tree HEAD at read time. Differs from `shortSha`
   *  when reviewing an older commit — the pane warns the tree has moved on. */
  headSha: string;
};

/** Recent commits on the source dir's current HEAD, newest first. */
export async function listCommits(
  cwd: string,
  count = 50,
): Promise<CommitMeta[]> {
  return invoke<CommitMeta[]>("git_list_commits", { cwd, count });
}

/** The diff a single commit introduced (`<sha>^..<sha>`). Throws a friendly
 *  "commit … not found" when the sha no longer resolves (rebased/amended). */
export async function commitDiff(cwd: string, sha: string): Promise<CommitDiff> {
  return invoke<CommitDiff>("git_commit_diff", { cwd, sha });
}

/** The diff of every uncommitted change (staged + unstaged + untracked) vs
 *  HEAD — the "Local changes" review target. Always reflects the working tree
 *  at call time. */
export async function workingTreeDiff(cwd: string): Promise<CommitDiff> {
  return invoke<CommitDiff>("git_working_tree_diff", { cwd });
}
