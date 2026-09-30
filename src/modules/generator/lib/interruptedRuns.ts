import {
  getCheckpoint,
  hasReplayableTranscript,
  listCheckpoints,
  type GeneratorCheckpointV2,
} from "@/modules/ai/lib/checkpointApi";
import { canOfferResume, canRaiseOutputCap } from "@/modules/ai/lib/errorClass";
import { isKnownModelId } from "@/modules/ai/config";

/** An interrupted analyze recovered from its on-disk checkpoint — a run that
 *  never reached review (so it has no history row), whose tab is gone. */
export type InterruptedGenRun = {
  runId: string;
  updatedAt: string;
  payload: GeneratorCheckpointV2;
};

/** Orphaned-but-resumable generator checkpoints, newest first. Best-effort:
 *  a failed probe returns [] rather than failing the whole History pane. */
export async function loadInterruptedRuns(): Promise<InterruptedGenRun[]> {
  let entries: Awaited<ReturnType<typeof listCheckpoints>>;
  try {
    entries = await listCheckpoints("generator");
  } catch {
    return [];
  }
  const out: InterruptedGenRun[] = [];
  for (const e of entries.slice(0, 10)) {
    try {
      const cp = await getCheckpoint(e.runId);
      if (!cp || cp.payload.surface !== "generator") continue;
      const outcome = cp.payload.lastOutcome;
      // Same gate as every Resume affordance — a run that died non-resumably,
      // or answered badly with nothing banked, would just re-fail; don't list
      // it. A run that answered badly AFTER reading the codebase is exactly the
      // one worth listing: its transcript is the expensive part.
      const t = cp.payload.transcript;
      if (
        !canOfferResume(outcome, outcome?.message ?? null, {
          stepsUsed: t?.stepsUsed ?? 0,
          hasTranscript: hasReplayableTranscript(t),
          outputCapRaisable: canRaiseOutputCap(cp.payload.modelId, outcome),
          modelRetired: !isKnownModelId(cp.payload.modelId),
        })
      ) {
        continue;
      }
      out.push({ runId: e.runId, updatedAt: cp.updatedAt, payload: cp.payload });
    } catch {
      // skip this row
    }
  }
  return out;
}
