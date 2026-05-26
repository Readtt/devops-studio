import { useState } from "react";
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
import { ConfidenceSheet } from "./ConfidenceSheet";
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
 * ConfidenceSheet — a designated right-side drawer with the full reasoning,
 * per-step evidence (clickable file:line), and caveats. The detail used to
 * live in a hover tooltip that ran off-screen on narrow panes; the sheet
 * scrolls and wraps instead.
 *
 * States: a verdict (clickable chip), `loading` with no verdict yet
 * (Evaluating…), or no verdict with an `onEvaluate` handler (Evaluate button).
 */
export function ConfidenceChip({
  verdict,
  loading,
  onEvaluate,
}: {
  verdict: ConfidenceVerdict | null | undefined;
  loading?: boolean;
  /** When provided, enables evaluation (the Evaluate button and the sheet's
   *  Re-evaluate action). */
  onEvaluate?: () => void;
}) {
  const [open, setOpen] = useState(false);

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

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
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
        <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
          {pct}% · {OUTCOME_LABEL[verdict.predictedOutcome]}
          {verdict.confidence >= AUTO_PASS_THRESHOLD &&
          verdict.predictedOutcome === "Pass"
            ? " — auto-pass candidate."
            : " — below the manual-test bar."}
          <span className="mt-0.5 block text-muted-foreground">
            Click for the full breakdown — evidence, reasoning, caveats.
          </span>
        </TooltipContent>
      </Tooltip>
      <ConfidenceSheet
        open={open}
        onOpenChange={setOpen}
        verdict={verdict}
        evaluating={loading}
        onEvaluate={onEvaluate}
      />
    </>
  );
}
