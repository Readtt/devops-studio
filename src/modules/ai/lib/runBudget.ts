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
// Summing `inputTokens` across steps counts the re-sent transcript once per
// step, which is exactly what the provider billed and exactly what a spend
// budget should bound. It is NOT a context reading: how full the window is, is
// ONE step's own `inputTokens`, which is `measureRequestContext`'s job in
// contextEstimate.ts and what eviction hangs off. Swap the two and you get a
// budget a 30-step run of small requests can never trip, and an eviction
// trigger that fires on step 3 of a healthy run.

import { stepCountIs, type StopCondition, type ToolSet } from "ai";

/** The usage fields a spend reading needs. Structural so it accepts both the
 *  SDK's `LanguageModelUsage` and our own persisted {@link TaskUsage}. */
export type SpendUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

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

/** Tokens ONE step consumed: the request it sent plus the text it wrote.
 *
 *  `inputTokens` already includes cache reads (the SDK maps it from
 *  `inputTokens.total`). A cached token is cheaper, not free, and it is still a
 *  token the run spent — netting them out here would understate a long agentic
 *  loop by ~10x, which is the whole shape of the thing being budgeted.
 *
 *  Falls back to `totalTokens` only when the split is missing entirely, which is
 *  what some OpenAI-compatible endpoints report. */
export function stepSpend(usage: SpendUsage | undefined | null): number {
  if (!usage) return 0;
  const io = finite(usage.inputTokens) + finite(usage.outputTokens);
  return io > 0 ? io : finite(usage.totalTokens);
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
