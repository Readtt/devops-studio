// What one agentic call is allowed to SPEND, and the stop conditions that
// enforce it.
//
// A step was always a poor unit for this. One step can be a 200-token "call
// read_file" turn or a 60,000-token file read, so a step cap rations a quantity
// nobody cares about and leaves the one they do — tokens, and therefore money —
// unbounded. The reported failure is what that looks like from the outside: a
// run cut off at 24/24 having barely read anything, next to a run that filled a
// 1M-token window in far fewer steps than that.
//
// So the token budget is the primary control and the step ceiling is kept only
// as a RUNAWAY GUARD. It still has two jobs the token budget structurally cannot
// do: catch a loop that spends almost nothing per step (a model re-calling the
// same zero-result grep forever), and catch anything at all on an endpoint that
// reports no usage — local servers routinely return none, and a budget measured
// in tokens nobody counted is no budget.
//
// SPEND, NOT OCCUPANCY — the distinction this module exists to keep straight.
// Summing across steps counts the re-sent transcript once per step, which is
// exactly what the provider billed and exactly what a spend budget should
// bound. It is NOT a context reading: how full the window is, is ONE step's own
// `inputTokens`, which is `measureRequestContext`'s job in contextEstimate.ts
// and what eviction hangs off. Swap the two and you get a budget a 30-step run
// of small requests can never trip, and an eviction trigger that fires on step
// 3 of a healthy run.
//
// COST-EQUIVALENT, NOT RAW — the second distinction, and the one this module
// got wrong first time round. It summed `inputTokens + outputTokens`, defending
// that with "a cached token is cheaper, not free". True, and beside the point:
// that is a coherant measure of WORK, and the product constraint is COST. The
// consequence was perverse. The caching work made runs roughly ten times
// cheaper and the budget could not see a penny of it — a run at 86% cache
// exhausted its budget at exactly the same rate as an uncached one, so the
// readout said "28% of budget consumed" about roughly 4% of the equivalent
// spend, and legitimate long runs were cut off to protect money nobody was
// spending.
//
// So a "token" here is a COST-EQUIVALENT one, normalised to a fresh input
// token. That single change gives the budget a property it could not have
// before: the most a run can cost is `budget × the model's fresh-input rate`,
// invariant to how well the cache hit and invariant to the input/output mix.
// A well-cached run therefore gets far more real work out of the same ceiling
// (at 86% cache, roughly 4x the raw tokens) while an uncached one — which
// genuinely costs full price — is bound exactly where it was. The budget
// numbers themselves are unchanged for that reason: their DOLLAR ceiling is
// what stayed fixed, and it is the uncached case that sets it.

import { stepCountIs, type StopCondition, type ToolSet } from "ai";

/** The usage fields a spend reading needs. Structural so it accepts both the
 *  SDK's `LanguageModelUsage` and our own persisted {@link TaskUsage}. */
export type SpendUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** How many of `inputTokens` were served from the prompt cache. Absent is NOT
   *  zero — it means the provider reported no cache detail — but it bills the
   *  same way from here, at the fresh rate, which is the conservative read. */
  cacheReadTokens?: number;
  /** The SDK's own nesting for the same number, read because this type has TWO
   *  callers with different shapes and they must not disagree. The accumulator
   *  hands over a flattened {@link TaskUsage}; the `stopWhen` condition is
   *  handed the SDK's raw `LanguageModelUsage` steps. Reading only the flat
   *  field would make the stop condition count every cached token at the FRESH
   *  rate while the accumulator discounted it — the run would then stop at a
   *  number the readout never reached, and `limitReached` would disagree with
   *  the stop the SDK actually made. Same precedence as `toTaskUsage`. */
  inputTokenDetails?: { cacheReadTokens?: number };
  /** Deprecated alias some providers still populate. */
  cachedInputTokens?: number;
};

/** Cache reads from whichever shape this usage record uses. */
function cacheReadsOf(usage: SpendUsage): number {
  return finite(
    usage.cacheReadTokens ??
      usage.inputTokenDetails?.cacheReadTokens ??
      usage.cachedInputTokens,
  );
}

/** What a cached input token costs relative to a fresh one.
 *
 *  A flat factor rather than each model's own `MODEL_PRICING.cacheRead / input`
 *  ratio, deliberately. Every priced model in the table sits at 0.1 (5→0.5,
 *  3→0.3, 0.4→0.04, 0.28→0.028) bar one outlier, so per-model precision buys
 *  almost nothing — and it costs two things worth more than it. `MODEL_PRICING`
 *  covers about a third of `MODEL_CONTEXT_LIMITS`, so budgets would silently
 *  mean something different on the other two thirds; and the same run against
 *  two models would consume different fractions of the same budget for a reason
 *  the user cannot see. One factor keeps the number comparable. */
export const CACHED_INPUT_COST_FACTOR = 0.1;

/** What an output token costs relative to a fresh input one. Anthropic and
 *  OpenAI both price output at 3–5x input (Claude 5: $3→$15 and $5→$25).
 *
 *  This matters BECAUSE of the discount above, not despite it. At the raw sum
 *  output was a rounding error next to a re-sent transcript, which is why it
 *  rode at 1x. Discount the cache reads tenfold and input collapses while
 *  output does not: on the observed 86%-cache step, output goes from under 1%
 *  of the step to around 10% of it. Left at 1x the metric would drift low on
 *  exactly the runs it is now sized for. */
