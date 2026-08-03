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

/** UI gate for offering a Resume affordance, shared by the generator and
 *  commit-review panes. Structural param so this module doesn't import
 *  checkpoint types (checkpointApi imports FROM errorClass — keep the
 *  dependency one-way). Judges only the outcome it's handed: callers must
 *  separately check that a checkpoint exists at all (a missing checkpoint and
 *  a checkpoint with a null outcome — an unflushed crash — are different
 *  things; only the latter defaults to resumable here). */
/** One clause explaining why Resume isn't on offer, for the surfaces that still
 *  have a checkpoint to show (and to DISCARD — see ResumeCard's second mode). A
 *  card that just quietly loses its main button reads as broken, and the two
 *  reasons are genuinely different: one says the model gave us nothing, the
 *  other that it gave us nonsense. Only ever called when
 *  {@link canOfferResume} already said no. */
export function resumeUnavailableReason(
  outcome: { kind: string } | null | undefined,
): string {
  switch (outcome?.kind) {
    case "empty":
      return "The model returned nothing to continue from, so a resume would replay an empty transcript and fail the same way. Re-run instead.";
    case "schema_violation":
      return "The model answered with output this run couldn't read, so continuing that transcript would only reproduce it. Re-run instead — a more capable model usually fixes it.";
    default:
      return "This saved progress can't be continued. Re-run instead.";
  }
}

export function canOfferResume(
  outcome:
    | { kind: string; errorKind?: ResumeErrorKind; message?: string }
    | null
    | undefined,
  errorMessage?: string | null,
): boolean {
  if (!outcome) return true;
  switch (outcome.kind) {
    case "step_cap":
    case "cancelled":
      return true;
    case "empty":
    case "schema_violation":
      return false;
    case "error":
      return isResumableKind(
        outcome.errorKind ?? matchErrorKind(errorMessage ?? outcome.message ?? ""),
      );
    default:
      return false;
  }
}
