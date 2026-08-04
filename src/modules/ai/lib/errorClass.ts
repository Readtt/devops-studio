// "Can this failure be resumed?" — the one shared answer for every BYOK surface.
//
// Long agentic runs die for a small, recurring set of reasons: a per-minute rate
// limit outlasting the retry budget, a 402, the Rust proxy's 120s idle timeout, a
// dropped socket, a revoked key, a user abort. All of those leave the accumulated
// transcript intact and worth continuing from.
//
// `context-overflow` used to be carved out as the one hard no, on the grounds
// that "a resumed request is a strict SUPERSET of the one that already didn't
// fit". That was true of the implementation it described and is no longer true
// of this one: `resumePolicy.resumeBudget` and `runCommitReview.resumeArgs` now
// run the stored transcript through `compactForResume` before replaying it, at a
// budget tightened specifically when the previous attempt overflowed — so the
// resumed request is a SUBSET. Keeping the carve-out cost the user everything it
// was meant to protect: the checkpoint was written with the full transcript and
// then hidden at every render site, which (because Discard lived inside
// ResumeCard) also made it undiscardable. Overflow is now resumable like any
// other transport failure.
//
// `empty` and `schema_violation` were the same bug in a second costume, found
// the same way — by a run losing work. They were flat "no"s justified by "the
// model ANSWERED, so there's no partial work to continue". True of a run that
// returns nothing on step one; false of one that spent 22 steps and 1.7M tokens
// reading the codebase and then failed only the last hop. They now depend on
// `ResumeProgress`: answered-badly plus real banked work is resumable, and
// replays with FINISH_NOW_NUDGE exactly as a budget-exhausted run does.
//
// GeneratorPane's classifyError stays the place that writes user-facing
// remediation copy (title / why / steps); this file answers only the narrower
// resumability question, so the two can't drift on whether Resume is offered.

export type ResumeErrorKind =
  | "rate-limit"
  | "overloaded"
  | "no-credits"
  | "network"
  | "stall"
  | "auth"
  | "context-overflow"
  | "abort"
  | "unknown";

export type ResumeClass = { kind: ResumeErrorKind; resumable: boolean };

/** Literal emitted by src-tauri/src/modules/net.rs on the 120s idle timeout. */
export const STALL_MESSAGE =
  "AI stream stalled — no data from the provider for 120s";

/** Ordered most-specific-first; the first hit wins.
 *
 *  Two orderings are deliberate. Billing (402 / credit balance) is tested before
 *  the generic 4xx bucket so "insufficient credits" isn't reported as a rate
 *  limit, and `context-overflow` is tested AFTER the provider-load kinds even
 *  though GeneratorPane checks it first: 429 bodies routinely quote token counts
 *  ("would exceed … 400,000 input tokens per minute"), and a rate limit
 *  misfiled as an overflow would resume at the aggressive eviction budget and
 *  throw away tool results the run still needed. (Before Phase 4 the same
 *  ordering existed for a sharper reason — overflow was non-resumable, so the
 *  false positive cost the user their whole transcript.) `network` is last
 *  because `timeout` / `connection reset` are the broadest strings here. */
const PATTERNS: ReadonlyArray<readonly [ResumeErrorKind, RegExp]> = [
  // Substring, not exact: the Rust message may gain a suffix (retry hint, url).
  ["stall", /ai stream stalled/],
  [
    "no-credits",
    /\b402\b|payment required|insufficient.*(credit|quota)|insufficient_quota|out of credit|credit balance/,
  ],
  ["rate-limit", /\b429\b|rate.?limit|too many requests/],
  [
    "overloaded",
    /over.?loaded|\b529\b|\b503\b|\b502\b|service unavailable/,
  ],
  [
    "auth",
    /\b401\b|unauthorized|invalid.*api.?key|invalid x-api-key|bad.?pat|forbidden|permission|authentication|configure an api key|no api key configured|missing.*api.?key|api key.*not.*set|sso/,
  ],
  [
    "context-overflow",
    /context length|context window|context_length_exceeded|maximum context|exceed.*context|prompt is too long|input.*too long|too long.*tokens|too many tokens|tokens.*(maximum|exceed)|reduce the length/,
  ],
  [
    "network",
    /network|timeout|econnreset|enotfound|fetch failed|failed to fetch|load failed|getaddrinfo|dns|connection (refused|reset)|private\/loopback|no safe ips|host not allowed|error sending request/,
  ],
];

