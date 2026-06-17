// Thin TS wrappers over the Rust commit_review_* SQLite commands. `findings`,
// `appliedPatches`, and `context` are opaque JSON/text strings on the wire —
// the store serializes/parses; Rust just stores the blobs.

import { invoke } from "@tauri-apps/api/core";

export type CommitReviewStatus =
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

/** Full persisted run record — wire shape (echoes Rust `CommitReviewRow`). */
export type CommitReviewRow = {
  runId: string;
  cwd: string;
  /** Primary (first) reviewed commit — full SHA. Drives the History list. */
  commitSha: string;
  commitShort: string;
  commitSubject: string | null;
  /** JSON-encoded ReviewedCommit[] (all reviewed commits). Null on legacy rows. */
  commits: string | null;
  status: CommitReviewStatus;
  modelId: string | null;
  context: string | null;
  /** JSON-encoded Finding[]. */
  findings: string;
  /** JSON-encoded { [findingId]: AppliedPatchRecord }. */
  appliedPatches: string;
  error: string | null;
  findingCount: number;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

/** Lightweight History-list projection (echoes Rust `CommitReviewSummary`). */
export type CommitReviewSummary = {
  runId: string;
  cwd: string;
  commitSha: string;
  commitShort: string;
  commitSubject: string | null;
  /** JSON-encoded ReviewedCommit[]; the History list reads its length. */
  commits: string | null;
  status: CommitReviewStatus;
  modelId: string | null;
  findingCount: number;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

/** Upsert the full run row. Used at every status transition + each apply. */
export async function saveCommitReview(input: CommitReviewRow): Promise<void> {
  await invoke("commit_review_save", { input });
}

export async function getCommitReview(
  runId: string,
): Promise<CommitReviewRow | null> {
  return invoke<CommitReviewRow | null>("commit_review_get", {
    input: { runId },
  });
}

export async function listCommitReviews(): Promise<CommitReviewSummary[]> {
  return invoke<CommitReviewSummary[]>("commit_review_list");
}

export async function deleteCommitReview(runId: string): Promise<void> {
  await invoke("commit_review_delete", { input: { runId } });
}

/** Reconcile rows orphaned by a crash/refresh (running → interrupted). Called
 *  once on app mount. Returns the number of rows reconciled. */
export async function sweepStaleCommitReviews(now: string): Promise<number> {
  return invoke<number>("commit_review_sweep_stale", { input: { now } });
}
