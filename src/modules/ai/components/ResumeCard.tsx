// The one resume affordance, shared by the Generator and Commit Review so an
// interrupted run looks identical wherever it resurfaces. Deliberately quiet:
// a title that says what happened, ONE fact line (how far it got · what it
// already spent · when), and two actions. No budget ratios, no progress bars, no
// paragraph of copy — that stuffing is what made the first version unreadable.
//
// It has a SECOND mode, and the reason is a real bug: Discard used to live only
// inside this card, and every render site gated the whole card on
// `canOfferResume`. A checkpoint that couldn't be resumed therefore couldn't be
// deleted either — the row sat in SQLite until the keep-10 sweep aged it out,
// invisible and unreachable. Pass `unresumableReason` instead of `onResume` and
// the card renders as a plain "there's saved progress here" row with the reason
// and a Discard button. The resume decision stays at the call site
// (`canOfferResume`); this component only renders the two outcomes.

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PlayIcon } from "@hugeicons/core-free-icons";
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
  /** Omit to render the discard-only mode — pass {@link unresumableReason} too. */
  onResume?: () => void;
  /** Why Resume isn't on offer, in one clause ("the model answered with
   *  something unusable"). Shown under the fact line when `onResume` is absent
   *  so the card explains itself rather than just missing its main button. */
  unresumableReason?: string;
  /** Deletes the saved progress. Omit to hide the discard affordance. */
  onDiscard?: () => void;
  className?: string;
};

export function ResumeCard({
  title,
  detail,
  onResume,
  unresumableReason,
  onDiscard,
  className,
}: Props) {
  const resumable = !!onResume;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2.5",
        resumable
          ? "border-amber-500/30 bg-amber-500/[0.05]"
          : "border-border/60 bg-card/40",
        className,
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md ring-1",
          resumable
            ? "bg-amber-500/10 ring-amber-500/30"
            : "bg-foreground/[0.04] ring-border/60",
        )}
      >
        <HugeiconsIcon
          icon={resumable ? PlayIcon : Delete02Icon}
          size={14}
          strokeWidth={1.75}
          className={
            resumable
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium leading-tight text-foreground">
          {title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {detail}
        </p>
        {!resumable && unresumableReason ? (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground/85">
            {unresumableReason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onDiscard ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onDiscard}
                className={cn(
                  "h-7 rounded-md px-2 text-[11px] font-medium transition-colors",
                  resumable
                    ? "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                    : "border border-border/60 bg-card/60 px-2.5 text-foreground hover:bg-foreground/[0.05]",
                )}
              >
                Discard
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
              Deletes the saved progress
              {resumable ? "." : " — nothing else here uses it."}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {onResume ? (
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
        ) : null}
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