/** Bucket a raw provider/runtime message. Unmatched ⇒ "unknown", which stays
 *  resumable — worst case the user spends one wasted request finding out. */
export function matchErrorKind(message: string): ResumeErrorKind {
  const lower = message.toLowerCase();
  for (const [kind, re] of PATTERNS) if (re.test(lower)) return kind;
  return "unknown";
}

/** Whether a resume attempt can plausibly succeed for this error kind.
 *
 *  Every kind qualifies. The parameter stays because this is the seam the whole
 *  app asks the question through, and a future kind that genuinely cannot be
 *  continued (a provider retiring a model mid-run, say) belongs here rather than
 *  re-litigated at five render sites. See the file header for why
 *  `context-overflow` stopped being the exception. */
export function isResumableKind(_kind: ResumeErrorKind): boolean {
  return true;
}

export function classifyForResume(e: unknown): ResumeClass {
  // An abort carries no useful message (the SDK's is generic), so identify it by
  // name before any pattern matching.
  if ((e as { name?: string } | null | undefined)?.name === "AbortError") {
    return { kind: "abort", resumable: isResumableKind("abort") };
  }
  const kind = matchErrorKind(errorText(e));
  return { kind, resumable: isResumableKind(kind) };
}

/** The AI SDK wraps transport failures, so the useful string is often on
 *  `cause` rather than the outer error. Read both, cheaply. */
function errorText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  const parts: string[] = [];
  const outer = e as { message?: unknown; cause?: unknown };
  if (typeof outer.message === "string") parts.push(outer.message);
  const cause = outer.cause as { message?: unknown } | null | undefined;
  if (cause && typeof cause.message === "string") parts.push(cause.message);
  return parts.length > 0 ? parts.join(" ") : String(e);
}

/** What the failed attempt actually banked, for the two outcomes whose
 *  resumability depends on it rather than on the error alone. Structural so this
 *  module still doesn't import checkpoint types (checkpointApi imports FROM
 *  errorClass — keep the dependency one-way).
 *
 *  Both fields are optional and both must be affirmatively present for work to
 *  count, so a caller that hasn't been taught to pass this gets the old, safe
 *  answer instead of an accidental yes. */
export type ResumeProgress = {
  /** Agentic steps the attempt completed. */
  stepsUsed?: number;
  /** Whether a non-empty transcript survived to the checkpoint. `stepsUsed`
   *  alone isn't enough: `capPayloadSize` degrades an oversized payload to
   *  `transcript: null`, which leaves a run that took 22 steps with nothing to
   *  replay. */
  hasTranscript?: boolean;
};

/** Whether there is bought-and-paid-for research a resume could continue from.
 *
 *  This is the distinction `empty` and `schema_violation` were missing. Both
 *  used to be flat "no", on the reasoning that the model ANSWERED — just
 *  uselessly — so there was nothing partial to continue. That premise holds for
 *  a run that returned nothing on step one. It is flatly false for a run that
 *  spent 22 steps and 1.7M tokens reading the codebase and then fumbled the last
 *  hop: the transcript is full of file reads, and only the final answer is
 *  missing. Replaying that transcript with {@link FINISH_NOW_NUDGE} is the
 *  cheapest possible recovery, and it is the same recovery a budget-exhausted
 *  run already gets. */
export function hasContinuableWork(
  progress: ResumeProgress | null | undefined,
): boolean {
  return (progress?.stepsUsed ?? 0) > 0 && progress?.hasTranscript === true;
}

/** Why a run came back with no usable answer, in one clause, keyed on the
 *  provider's own `finishReason` for the model's LAST step.
 *
 *  Written because "the model returned an empty response — turn on JSON mode"
 *  was being said to every empty result, and it is only true of one of them.
 *  A 22-step run that reads the codebase and then returns nothing is not a
 *  connector that can't do structured output; sending that user to a JSON-mode
 *  setting is sending them to the wrong place entirely. The three finish
 *  reasons that produce an empty or unreadable answer mean three different
 *  things and want three different next actions:
 *
 *  - `length`  — the response hit the output-token ceiling. With a reasoning
 *                model the thinking block spends that budget too, so the step
 *                can end with reasoning and NO text at all, which is
 *                indistinguishable from silence unless you look here.
 *  - `stop`    — the model chose to end its turn and wrote nothing. It
 *                wandered; a resume with the finish-now nudge is the fix.
 *  - `tool-calls` — the loop was cut off while still reading. That's a budget
 *                stop, and `step_cap` copy already covers it.
 *
 *  `undefined` (no steps reported, or an endpoint that reports nothing) falls
 *  back to the connector wording, which is where it was actually earned. */
