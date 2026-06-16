// Bottom-left progress capsule for the "Run confidence on all cases" bulk run.
// Mirrors UpdaterToast's glass capsule exactly (h-9 rounded-full, hairline
// progress track, spinner) so it reads as native. Stacks above the updater
// toast (bottom-14 vs bottom-3) on the rare occasion both are visible.

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuiteConfidence } from "./hooks/useSuiteConfidence";

export function ConfidenceProgressCapsule() {
  const phase = useSuiteConfidence((s) => s.phase);
  const total = useSuiteConfidence((s) => s.total);
  const done = useSuiteConfidence((s) => s.done);
  const currentTitle = useSuiteConfidence((s) => s.currentTitle);
  const failures = useSuiteConfidence((s) => s.failures);
  const notice = useSuiteConfidence((s) => s.notice);
  const cancel = useSuiteConfidence((s) => s.cancel);
  const dismiss = useSuiteConfidence((s) => s.dismiss);

  if (phase === "idle") return null;

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const failed = failures.length;

  return (
    // Bare capsule — positioning/stacking is owned by the shared bottom-left
    // container in App.tsx, so it collapses to the bottom slot when it's the
    // only capsule and stacks with the updater toast when both are visible.
    <div
      className={cn(
        "pointer-events-auto relative flex h-9 max-w-[22rem] items-center gap-2 overflow-hidden rounded-full border border-border/60 bg-card/85 pl-3 pr-1 backdrop-blur-2xl",
        "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.2)]",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
      )}
      role="status"
      aria-live="polite"
    >
      {(phase === "discovering" || phase === "scoring") && (
        <>
          <span className="relative grid size-3.5 shrink-0 place-items-center">
            <span className="absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary" />
          </span>
          <p className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap pr-1 text-[12px] text-foreground">
            {phase === "discovering" ? (
              <span className="font-medium">Finding cases…</span>
            ) : (
              <>
                <span className="font-medium">Scoring</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  {done}/{total}
                </span>
                {currentTitle ? (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {currentTitle}
                  </span>
                ) : null}
              </>
            )}
          </p>
          <CapsuleButton
            icon={Cancel01Icon}
            label="Cancel scoring"
            onClick={cancel}
          />
          {/* Hairline progress track along the capsule's bottom edge. */}
          <span
            aria-hidden
            className="absolute inset-x-4 bottom-0 h-[2px] overflow-hidden rounded-full bg-muted"
          >
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-300",
                pct === null && "w-1/3 animate-pulse",
              )}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </span>
        </>
      )}

      {phase === "done" && (
        <>
          <HugeiconsIcon
            icon={notice ? AlertCircleIcon : CheckmarkCircle02Icon}
            size={13}
            strokeWidth={2}
            className={cn(
              "shrink-0",
              notice ? "text-muted-foreground" : "text-primary",
            )}
          />
          <p className="whitespace-nowrap text-[12px] text-foreground">
            {notice ? (
              <span className="text-muted-foreground">{notice}</span>
            ) : (
              <>
                <span className="font-medium">Scored {total} cases</span>
                {failed > 0 ? (
                  <span className="ml-1.5 text-[11px] text-destructive">
                    · {failed} failed
                  </span>
                ) : null}
              </>
            )}
          </p>
          <CapsuleButton icon={Cancel01Icon} label="Dismiss" onClick={dismiss} />
        </>
      )}
    </div>
  );
}

function CapsuleButton({
  icon,
  label,
  onClick,
}: {
  icon: typeof Cancel01Icon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label={label}
        >
          <HugeiconsIcon icon={icon} size={11} strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
