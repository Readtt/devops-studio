// Shared context-size UI for every AI input surface. Three progressive pieces,
// all driven off one ContextUsage verdict so the Generator, Suite Chat, Commit
// Review, and refine composers behave and read identically:
//
//   • <ContextMeter>          — a passive chip (always shown) with a breakdown
//                                tooltip. Turns amber → red as the payload grows.
//   • <ContextGuardNotice>    — an inline ADVISORY at the "heavy"/"overflow"
//                                tier: cost, what it does to results, and the
//                                ways out. Not a limit warning — the run works.
//   • <ContextOverflowDialog> — a confirm shown only when a run would likely not
//                                fit — the one case that actually wastes credits.
//
// useContextGuard() ties them together: it computes the verdict, respects the
// `contextGuardEnabled` preference, and wraps a surface's run action so the
// confirm fires only on overflow. We never hard-block — it's the user's BYOK
// spend and the estimate is approximate, so "Run anyway" is always available.

import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  computeContextUsage,
  formatCostUsd,
  formatTokens,
  showsContextAdvisory,
  type ContextSegment,
  type ContextTier,
  type ContextUsage,
} from "@/modules/ai/lib/contextEstimate";

// --- Hook -------------------------------------------------------------------

export type ContextGuard = {
  usage: ContextUsage;
  /** Whether warnings/confirm are active (passive meter shows regardless). */
  guardEnabled: boolean;
  /** Run the action, gated by an overflow confirm when the guard is on. */
  attempt: (run: () => void) => void;
  confirmOpen: boolean;
  closeConfirm: () => void;
  confirmProceed: () => void;
};

export function useContextGuard(input: {
  modelId: string | undefined;
  segments: ContextSegment[];
  imagesCount?: number;
  compatOverride?: number;
  outputReserve?: number;
}): ContextGuard {
  const guardEnabled = usePreferencesStore((s) => s.contextGuardEnabled);
  // Cheap enough (a small reduce) to run every render — no memo, so it can
  // never go stale against a freshly-typed segment list.
  const usage = computeContextUsage({
    modelId: input.modelId,
    segments: input.segments,
    imagesCount: input.imagesCount,
    compatOverride: input.compatOverride,
    outputReserve: input.outputReserve,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);

  const attempt = useCallback(
    (run: () => void) => {
      // Only the physical won't-fit case interrupts with a modal — that's the
      // one that wastes the call. A degraded-quality (red) payload still runs;
      // it's advisory, surfaced by the meter + notice, not a blocker.
      if (guardEnabled && usage.mayNotFit) {
        pendingRef.current = run;
        setConfirmOpen(true);
      } else {
        run();
      }
    },
    [guardEnabled, usage.mayNotFit],
  );

  const confirmProceed = useCallback(() => {
    setConfirmOpen(false);
    const run = pendingRef.current;
    pendingRef.current = null;
    run?.();
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    pendingRef.current = null;
  }, []);

  return { usage, guardEnabled, attempt, confirmOpen, closeConfirm, confirmProceed };
}

// --- Tier styling -----------------------------------------------------------

const TIER_BAR: Record<ContextTier, string> = {
  comfortable: "bg-primary/55",
  heavy: "bg-amber-500",
  overflow: "bg-rose-500",
};
const TIER_TEXT: Record<ContextTier, string> = {
  comfortable: "text-muted-foreground",
  heavy: "text-amber-700 dark:text-amber-300",
  overflow: "text-rose-700 dark:text-rose-300",
};

function pct(usage: ContextUsage): number {
  return Math.round(usage.ratio * 100);
}

// --- Meter chip -------------------------------------------------------------

/** Passive `▮▮▯ ~12k / 168k` chip with a breakdown tooltip. Slots into the
 *  existing bottom strip of any composer. */
export function ContextMeter({
  usage,
  className,
}: {
  usage: ContextUsage;
  className?: string;
}) {
  const width = `${Math.min(100, Math.max(2, usage.ratio * 100))}%`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums",
            className,
          )}
          aria-label={`Estimated context ~${formatTokens(usage.usedTokens)} tokens — ~${pct(usage)}% of the ~${formatTokens(usage.qualityBudget)}-token quality budget`}
        >
          <span className="relative h-1 w-10 overflow-hidden rounded-full bg-foreground/10">
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300",
                TIER_BAR[usage.tier],
              )}
              style={{ width }}
            />
          </span>
          <span className={TIER_TEXT[usage.tier]}>
            ~{formatTokens(usage.usedTokens)}
          </span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-muted-foreground/70">
            {formatTokens(usage.qualityBudget)}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-[300px] px-3 py-2.5 text-[11px] leading-relaxed"
      >
        <ContextBreakdown usage={usage} />
      </TooltipContent>
    </Tooltip>
  );
}

