// The one resume affordance, shared by the Generator and Commit Review so an
// interrupted run looks identical wherever it resurfaces. Deliberately quiet:
// a title that says what happened, ONE fact line (where it stopped · when),
// and two actions. No token totals, no step budgets, no paragraph of copy —
// that stuffing is what made the first version unreadable.

import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon } from "@hugeicons/core-free-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = {
  /** What happened, in one short sentence: "This review didn't finish". */
  title: string;
  /** One quiet fact line: "Investigation stage · 12 steps in · 5 min ago". */
  detail: string;
  onResume: () => void;
  /** Deletes the saved progress. Omit to hide the discard affordance. */
  onDiscard?: () => void;
  className?: string;
};

export function ResumeCard({
  title,
  detail,
  onResume,
  onDiscard,
  className,
}: Props) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2.5",
        className,
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/30">
        <HugeiconsIcon
          icon={PlayIcon}
          size={14}
          strokeWidth={1.75}
          className="text-amber-600 dark:text-amber-400"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium leading-tight text-foreground">
          {title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onDiscard ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onDiscard}
                className="h-7 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Discard
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Deletes the saved progress.
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onResume}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[11.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Resume
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
            Continues where it stopped with the original model — finished
            steps aren't re-run.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/** Compact "5 min ago" for the ResumeCard's fact line. Falls back to a short
 *  date once it's older than a day — precision past that doesn't help. */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