export const OUTPUT_COST_FACTOR = 5;

export type RunBudget = {
  /** Tokens this call may spend before it is stopped. */
  tokens: number;
  /** Step ceiling. A guard against a runaway that never spends, not a ration. */
  steps: number;
};

/** Which guard ended the loop. */
export type BudgetLimit = "tokens" | "steps";

/** A count that isn't a real positive number contributes nothing rather than
 *  poisoning the sum — a provider that reports `null`/`NaN` must not turn the
 *  whole budget into NaN, which compares false against everything and would
 *  silently disable the stop condition. */
function finite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** What ONE step cost, in fresh-input-token equivalents.
 *
 *  `inputTokens` already includes cache reads (the SDK maps it from
 *  `inputTokens.total`), so the fresh part is the difference. Clamped at zero
 *  because a provider reporting more cache reads than input is reporting
 *  nonsense, and a negative step would let a long run spend forever.
 *
 *  Falls back to `totalTokens` at face value only when the split is missing
 *  entirely, which is what some OpenAI-compatible endpoints report. There is
 *  nothing to weight there — no split means no cache detail and no output
 *  count — so it is charged as if every token were fresh input. That is the
 *  conservative reading, and it is also true of most such endpoints, which
 *  don't cache. */
export function stepSpend(usage: SpendUsage | undefined | null): number {
  if (!usage) return 0;
  const input = finite(usage.inputTokens);
  const output = finite(usage.outputTokens);
  if (input <= 0 && output <= 0) return finite(usage.totalTokens);
  const cached = Math.min(cacheReadsOf(usage), input);
  const fresh = Math.max(0, input - cached);
  return (
    fresh + cached * CACHED_INPUT_COST_FACTOR + output * OUTPUT_COST_FACTOR
  );
}

/** Everything the completed steps have spent so far. */
export function totalSpend(
  steps: readonly { usage?: SpendUsage }[] | undefined,
): number {
  if (!steps) return 0;
  let total = 0;
  for (const s of steps) total += stepSpend(s.usage);
  return total;
}

/** The token-budget `stopWhen` condition.
 *
 *  STATELESS BY CONSTRUCTION. The SDK evaluates every stop condition after every
 *  step (`Promise.all(...).some(...)`), and nothing promises it evaluates each
 *  one exactly once — a closure that incremented a counter would double-count
 *  the moment that changed, and would also carry state across the retry that
 *  re-streams a whole attempt. Re-summing the steps array it is handed is O(n)
 *  on an n of at most a few dozen and cannot drift.
 *
 *  A non-positive budget disables the condition rather than stopping the run
 *  before step 1 — the step guard is then the only control, which is the same
 *  posture as an endpoint that reports no usage. */
export function tokenBudgetIs(tokens: number): StopCondition<ToolSet> {
  if (!Number.isFinite(tokens) || tokens <= 0) return () => false;
  return ({ steps }) => totalSpend(steps) >= tokens;
}

/** The `stopWhen` array a tool-bearing call installs. Conditions are OR'd by the
 *  SDK, so the loop ends at whichever binds first. */
export function runStopConditions(budget: RunBudget): StopCondition<ToolSet>[] {
  return [tokenBudgetIs(budget.tokens), stepCountIs(budget.steps)];
}

/** Which guard stopped this loop, or null if neither did.
 *
 *  Evaluated after the fact against the same numbers the stop conditions saw, so
 *  the two can't disagree — the accumulator sums with {@link stepSpend} and so
 *  does {@link totalSpend}. Tokens win a tie: it's the budget the user is shown
 *  and the one they top up, and a run that exhausted both exhausted that one.
 *
 *  This says nothing about whether the run FAILED — a loop that answers on its
 *  last allowed step succeeded. The caller pairs this with the finish reason. */
export function limitReached(args: {
  tokensUsed: number;
  stepsUsed: number;
  budget: RunBudget;
}): BudgetLimit | null {
  const { tokens, steps } = args.budget;
  if (Number.isFinite(tokens) && tokens > 0 && args.tokensUsed >= tokens) {
    return "tokens";
  }
  if (args.stepsUsed >= steps) return "steps";
  return null;
}

/** What the run ran out OF, in one clause, for the surfaces that have to say so
 *  ("… spent its whole <this> before it could write the batch").
 *
 *  Both stores and both error panels render this, so a QA tester reads the same
 *  noun everywhere, and a checkpoint written before this existed — `limit`
 *  absent — falls back to a phrase that asserts neither guard rather than
 *  blaming steps for a token stop. */
export function budgetSpentPhrase(
  limit: BudgetLimit | undefined,
  budget: RunBudget,
  formatTokenCount: (n: number) => string,
): string {
  if (limit === "steps") return `all ${budget.steps} steps it was allowed`;
  if (limit === "tokens") {
    return `its whole ~${formatTokenCount(budget.tokens)}-token budget`;
  }
  return "its whole budget";
}
