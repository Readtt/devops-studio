import { invoke } from "@tauri-apps/api/core";

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
