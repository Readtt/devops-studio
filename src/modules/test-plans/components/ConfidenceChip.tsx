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
 * chips.
 *
 * The chip stays compact: a single % + outcome pill. Clicking it opens the
 * confidence detail *pane* (via `onOpenDetail`) — a workspace tab with the
 * full reasoning, per-step evidence (clickable file:line that opens code
 * beside it), and caveats. It used to open a drawer that covered the screen;
 * a pane lets the reasoning and the code sit side by side.
 *
 * States: a verdict (clickable chip), `loading` with no verdict yet
 * (Evaluating…), or no verdict with an `onEvaluate` handler (Evaluate button).
 */
export function ConfidenceChip({
  verdict,
  loading,
  onEvaluate,
  onOpenDetail,
}: {
  verdict: ConfidenceVerdict | null | undefined;
  loading?: boolean;
  /** When provided, enables a first evaluation (the Evaluate button). */
  onEvaluate?: () => void;
  /** Opens the confidence detail pane. Called when the verdict chip is
   *  clicked. */
  onOpenDetail?: () => void;
}) {
  // Nothing to show and no way to make something appear.
  if (!verdict && !loading && !onEvaluate) return null;

  // First-time evaluation (no prior verdict): a quiet, non-interactive pill.
  if (loading && !verdict) {
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

  // No verdict yet, but we can make one — show the Evaluate affordance.
  if (!verdict) {
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
        <TooltipContent
          variant="panel"
          side="bottom"
          align="start"
          className="max-w-[300px] px-3 py-2 text-[11px] leading-relaxed"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                confidence
              </span>
              <span className="font-medium text-foreground/90">
                Predict the outcome
              </span>
            </div>
            <p className="text-foreground/80">
              Reads the source and predicts whether this case would pass, with
              a calibrated confidence %.
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              Takes a moment — it traces each step through the code.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  const tone = confidenceTone(verdict.confidence);
  const pct = Math.round(verdict.confidence);

  const isAutoPass =
    verdict.confidence >= AUTO_PASS_THRESHOLD &&
    verdict.predictedOutcome === "Pass";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onOpenDetail?.()}
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-[10px] font-medium tabular-nums transition-[filter] hover:brightness-95 dark:hover:brightness-110",
            tone.className,
          )}
        >
          {loading ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={9}
              strokeWidth={2}
              className="animate-spin"
            />
          ) : null}
          {pct}%
          <span className="opacity-70">
            {OUTCOME_LABEL[verdict.predictedOutcome]}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        variant="panel"
        side="bottom"
        align="start"
        className="max-w-[300px] px-3 py-2 text-[11px] leading-relaxed"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
              verdict
            </span>
            <span className="font-medium tabular-nums text-foreground/90">
              {pct}% · {OUTCOME_LABEL[verdict.predictedOutcome]}
            </span>
          </div>
          <p className="text-foreground/80">
            {isAutoPass
              ? "At or above the 90% bar — auto-pass candidate."
              : "Below the 90% auto-pass bar — flag for manual testing."}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            Click to open the breakdown — reasoning, per-step evidence, and
            caveats, with code you can open beside it.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
