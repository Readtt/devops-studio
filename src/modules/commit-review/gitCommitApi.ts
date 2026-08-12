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

/** Which repo a row was read from. The Rust commands know nothing about the
 *  registry — every one takes an explicit `cwd` — so the tag is applied at the
 *  call site and travels with the row from there on. */
type RepoTag = { repoId: string; repoName: string };

/** A picker row, tagged with the repo whose history it came from. */
export type RepoCommitMeta = CommitMeta & RepoTag;

/** A loaded diff, tagged with the repo it was read from. Paths inside `files`
 *  and `rawPatch` stay repo-RELATIVE (that's what git emits); the tag is what
 *  turns them into the `<repo>/<path>` form the AI layer addresses files by. */
export type RepoCommitDiff = CommitDiff & RepoTag;

/** A diff that may or may not carry its repo tag: what a checkpoint written
 *  before commit review went multi-repo holds. Untagged entries belong to the
 *  first repo — the single root the run was pinned to. */
export type MaybeRepoCommitDiff = CommitDiff & Partial<RepoTag>;

/** Selection / diff-cache key. A sha is only unique within its repo — two
 *  repos each have a "local", and (vanishingly rarely) could share a sha — so
 *  everything keyed by "which change" is keyed by this instead.
 *
 *  Repo ids are UUIDs or `repo-<base36>-<base36>`, and shas are hex or the
 *  `local` sentinel: neither ever contains a colon, so the first one splits it. */
export function commitKey(repoId: string, sha: string): string {
  return `${repoId}:${sha}`;
}

/** Split a selection key back into its parts. A key with no colon is a legacy
 *  bare sha from the single-root era; those belong to the first repo, which is
 *  the root the app used to be pinned to. */
export function splitCommitKey(
  key: string,
  fallbackRepoId: string,
): { repoId: string; sha: string } {
  const cut = key.indexOf(":");
  return cut === -1
    ? { repoId: fallbackRepoId, sha: key }
    : { repoId: key.slice(0, cut), sha: key.slice(cut + 1) };
}

/** Whether a selection key names the synthetic "Local changes" target. */
export function isLocalKey(key: string): boolean {
  return splitCommitKey(key, "").sha === LOCAL_CHANGES_SHA;
}

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
