// "Can this failure be resumed?" — the one shared answer for every BYOK surface.
//
// Long agentic runs die for a small, recurring set of reasons: a per-minute rate
// limit outlasting the retry budget, a 402, the Rust proxy's 120s idle timeout, a
// dropped socket, a revoked key, a user abort. All of those leave the accumulated
// transcript intact and worth continuing from — a context overflow does not, since
// a resumed request is a strict SUPERSET of the one that already didn't fit.
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
 *  though GeneratorPane checks it first: overflow is the only NON-resumable kind,
 *  so a false positive is the one mistake that costs the user their transcript —
 *  and 429 bodies routinely quote token counts ("would exceed … 400,000 input
 *  tokens per minute"). `network` is last because `timeout` / `connection reset`
 *  are the broadest strings here. */
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

export function classifyForResume(e: unknown): ResumeClass {
  // An abort carries no useful message (the SDK's is generic), so identify it by
  // name before any pattern matching.
  if ((e as { name?: string } | null | undefined)?.name === "AbortError") {
    return { kind: "abort", resumable: true };
  }
  const kind = matchErrorKind(errorText(e));
  return { kind, resumable: kind !== "context-overflow" };
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
