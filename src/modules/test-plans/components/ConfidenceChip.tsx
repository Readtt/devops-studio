import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTO_PASS_THRESHOLD,
  confidenceTone,
  type ConfidenceVerdict,
} from "../lib/confidence";
import { Loading03Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const OUTCOME_LABEL: Record<ConfidenceVerdict["predictedOutcome"], string> = {
  Pass: "Pass",
  Fail: "Fail",
  Blocked: "Blocked",
  Unknown: "Unknown",
};

/**
 * Confidence chip — shows the AI's calibrated prediction of whether a case
 * would pass against the current code. Color-graded with the OUTCOME_CHIP
 * tints (green ≥90 / amber 60-89 / red <60) so it reads next to the outcome
 * chips. The rich tooltip carries the predicted outcome, reasoning, the top
 * per-step evidence (file:line), and any caveats.
 *
 * Three states: a verdict (the chip), `loading` (evaluating…), or no verdict
 * with an `onEvaluate` handler (an "Evaluate" affordance).
 */
export function ConfidenceChip({
  verdict,
  loading,
  onEvaluate,
}: {
  verdict: ConfidenceVerdict | null | undefined;
  loading?: boolean;
  /** When provided and there's no verdict, renders an Evaluate button. Also
   *  exposed in the tooltip footer as "re-evaluate". */
  onEvaluate?: () => void;
}) {
  if (loading) {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-foreground/[0.06] px-1.5 text-[10px] font-medium text-muted-foreground">
        <HugeiconsIcon
          icon={Loading03Icon}
          size={10}
          strokeWidth={2}
          className="animate-spin"
        />
        Evaluating…
      </span>
    );
  }

  if (!verdict) {
    if (!onEvaluate) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onEvaluate}
            className="inline-flex h-5 items-center gap-1 rounded-sm border border-border/55 bg-card/60 px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <HugeiconsIcon icon={SparklesIcon} size={10} strokeWidth={1.75} />
            Evaluate
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
          Read the source and predict whether this case would pass, with a
          calibrated confidence %. May take a moment — it traces each step
          through the code.
        </TooltipContent>
      </Tooltip>
    );
  }

  const tone = confidenceTone(verdict.confidence);
  const pct = Math.round(verdict.confidence);
  const isAutoPass =
    verdict.predictedOutcome === "Pass" && verdict.confidence >= AUTO_PASS_THRESHOLD;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-5 cursor-default items-center gap-1 rounded-sm px-1.5 text-[10px] font-medium tabular-nums",
            tone.className,
          )}
        >
          {pct}%
          <span className="opacity-70">
            {OUTCOME_LABEL[verdict.predictedOutcome]}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" variant="panel" className="max-w-[320px] p-0">
        <div className="px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
              Confidence
            </span>
            <span className={cn("rounded-sm px-1.5 py-px text-[10px] font-medium", tone.className)}>
              {pct}% · {OUTCOME_LABEL[verdict.predictedOutcome]}
            </span>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug text-foreground">
            {isAutoPass
              ? "High confidence — auto-pass candidate."
              : verdict.predictedOutcome === "Unknown"
                ? "Couldn't ground this in code — needs manual testing."
                : "Below the 90% bar — flag for manual testing."}
          </p>
          {verdict.reasoning ? (
            <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
              {verdict.reasoning}
            </p>
          ) : null}
        </div>
        {verdict.evidence.length > 0 ? (
          <div className="border-t border-border/40 px-3 py-1.5">
            <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
              Evidence
            </div>
            <ul className="mt-1 flex flex-col gap-0.5">
              {verdict.evidence.slice(0, 6).map((e, i) => (
                <li key={i} className="text-[10.5px] leading-snug text-muted-foreground">
                  <span className="text-foreground/80">{e.step}.</span>{" "}
                  {e.finding}
                  {e.ref ? (
                    <span className="ml-1 font-mono text-[9.5px] text-foreground/65">
                      {e.ref}
                    </span>
                  ) : (
                    <span className="ml-1 text-[9.5px] italic text-rose-500/80">
                      unverified
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {verdict.caveats.length > 0 ? (
          <div className="border-t border-border/40 bg-foreground/[0.02] px-3 py-1.5">
            <div className="font-mono text-[9px] uppercase tracking-wider text-amber-600/90 dark:text-amber-400/90">
              Caveats
            </div>
            <ul className="mt-1 flex flex-col gap-0.5">
              {verdict.caveats.slice(0, 4).map((c, i) => (
                <li key={i} className="text-[10.5px] leading-snug text-muted-foreground">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {onEvaluate ? (
          <div className="border-t border-border/40 px-3 py-1.5">
            <button
              type="button"
              onClick={onEvaluate}
              className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Re-evaluate
            </button>
            {verdict.runs && verdict.runs > 1 ? (
              <span className="ml-2 text-[9.5px] text-muted-foreground/70">
                {verdict.runs} runs
              </span>
            ) : null}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
