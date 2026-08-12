// Bottom-left progress capsule for the "Get source code" clone. Mirrors
// ConfidenceProgressCapsule / UpdaterToast exactly (h-9 rounded-full glass,
// hairline progress track, spinner) so it reads as native. Positioning and
// stacking are owned by the shared bottom-left container in App.tsx.
//
// While a batch runs it shows "Cloning 2/3 · repo · phase 45%"; when it ends it
// shows a one-line tally. Every successful clone joins the workspace on its own
// — the "Added N repos" confirmation is the ActionToast stacked beneath this.

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCloneProgress } from "./cloneProgressStore";

export function CloneProgressCapsule() {
  const phase = useCloneProgress((s) => s.phase);
  const total = useCloneProgress((s) => s.total);
  const currentIndex = useCloneProgress((s) => s.currentIndex);
  const repoLabel = useCloneProgress((s) => s.repoLabel);
  const gitPhase = useCloneProgress((s) => s.gitPhase);
  const pct = useCloneProgress((s) => s.pct);
  const outcomes = useCloneProgress((s) => s.outcomes);
  const cancelled = useCloneProgress((s) => s.cancelled);
  const cancel = useCloneProgress((s) => s.cancel);
  const dismiss = useCloneProgress((s) => s.dismiss);

  if (phase !== "cloning" && phase !== "done") return null;

  const summary = phase === "done" ? buildSummary(outcomes, total, cancelled) : null;

  return (
    <div
      className={cn(
        "pointer-events-auto relative flex h-9 max-w-[24rem] items-center gap-2 overflow-hidden rounded-full border border-border/60 bg-card/85 pl-3 pr-1 backdrop-blur-2xl",
        "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.2)]",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
      )}
      role="status"
      aria-live="polite"
    >
      {phase === "cloning" && (
        <>
          <span className="relative grid size-3.5 shrink-0 place-items-center">
            <span className="absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary" />
          </span>
          <p className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap pr-1 text-[12px] text-foreground">
            <span className="font-medium">Cloning</span>
            {total > 1 ? (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {currentIndex + 1}/{total}
              </span>
            ) : null}
            {repoLabel ? (
              <span className="min-w-0 max-w-[9rem] truncate font-mono text-[11px] text-muted-foreground">
                {repoLabel}
              </span>
            ) : null}
            {gitPhase ? (
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {gitPhase}
                {pct !== null ? (
                  <span className="ml-1 font-mono tabular-nums">{pct}%</span>
                ) : null}
              </span>
            ) : null}
          </p>
          <CapsuleButton icon={Cancel01Icon} label="Cancel clone" onClick={cancel} />
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

      {phase === "done" && summary && (
        <>
          <HugeiconsIcon
            icon={summary.ok ? CheckmarkCircle02Icon : AlertCircleIcon}
            size={13}
            strokeWidth={2}
            className={cn("shrink-0", summary.ok ? "text-primary" : "text-destructive")}
          />
          <p className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-[12px] text-foreground">
            <span className={cn("min-w-0 truncate", summary.ok ? "font-medium" : "text-muted-foreground")}>
              {summary.title}
            </span>
            {summary.detail ? (
              <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
                {summary.detail}
              </span>
            ) : null}
          </p>
          <CapsuleButton icon={Cancel01Icon} label="Dismiss" onClick={dismiss} />
        </>
      )}
    </div>
  );
}

type Summary = { ok: boolean; title: string; detail: string | null };

/** Build the one-line end-of-batch tally. */
function buildSummary(
  outcomes: { status: string; label: string; message: string | null }[],
  total: number,
  cancelled: boolean,
): Summary {
  const successes = outcomes.filter((o) => o.status === "cloned");
  const okCount = successes.length;
  const failCount = total - okCount;

  if (cancelled) {
    return {
      ok: okCount > 0,
      title: "Clone cancelled",
      detail: okCount > 0 ? `${okCount} of ${total} cloned` : null,
    };
  }
  if (okCount === 0) {
    // Everything failed — surface the first reason (single clone) or a count.
    const first = outcomes[0];
    return {
      ok: false,
      title: total === 1 ? (first?.message ?? "Clone failed") : `All ${total} clones failed`,
      detail: null,
    };
  }
  if (failCount === 0) {
    return {
      ok: true,
      title: total === 1 ? "Cloned" : `Cloned ${okCount} repos`,
      detail: total === 1 ? (successes[0]?.label ?? null) : null,
    };
  }
  // Partial success.
  return {
    ok: true,
    title: `Cloned ${okCount} of ${total}`,
    detail: `${failCount} failed`,
  };
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
