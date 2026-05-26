import { invoke } from "@tauri-apps/api/core";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import type { ActivityEntry } from "./activityLog";
import type { GenerationMode } from "./qaAnalystRun";
import type { Attachment } from "@/components/chat/attachments";

/**
 * One refine round captured for later inspection. The user asked us to keep
 * the entire thinking process — instruction + activity log + how the batch
 * changed — so they can read back why a draft is in its current shape.
 */
export type RefineRound = {
  /** ISO timestamp of when the round started. */
  timestamp: string;
  /** What the user typed (verbatim). */
  instruction: string;
  /** Streaming activity entries (tool calls, thinking, results) the engine
   *  emitted while running this round. Stored as-is so the UI can re-render
   *  them the same way the live log does. */
  activityLog: ActivityEntry[];
  /** Snapshot counts so a row in the "refine history" list can summarize
   *  the round at a glance: "3 → 5 cases, 1 → 2 bugs". Source of truth is
   *  still the cases/bugs payload on the run itself. */
  beforeCases: number;
  afterCases: number;
  beforeBugs: number;
  afterBugs: number;
  /** "ok" when the refine landed, "empty" when the model returned nothing
   *  structured, "failed" when an error was caught. */
  outcome: "ok" | "empty" | "failed";
  /** Surface the error text on failures so the user can still inspect
   *  what went wrong without re-running. Null on success/empty. */
  error?: string | null;
};

/**
 * Full draft snapshot embedded on a "draft" history row so the Generator can
 * fully restore the review phase when the user reopens it. Persisted as an
 * opaque JSON blob on the Rust side — the schema is TS-owned and forward-
 * compatible (every field is optional so older drafts still load cleanly).
 */
export type DraftPayload = {
  requirements?: string;
  /** Changeset / scope notes the user pasted at input time. Persisted so a
   *  reopened draft still has the same scope context the model originally
   *  saw — without this a refine after re-open would silently broaden
   *  coverage back to the full spec. */
  changesets?: string;
  mode?: GenerationMode;
  cases?: ReviewedCase[];
  bugs?: ReviewedBug[];
  rawText?: string;
  planId?: number | null;
  planName?: string | null;
  suiteId?: number | null;
  suiteName?: string | null;
  /** Per-session pinned model. Persisted so reopening a draft keeps the model
   *  the user chose instead of snapping back to the global default. */
  overrideModelId?: import("@/modules/ai/config").ModelId | null;
  /** Optional ordered list of refine rounds, oldest-first. Restored into
   *  the live session on loadDraft so the user picks up the conversation
   *  with the full thinking-process log intact. */
  refineRounds?: RefineRound[];
  /** The pre-refine batch from the most recent refine, so the "Last refine"
   *  changes diff can be reconstructed when a draft is reopened later. Null
   *  when no refine has happened. */
  refineUndoSnapshot?: {
    cases: ReviewedCase[];
    bugs: ReviewedBug[];
    rawText: string;
  } | null;
  /** Files/images attached to the session. Persisted (base64 for images) so a
   *  reopened draft keeps the same attachment context the model saw. */
  attachments?: Attachment[];
};

export type CaseSummary = {
  title: string;
  adoId?: number | null;
  webUrl?: string | null;
};

export type BugSummary = {
  title: string;
  severity: string;
  adoId?: number | null;
  webUrl?: string | null;
};

export type PublishLogEntry = {
  uid: string;
  /** "case" | "bug" */
  kind: "case" | "bug";
  title: string;
  /** "ok" | "failed" | "skipped" */
  status: "ok" | "failed" | "skipped";
  error?: string | null;
};

export type RunStatus = "draft" | "published";

export type GenerationRun = {
  /** Stable id. Re-saving the same id replaces the prior entry. */
  id: string;
  /** ISO-8601 timestamp, UTC. */
  timestamp: string;
  planId: number | null;
  planName: string | null;
  suiteId: number | null;
  suiteName: string | null;
  mode: string;
  specExcerpt?: string | null;
  cases: CaseSummary[];
  bugs: BugSummary[];
  publishLog: PublishLogEntry[];
  /** "draft" = generated to review but not yet published. "published" = at
   *  least one case/bug was published (per publishLog). Existing runs from
   *  before this field landed migrate to "published" on read since the only
   *  way they were saved was via the publish path. */
  status?: RunStatus;
  /** Full draft body — present on drafts so the Generator can restore review
   *  state. Absent on legacy / published rows. See {@link DraftPayload}. */
  draftPayload?: DraftPayload | null;
};

export async function saveRun(run: GenerationRun): Promise<void> {
  await invoke("history_save_run", { run });
}

export async function listRuns(): Promise<GenerationRun[]> {
  return invoke<GenerationRun[]>("history_list_runs");
}

export async function getRun(runId: string): Promise<GenerationRun | null> {
  return invoke<GenerationRun | null>("history_get_run", { runId });
}

export async function deleteRun(runId: string): Promise<void> {
  await invoke("history_delete_run", { runId });
}

/** Build a fresh `id` for a new run. UUID would be overkill — a timestamp +
 *  random suffix is collision-resistant for human-rate workflows. */
export function newRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** ISO-8601 in UTC, no millis. */
export function newTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Trim a spec down to fit comfortably in the history row preview. */
export function specExcerpt(input: string, max = 500): string {
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
