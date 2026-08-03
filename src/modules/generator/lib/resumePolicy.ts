// Pure decisions the generator's resume path makes, split out of the session
// store so they're directly unit-testable (the store is a factory over Tauri
// IPC; these are arithmetic and a branch).

import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
} from "@/modules/ai/config";
import {
  FINISH_NOW_NUDGE,
  type CheckpointOutcome,
  type CheckpointUsage,
  type TranscriptCheckpoint,
} from "@/modules/ai/lib/checkpointApi";
import { compactForResume } from "@/modules/ai/lib/compactTranscript";
import { matchErrorKind } from "@/modules/ai/lib/errorClass";
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
  /** Runaway step ceiling for the resumed call. */
  cap: number;
  /** Tokens the resumed call may spend — the budget that actually rations it. */
  tokens: number;
  /** Continuation transcript to hand the runner, or undefined to start the
   *  loop fresh from the (still-persisted) prompt. */
  resumeMessages: ModelMessage[] | undefined;
};

/** Whether the failure being resumed from was the request not fitting. Prefers
 *  the recorded `errorKind` and falls back to re-bucketing the message, matching
 *  what `canOfferResume` does with the same two fields. */
export function diedOfContextOverflow(
  outcome: CheckpointOutcome | null | undefined,
): boolean {
  if (!outcome || outcome.kind !== "error") return false;
  return (
    (outcome.errorKind ?? matchErrorKind(outcome.message ?? "")) ===
    "context-overflow"
  );
}

/** How much budget a resume gets, and what transcript it continues from.
 *
 *  A run that died mid-loop (error / cancel) gets its full budget back — it
 *  never got to finish investigating. A run that BURNED its budget gets only a
 *  top-up plus an explicit "stop reading, answer now" turn, so a model stuck in
 *  a tool loop converges instead of spending another full budget the same way.
 *
 *  What gets topped up is the TOKEN budget; the step ceiling goes back to the
 *  full surface cap either way, because it is a runaway guard and a resume is no
 *  more likely to run away than the attempt before it. Granting 8 extra STEPS
 *  (what this replaces) rationed the wrong thing twice over: it let a resume
 *  re-read a 150k-token transcript eight times over, and it cut off a model that
 *  only needed a few cheap turns to write out what it already knew.
 *
 *  The transcript is compacted on the way out. At the live budget that is a
 *  deliberate no-op for anything an ordinary run produced — a rate limit or a
 *  dropped socket left a transcript that fit, and evicting out of it would
 *  degrade a resume that was going to work. A resume that follows an actual
 *  OVERFLOW runs at a much tighter budget, which is what makes the resumed
 *  request a subset of the one that didn't fit rather than a superset of it.
 *
 *  Structurally typed rather than tied to one payload: analyze and review-phase
 *  follow-ups run the same engine under the same cap, so they must not drift on
 *  what a resume is allowed to spend. */
export function resumeBudget(payload: {
  lastOutcome: CheckpointOutcome | null;
  transcript: TranscriptCheckpoint | null;
}): ResumeBudget {
  const stored = payload.transcript?.messages;
  const prior = stored
    ? compactForResume(stored, diedOfContextOverflow(payload.lastOutcome))
    : undefined;
  if (payload.lastOutcome?.kind === "step_cap") {
    return {
      cap: SURFACE_STEP_CAPS.generator,
      tokens: RESUME_TOPUP_TOKENS,
      resumeMessages: [
        ...(prior ?? []),
        { role: "user", content: FINISH_NOW_NUDGE },
      ],
    };
  }
  return {
    cap: SURFACE_STEP_CAPS.generator,
    tokens: SURFACE_TOKEN_BUDGETS.generator,
    resumeMessages: prior,
  };
}