function ContextBreakdown({ usage }: { usage: ContextUsage }) {
  const tierLabel = usage.mayNotFit
    ? "May not fit"
    : usage.tier === "overflow"
      ? "Quality degraded"
      : usage.tier === "heavy"
        ? "Quality thinning"
        : "Comfortable";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("font-medium", TIER_TEXT[usage.tier])}>
          {tierLabel}
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          ~{formatTokens(usage.usedTokens)} / {formatTokens(usage.qualityBudget)}{" "}
          · {pct(usage)}%
        </span>
      </div>
      {usage.segments.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {usage.segments.slice(0, 5).map((s) => (
            <li
              key={s.label}
              className="flex items-baseline justify-between gap-3 font-mono text-[10.5px]"
            >
              <span className="truncate text-muted-foreground/85">{s.label}</span>
              <span className="shrink-0 tabular-nums text-foreground/80">
                ~{formatTokens(s.tokens)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-border/50 pt-1.5 text-[10.5px] text-muted-foreground/80">
        Reserves ~{formatTokens(usage.outputReserve)} for the reply
        {usage.estCostUsd !== null ? (
          <>
            {" "}
            · est. ~<span className="text-foreground/85">{formatCostUsd(usage.estCostUsd)}</span> / run
          </>
        ) : null}
        .
      </div>
    </div>
  );
}

// --- Inline warning ---------------------------------------------------------

/** Amber (heavy) / rose (overflow) note with the cost, what it does to results,
 *  and the concrete ways out. Render it near the run/send button; it returns
 *  null when the payload is comfortable or the guard preference is off.
 *
 *  Two of its three messages are ADVISORY — nothing is going to fail, results
 *  just get less thorough — and they say so, because worded as limit warnings
 *  they read as "you can't send this" and users trim work they didn't need to.
 *  Only the `mayNotFit` branch describes an actual failure, and that one is also
 *  the only one that interrupts (via ContextOverflowDialog). */
export function ContextGuardNotice({
  usage,
  guardEnabled,
  modelLabel,
  className,
}: {
  usage: ContextUsage;
  guardEnabled: boolean;
  modelLabel?: string;
  className?: string;
}) {
  if (!showsContextAdvisory(usage, guardEnabled)) return null;
  const red = usage.tier === "overflow";
  const model = modelLabel ?? "this model";
  const cost =
    usage.estCostUsd !== null ? ` (~${formatCostUsd(usage.estCostUsd)})` : "";

  // Three messages: a physical won't-fit (rare, the only one that hard-fails),
  // results thinning badly (red, advisory), and results starting to thin.
  const title = usage.mayNotFit
    ? `May not fit ${model}`
    : red
      ? "Results will be noticeably thinner"
      : "Results start to thin out past here";
  const lead = usage.mayNotFit
    ? "It could fail partway and waste the run."
    : red
      ? `This will still run, but ${model} is spread thin enough to start missing requirements and duplicating cases.`
      : `This will still run. Past ~${formatTokens(usage.qualityBudget)} tokens ${model} spreads its attention across everything you sent, so expect less thorough coverage — not a failure.`;
  const fix = usage.mayNotFit
    ? "Compact the spec, split it across a few runs, or pick a bigger-context model."
    : "For sharper results, cut back to the spec and files that actually matter, or split the work across a few runs.";

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-[11px] leading-relaxed",
        red
          ? "border-rose-500/30 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300"
          : "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <p>
        <span className="font-medium">{title}</span>{" "}
        — ~{formatTokens(usage.usedTokens)} / ~{formatTokens(usage.qualityBudget)}{" "}
        tokens{cost}. {lead}
      </p>
      <p className="mt-1 text-foreground/70">{fix}</p>
    </div>
  );
}

// --- Overflow confirm -------------------------------------------------------

/** The one interrupting step: shown only on overflow, and only when the user
 *  actually tries to run. Mount it once per surface and drive it from
 *  useContextGuard. */
export function ContextOverflowDialog({
  guard,
  modelLabel,
}: {
  guard: ContextGuard;
  modelLabel?: string;
}) {
  const { usage } = guard;
  const model = modelLabel ?? "the selected model";
  const cost =
    usage.estCostUsd !== null ? ` (~${formatCostUsd(usage.estCostUsd)})` : "";
  return (
    <AlertDialog
      open={guard.confirmOpen}
      onOpenChange={(open) => {
        if (!open) guard.closeConfirm();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This might not fit {model}</AlertDialogTitle>
          <AlertDialogDescription>
            ~{formatTokens(usage.usedTokens)} of ~
            {formatTokens(usage.usableBudget)} usable tokens{cost} — big enough
            that it may fail partway and waste the run. Compact the spec, split
            it across a few runs, or switch to a bigger-context model. You can
            still send it as-is.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Let me trim it</AlertDialogCancel>
          <AlertDialogAction onClick={guard.confirmProceed}>
            Run anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
