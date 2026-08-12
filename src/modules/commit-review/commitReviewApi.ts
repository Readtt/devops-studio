// Thin TS wrappers over the Rust commit_review_* SQLite commands. `findings`,
// `appliedPatches`, and `context` are opaque JSON/text strings on the wire —
// the store serializes/parses; Rust just stores the blobs.
//
// Reads are zod-parsed at this boundary (like `ado/native.ts`) rather than cast
// through: a shape change otherwise surfaces as `undefined.map` deep inside a
// component, with nothing pointing at the IPC call that produced it.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export type CommitReviewStatus =
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

const StatusSchema = z.enum([
  "running",
  "done",
  "error",
  "cancelled",
  "interrupted",
]);

/** Shared by the full row and the History projection. */
const SummarySchema = z.object({
  runId: z.string(),
  /** JSON array of the review's repo roots; a bare path on legacy rows. */
  cwd: z.string(),
  commitSha: z.string(),
  commitShort: z.string(),
  commitSubject: z.string().nullable(),
  /** JSON-encoded ReviewedCommit[]; the History list reads its length + repos. */
  commits: z.string().nullable(),
  status: StatusSchema,
  modelId: z.string().nullable(),
  findingCount: z.number(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RowSchema = SummarySchema.extend({
  context: z.string().nullable(),
  /** JSON-encoded Finding[]. */
  findings: z.string(),
  /** JSON-encoded { [findingId]: AppliedPatchRecord }. */
  appliedPatches: z.string(),
  error: z.string().nullable(),
});

/** Full persisted run record — wire shape (echoes Rust `CommitReviewRow`). */
export type CommitReviewRow = z.infer<typeof RowSchema>;

/** Lightweight History-list projection (echoes Rust `CommitReviewSummary`). */
export type CommitReviewSummary = z.infer<typeof SummarySchema>;

/** Upsert the full run row. Used at every status transition + each apply. */
export async function saveCommitReview(input: CommitReviewRow): Promise<void> {
  await invoke("commit_review_save", { input });
}

export async function getCommitReview(
  runId: string,
): Promise<CommitReviewRow | null> {
  const raw = await invoke<unknown>("commit_review_get", { input: { runId } });
  if (raw == null) return null;
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[commit-review] unreadable saved row:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export async function listCommitReviews(): Promise<CommitReviewSummary[]> {
  const raw = await invoke<unknown>("commit_review_list");
  // One malformed row drops out; the rest of the list still renders. Failing
  // the whole call would hide every good review behind one bad one.
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) {
    console.warn("[commit-review] unreadable history:", parsed.error.issues);
    return [];
  }
  const rows: CommitReviewSummary[] = [];
  for (const row of parsed.data) {
    const one = SummarySchema.safeParse(row);
    if (one.success) rows.push(one.data);
    else console.warn("[commit-review] skipped a row:", one.error.issues);
  }
  return rows;
}

export async function deleteCommitReview(runId: string): Promise<void> {
  await invoke("commit_review_delete", { input: { runId } });
}

/** Reconcile rows orphaned by a crash/refresh (running → interrupted). Called
 *  once on app mount. Returns the number of rows reconciled. */
export async function sweepStaleCommitReviews(now: string): Promise<number> {
  return invoke<number>("commit_review_sweep_stale", { input: { now } });
}
