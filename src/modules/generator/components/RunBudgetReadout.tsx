import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { estimateCost, type ModelId } from "@/modules/ai/config";
import { formatCostUsd, formatTokens } from "@/modules/ai/lib/contextEstimate";
import { CacheHitReadout } from "@/modules/ai/components/CacheHitReadout";

/** The live "how much has this run spent" line in the analyzing header.
 *
 *  Leads with the TOKEN budget because that is what actually rations the run:
 *  the step ceiling behind it is a runaway guard now, and counting up to a
 *  ceiling nobody is meant to reach reads as a deadline that isn't one. The
 *  dollar figure in the tooltip is the number a QA tester can act on, but it is
 *  computed from real usage rather than by projecting the budget forward — a
 *  "$1.60 of budget remaining" would be a fabricated precision, since what it
 *  costs depends on how much of the next request the prompt cache absorbs.
 *
 *  Falls back to the step count when the provider reported no usage at all
 *  (local servers routinely don't). A budget readout stuck at "~0" for a run
 *  that is plainly working reads as broken, and on exactly those endpoints the
 *  step ceiling IS the live guard — so showing it is also the honest thing. */
export function RunBudgetReadout(props: {
  tokensUsed: number | null;
  tokenBudget: number | null;
  tokensInput: number | null;
  tokensCached: number | null;
  peakPromptTokens: number | null;
  stepsUsed: number | null;
  stepCap: number | null;
  modelId: ModelId;
  elapsed: string;
}) {
  const { tokensUsed, tokenBudget, stepsUsed, stepCap, elapsed } = props;
  // The step IN PROGRESS, not the completed count — "step 1" while the first
  // model turn runs, instead of a "0" that reads as stuck. stepsUsed only ticks
  // when a turn completes.
  const stepNow = Math.min((stepsUsed ?? 0) + 1, stepCap ?? Infinity);
  // Fall back only once a step has completed and STILL reported nothing — that
  // is what tells us the endpoint doesn't count. Testing `tokensUsed > 0` alone
  // would show the step line for the first ten seconds of every run and then
  // flip units mid-run, which reads as a glitch.
  const measured =
    tokenBudget != null && !((stepsUsed ?? 0) > 0 && (tokensUsed ?? 0) === 0);
  if (tokenBudget == null && stepCap == null) return null;

  // Priced off the RAW input count and the real cache split — never off
  // `tokensUsed`, which is already cost-equivalent (cache reads discounted,
  // output weighted). Feeding that back through estimateCost would discount
  // the same cache reads a second time and halve the figure.
  const spentUsd = measured
    ? estimateCost(props.modelId, {
        inputTokens: props.tokensInput ?? 0,
        outputTokens: 0,
        cachedInputTokens: props.tokensCached ?? 0,
      })
    : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default text-[11px] tabular-nums text-muted-foreground">
            {measured
              ? `~${formatTokens(tokensUsed ?? 0)}/${formatTokens(tokenBudget)}`
              : `step ${stepNow}${stepCap != null ? `/${stepCap}` : ""}`}{" "}
            · {elapsed}
          </span>
        </TooltipTrigger>
        {/* What it costs and what happens at the end — nothing else. The
            mechanics of how the number is counted belong in runBudget.ts, not
            in a tooltip a user reads while watching a run. */}
        <TooltipContent side="bottom" className="max-w-[250px] text-[11px]">
          {measured ? (
            <>
              Spend budget
              {spentUsd != null ? ` — roughly ${formatCostUsd(spentUsd)} so far` : ""}
              . Counted by cost, so cached tokens barely move it. Running out
              stops the run with everything it read kept; you can top it up and
              resume.
            </>
          ) : (
            <>
              This endpoint reports no token usage, so the run is bounded by its{" "}
              {stepCap} reading steps. Running out stops it with everything it
              read kept; you can resume.
            </>
          )}
        </TooltipContent>
      </Tooltip>
      {/* Beside the spend, because neither number means much alone: the same
          token count costs ~10x more once the cache stops hitting, and this is
          the only place in the app where that difference is visible. */}
      {measured ? (
        <CacheHitReadout
          // RAW input, not the budget's cost-equivalent figure: the ratio IS
          // cacheReadTokens / inputTokens, and a denominator that already
          // discounted those reads would flatter every run toward 100%.
          inputTokens={props.tokensInput}
          cacheReadTokens={props.tokensCached}
          peakPromptTokens={props.peakPromptTokens}
          modelId={props.modelId}
        />
      ) : null}
    </>
  );
}

/** Milliseconds → "m:ss". */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Live elapsed time since `startedAt`, for the readout beside it. Ticks off a
 *  wall-clock timestamp rather than a counting ref so it stays correct across a
 *  tab switch (no drift from throttled background timers). Shared by the
 *  analyze phase and the follow-up strip so the two can't drift apart. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt != null ? formatElapsed(Math.max(0, now - startedAt)) : "0:00";
}