export function emptyAnswerCause(
  kind: "empty" | "schema_violation",
  finishReason: string | undefined,
): string {
  if (finishReason === "length") {
    return kind === "empty"
      ? "The model hit its output-token ceiling before writing anything readable. On a reasoning model the thinking itself spends that budget, so the reply can end up empty. A model with a larger output limit, or a narrower spec, is the fix."
      : "The model hit its output-token ceiling partway through its answer, so what came back was cut off mid-structure. A model with a larger output limit, or a narrower spec, is the fix.";
  }
  if (finishReason === "stop") {
    return kind === "empty"
      ? "The model ended its turn without writing an answer at all — it read the code but never wrote the batch."
      : "The model ended its turn with output this run couldn't read, and nothing usable could be salvaged from it.";
  }
  return kind === "empty"
    ? "The model returned an empty response — no answer came back. OpenAI-compatible or custom endpoints often need JSON mode (structured output) turned on before they return a usable result."
    : "The model's response couldn't be read as the structured format expected, and nothing usable could be salvaged from it. This is common with OpenAI-compatible or custom endpoints that don't fully support structured JSON output.";
}

/** One clause explaining why Resume isn't on offer, for the surfaces that still
 *  have a checkpoint to show (and to DISCARD — see ResumeCard's second mode). A
 *  card that just quietly loses its main button reads as broken, and the reasons
 *  are genuinely different: the model gave us nothing, it gave us nonsense, or
 *  it did real work whose transcript was too big to keep. Only ever called when
 *  {@link canOfferResume} already said no. */
export function resumeUnavailableReason(
  outcome: { kind: string } | null | undefined,
  progress?: ResumeProgress | null,
): string {
  // Steps were taken but no transcript survived — the payload was too big for a
  // checkpoint row and degraded to inputs-only. Saying "the model returned
  // nothing" there blames the model for our own storage limit.
  const workWithoutTranscript =
    (progress?.stepsUsed ?? 0) > 0 && progress?.hasTranscript !== true;
  // One clause each. It sits under a fact line that already says how far the
  // run got, beside a Discard button whose own tooltip already says what
  // Discard does — three overlapping paragraphs about the same checkpoint was
  // more than the situation warrants.
  if (workWithoutTranscript) {
    return "Its transcript was too large to save, so there's nothing left to continue from — re-run.";
  }
  switch (outcome?.kind) {
    case "empty":
      return "The model returned nothing to continue from — re-run.";
    case "schema_violation":
      return "The model answered with output this run couldn't read, having read nothing first — re-run, ideally on a more capable model.";
    default:
      return "This saved progress can't be continued — re-run.";
  }
}

/** UI gate for offering a Resume affordance, shared by the generator and
 *  commit-review panes. Judges only what it's handed: callers must separately
 *  check that a checkpoint exists at all (a missing checkpoint and a checkpoint
 *  with a null outcome — an unflushed crash — are different things; only the
 *  latter defaults to resumable here).
 *
 *  `progress` is what decides the two ANSWERED-BADLY outcomes. See
 *  {@link hasContinuableWork} for why a flat "no" was the same data-loss bug
 *  `context-overflow` used to have: a resume gate whose justification stopped
 *  being true. Omitting it keeps the old answer, so an un-updated call site
 *  fails closed. */
export function canOfferResume(
  outcome:
    | { kind: string; errorKind?: ResumeErrorKind; message?: string }
    | null
    | undefined,
  errorMessage?: string | null,
  progress?: ResumeProgress | null,
): boolean {
  if (!outcome) return true;
  switch (outcome.kind) {
    case "step_cap":
    case "cancelled":
      return true;
    case "empty":
    case "schema_violation":
      return hasContinuableWork(progress);
    case "error":
      return isResumableKind(
        outcome.errorKind ?? matchErrorKind(errorMessage ?? outcome.message ?? ""),
      );
    default:
      return false;
  }
}
