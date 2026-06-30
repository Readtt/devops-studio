import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { useActionToast } from "./actionToastStore";

/**
 * Bottom-left glass capsule for a one-off action result (e.g. "Copied 4 open
 * bugs"). Deliberately the same shape, glass, and spinner as BranchSwitchToast
 * and the updater toast so the three read as one notification language; the
 * shared container in App.tsx owns positioning and stacking.
 */
export function ActionToast() {
  const toast = useActionToast((s) => s.toast);
  const dismiss = useActionToast((s) => s.dismiss);
  if (!toast) return null;

  return (
    <div
      className={cn(
        "pointer-events-auto relative flex h-9 items-center gap-2 overflow-hidden rounded-full border border-border/60 bg-card/85 pl-3 pr-1 backdrop-blur-2xl",
        "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.2)]",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
      )}
      role="status"
      aria-live="polite"
    >
      {toast.busy ? (
        <span className="relative grid size-3.5 shrink-0 place-items-center">
          <span className="absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary" />
        </span>
      ) : toast.tone === "ok" ? (
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={13}
          strokeWidth={2}
          className={cn(
            "shrink-0",
            toast.tone === "error"
              ? "text-destructive"
              : "text-amber-600 dark:text-amber-400",
          )}
        />
      )}

      <p className="whitespace-nowrap pr-1 text-[12px] text-foreground">
        {toast.message}
      </p>

      {!toast.busy ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => dismiss()}
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              aria-label="Dismiss"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            Dismiss
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
