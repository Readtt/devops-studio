// The prompt cache, made observable.
//
// Every agentic step re-sends the whole conversation, so the prompt cache — not
// the token count — is what decides whether a run costs $0.30 or $3.00. Cached
// input bills at roughly 10% of fresh, which means a run can get SMALLER in
// tokens and still cost more if the cache stopped hitting. That is the specific
// way eviction, a reordered prompt, or a per-step-varying prefix can quietly
// double the bill, and a token counter alone will never show it.
//
// So this chip shows the ratio, and its tooltip shows the raw numbers behind it,
// because the only useful thing to do with a cache hit ratio is compare two
// runs. Hover before a change, hover after, and the two numbers either match or
// they don't.

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { estimateCost, type ModelId } from "@/modules/ai/config";
import {
  cacheHitRatioOf,
  formatCostUsd,
  formatPercent,
  formatTokens,
} from "@/modules/ai/lib/contextEstimate";

export type CacheHitReadoutProps = {
  /** Tokens the run sent, summed across its steps. Already INCLUSIVE of cache
   *  reads — a cached token is cheaper, not absent. */
  inputTokens: number | null;
  /** How many of those were served from the prompt cache. Null when the
   *  provider reported no cache detail at all, which is not the same as zero. */
  cacheReadTokens: number | null;
  /** Largest single request the run made, from the provider's own count
   *  (`RequestContextSignal.promptTokens`). The other number worth comparing
   *  between two runs: it says how close the run came to the window. */
  peakPromptTokens?: number | null;
  /** Prices the difference the cache actually made. Omit to show tokens only. */
  modelId?: ModelId | null;
  className?: string;
};

/** Compact `cache 87%` chip with the raw counts in its tooltip. Renders nothing
 *  when the provider reported no input count at all — a run on an endpoint that
 *  doesn't meter has no ratio to show, and "0%" would be a lie about it. */
export function CacheHitReadout(props: CacheHitReadoutProps) {
  const { inputTokens, cacheReadTokens, peakPromptTokens, modelId } = props;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    inputTokens <= 0
  ) {
    return null;
  }
  const ratio = cacheHitRatioOf({ inputTokens, cacheReadTokens });
  const cached = cacheReadTokens ?? 0;
  const fresh = Math.max(0, inputTokens - cached);

  // What the cache saved, in money: the same spend priced with and without it.
  // Both figures come from the run's OWN usage, so this is a measurement rather
  // than a projection.
  const withCache =
    modelId != null
      ? estimateCost(modelId, {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: cached,
        })
      : null;
  const withoutCache =
    modelId != null
      ? estimateCost(modelId, {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
        })
      : null;
  const saved =
    withCache != null && withoutCache != null
      ? Math.max(0, withoutCache - withCache)
      : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-default text-[11px] tabular-nums text-muted-foreground",
            props.className,
          )}
        >
          cache {ratio == null ? "n/a" : formatPercent(ratio)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] text-[11px]">
        {ratio == null ? (
          <>
            This model's endpoint reports how many tokens it read (
            {formatTokens(inputTokens)}) but not how many came from its prompt
            cache, so there's no ratio to show. Cached input bills at roughly a
            tenth of fresh input, so on providers that do report it this is the
            number that decides what a run costs.
          </>
        ) : (
          <>
            {formatTokens(cached)} of the {formatTokens(inputTokens)} tokens this
            run sent were served from the prompt cache; {formatTokens(fresh)}{" "}
            were charged fresh.
            {saved != null && saved > 0
              ? ` That's about ${formatCostUsd(saved)} the cache saved.`
              : ""}
            {peakPromptTokens ? (
              <>
                {" "}
                Its largest single request was ~{formatTokens(peakPromptTokens)}{" "}
                tokens.
              </>
            ) : null}{" "}
            Compare this figure between two runs: if the token count improves
            while this falls, the run got cheaper to send and more expensive to
            pay for.
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
