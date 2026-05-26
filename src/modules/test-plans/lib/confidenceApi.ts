// TS wrapper over the confidence_store Tauri commands. Mirrors chatThreadsApi:
// the verdict is stringified into an opaque JSON column on the Rust side, so
// the shape stays owned here.

import { invoke } from "@tauri-apps/api/core";
import type { ConfidenceVerdict } from "./confidence";

type ConfidenceRow = {
  caseId: number;
  verdictJson: string;
  updatedAt: string;
};

function parseRow(row: ConfidenceRow | null): ConfidenceVerdict | null {
  if (!row) return null;
  try {
    return JSON.parse(row.verdictJson) as ConfidenceVerdict;
  } catch {
    return null;
  }
}

/** Persist (upsert) a verdict for a published case. */
export async function saveConfidence(
  caseId: number,
  verdict: ConfidenceVerdict,
): Promise<void> {
  await invoke("confidence_save", {
    input: {
      caseId,
      verdictJson: JSON.stringify(verdict),
      updatedAt: new Date().toISOString(),
    },
  });
}

/** Read the stored verdict for a case, or null if none. */
export async function getConfidence(
  caseId: number,
): Promise<ConfidenceVerdict | null> {
  const row = await invoke<ConfidenceRow | null>("confidence_get", { caseId });
  return parseRow(row);
}

/** Batch read — returns a Map keyed by case id (missing ids absent). */
export async function getConfidenceMany(
  caseIds: number[],
): Promise<Map<number, ConfidenceVerdict>> {
  const out = new Map<number, ConfidenceVerdict>();
  if (caseIds.length === 0) return out;
  const rows = await invoke<ConfidenceRow[]>("confidence_get_many", { caseIds });
  for (const row of rows) {
    const v = parseRow(row);
    if (v) out.set(row.caseId, v);
  }
  return out;
}
