// Pure decisions the generator's resume path makes, split out of the session
// store so they're directly unit-testable (the store is a factory over Tauri
// IPC; these are arithmetic and a branch).

import { RESUME_TOPUP_STEPS, SURFACE_STEP_CAPS } from "@/modules/ai/config";
import {
  FINISH_NOW_NUDGE,
  type CheckpointOutcome,
  type CheckpointUsage,
  type TranscriptCheckpoint,
} from "@/modules/ai/lib/checkpointApi";
import type { ModelMessage } from "ai";

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
] as const;

/** A count that isn't a real finite number is treated as ABSENT, not 0 — a
 *  persisted checkpoint can carry `null`/`NaN` from a provider that reported
 *  garbage, and adding that in would turn the whole cumulative total into NaN. */
function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Add a call's usage onto the total carried across earlier resumes. A field
 *  neither side reported stays absent rather than becoming a confident 0. */
export function sumUsage(
  base: CheckpointUsage | undefined,
  next: CheckpointUsage | undefined,
): CheckpointUsage {
  const out: CheckpointUsage = {};
  for (const k of USAGE_FIELDS) {
    const a = finite(base?.[k]);
    const b = finite(next?.[k]);
    if (a === undefined && b === undefined) continue;
    out[k] = (a ?? 0) + (b ?? 0);
  }
  return out;
}

export type ResumeBudget = {
  /** Step cap for the resumed call. */
  cap: number;
  /** Continuation transcript to hand the runner, or undefined to start the
   *  loop fresh from the (still-persisted) prompt. */
  resumeMessages: ModelMessage[] | undefined;
};

/** How much budget a resume gets, and what transcript it continues from.
 *
 *  A run that died mid-loop (error / cancel) gets its full budget back — it
 *  never got to finish investigating. A run that BURNED its budget gets only a
 *  top-up plus an explicit "stop reading, answer now" turn, so a model stuck in
 *  a tool loop converges instead of spending another full budget the same way.
 *
 *  Structurally typed rather than tied to one payload: analyze and review-phase
 *  follow-ups run the same engine under the same cap, so they must not drift on
 *  what a resume is allowed to spend. */
export function resumeBudget(payload: {
  lastOutcome: CheckpointOutcome | null;
  transcript: TranscriptCheckpoint | null;
}): ResumeBudget {
  const prior = payload.transcript?.messages;
  if (payload.lastOutcome?.kind === "step_cap") {
    return {
      cap: RESUME_TOPUP_STEPS,
      resumeMessages: [
        ...(prior ?? []),
        { role: "user", content: FINISH_NOW_NUDGE },
      ],
    };
  }
  return { cap: SURFACE_STEP_CAPS.generator, resumeMessages: prior };
}
