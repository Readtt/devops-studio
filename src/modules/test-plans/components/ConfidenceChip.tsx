import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTO_PASS_THRESHOLD,
  passReadiness,
  readinessTone,
  type ConfidenceVerdict,
} from "../lib/confidence";
import {
  Cancel01Icon,
  Loading03Icon,
  RefreshIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const OUTCOME_LABEL: Record<ConfidenceVerdict["predictedOutcome"], string> = {
  Pass: "Pass",
  Fail: "Fail",
  Blocked: "Blocked",
  Unknown: "Unknown",
};

/**
 * Confidence chip — shows pass-readiness: one number for "how safe is it to
 * just mark this case Passed?", color-graded (green ≥90 / amber 60-89 / red
 * <60). A case the model expects to fail reads low + red; a confident pass
 * reads high + green. The predicted outcome (Pass/Fail/Blocked) lives in the
 * tooltip and detail panel, not on the chip face.
 *
 * It carries every eval control inline so the user never has to open the
 * detail pane to act: a readiness pill that opens the breakdown, a ↻
 * re-evaluate button right next to it, and — while an evaluation is in
 * flight — a cancel (✕) button in the chip itself.
 */
export function ConfidenceChip({
  verdict,
  loading,
  onEvaluate,
  onReevaluate,
  onCancel,
  onOpenDetail,
  size = "sm",
  actionsSide = "right",
}: {
  verdict: ConfidenceVerdict | null | undefined;
  loading?: boolean;
  /** First evaluation (the Evaluate button, no prior verdict). */
  onEvaluate?: () => void;
  /** Re-run the evaluation in place (the ↻ next to a verdict pill). */
  onReevaluate?: () => void;
  /** Cancel an in-flight evaluation (the ✕ shown while loading). */
  onCancel?: () => void;
  /** Open the confidence detail side panel (verdict pill click). */
  onOpenDetail?: () => void;
  /** "sm" (default) for dense review rows; "md" for the test-case header. */
  size?: "sm" | "md";
  /** Which side the inline ↻/✕ control sits on. "right" (default) for the
   *  dense review rows; "left" in the test-case header, where the badge sits
   *  flush against the outcome selector to its right. */
  actionsSide?: "left" | "right";
}) {
  const md = size === "md";
  const affordance = md
    ? "h-6 px-2 text-[11px] gap-1.5"
    : "h-5 px-1.5 text-[10px] gap-1";
  const glyph = md ? 12 : 10;
  const iconBtn = md ? "size-6" : "size-5";

  // Nothing to show and no way to make something appear.
  if (!verdict && !loading && !onEvaluate) return null;

  // First-time evaluation (no prior verdict) — pill + inline cancel.
  if (loading && !verdict) {
    const cancel = onCancel ? (
      <IconAction
        label="Cancel evaluation"
        icon={Cancel01Icon}
        onClick={onCancel}
        sizeClass={iconBtn}
        glyph={glyph}
        tone="danger"
      />
    ) : null;
    return (
      <span className="inline-flex items-center gap-1">
        {actionsSide === "left" ? cancel : null}
        <span
          className={cn(
            "inline-flex items-center rounded-sm bg-foreground/[0.06] font-medium text-muted-foreground",
            affordance,
          )}
        >
          <HugeiconsIcon
            icon={Loading03Icon}
            size={glyph}
            strokeWidth={2}
            className="animate-spin"
          />
          Evaluating…
        </span>
        {actionsSide === "right" ? cancel : null}
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
            className={cn(
              "inline-flex items-center rounded-sm border border-border/55 bg-card/60 font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
              affordance,
            )}
          >
            <HugeiconsIcon icon={SparklesIcon} size={glyph} strokeWidth={1.75} />
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

  const readiness = passReadiness(verdict);
  const tone = readinessTone(readiness, verdict.predictedOutcome);
  const conf = Math.round(verdict.confidence);
  const isAutoPass =
    verdict.confidence >= AUTO_PASS_THRESHOLD &&
    verdict.predictedOutcome === "Pass";

  // While re-evaluating: cancel. Otherwise: a one-click re-analyze that
  // doesn't require opening the detail pane. Placed left or right of the pill
  // per actionsSide.
  const action =
    loading && onCancel ? (
      <IconAction
        label="Cancel evaluation"
        icon={Cancel01Icon}
        onClick={onCancel}
        sizeClass={iconBtn}
        glyph={glyph}
        tone="danger"
      />
    ) : !loading && onReevaluate ? (
      <IconAction
        label="Re-analyze confidence"
        icon={RefreshIcon}
        onClick={onReevaluate}
        sizeClass={iconBtn}
        glyph={glyph}
      />
    ) : null;

  return (
    <span className="inline-flex items-center gap-1">
      {actionsSide === "left" ? action : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onOpenDetail?.()}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm font-medium tabular-nums transition-[filter] hover:brightness-95 dark:hover:brightness-110",
              md ? "h-6 px-2 text-[11px]" : "h-5 px-1.5 text-[10px]",
              tone.className,
            )}
          >
            {loading ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                size={glyph}
                strokeWidth={2}
                className="animate-spin"
              />
            ) : null}
            {readiness !== null ? `${readiness}%` : "?"}
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
                pass-ready
              </span>
              <span className="font-medium tabular-nums text-foreground/90">
                {readiness !== null ? `${readiness}%` : "—"}
              </span>
            </div>
            <p className="text-foreground/80">
              {isAutoPass
                ? "At or above the 90% bar — safe to mark Passed."
                : verdict.predictedOutcome === "Unknown"
                  ? "Couldn't ground this in code — test it manually."
                  : "Below the 90% bar — verify before passing."}
            </p>
            <p className="text-[10px] text-muted-foreground/80">
              Predicted {OUTCOME_LABEL[verdict.predictedOutcome]} · {conf}%
              confidence.
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              Click for the breakdown · ↻ re-analyzes in place.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>

      {actionsSide === "right" ? action : null}
    </span>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  sizeClass,
  glyph,
  tone,
}: {
  label: string;
  icon: typeof RefreshIcon;
  onClick: () => void;
  sizeClass: string;
  glyph: number;
  tone?: "danger";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "grid shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors",
            sizeClass,
            tone === "danger"
              ? "hover:bg-destructive/15 hover:text-destructive"
              : "hover:bg-foreground/[0.06] hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={icon} size={glyph} strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
