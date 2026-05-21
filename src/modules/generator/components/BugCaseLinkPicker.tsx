import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ReviewedCase } from "../lib/draftBatchSchema";
import { useState } from "react";

type Props = {
  /** All cases in the current session (kept + skipped). */
  cases: ReviewedCase[];
  /** The currently-linked case uid, or null. */
  selectedCaseUid: string | null;
  onPick: (caseUid: string | null) => void;
  /** Compact label to render inside the trigger. */
  triggerLabel: string;
};

/** Tiny popover that lets the user re-link a bug to a different parent
 *  case. Disabled cases are still shown (they couldn't be a valid parent
 *  if skipped) but greyed out so the user understands why they can't
 *  pick them. */
export function BugCaseLinkPicker({
  cases,
  selectedCaseUid,
  onPick,
  triggerLabel,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <span className="text-muted-foreground/50">→</span>
          <span className="max-w-[180px] truncate">{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[320px] p-1"
      >
        <ul className="flex max-h-[240px] flex-col gap-px overflow-y-auto">
          <li>
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className={cn(
                "w-full rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-foreground/[0.05]",
                selectedCaseUid === null && "bg-primary/[0.07]",
              )}
            >
              <span className="font-mono text-muted-foreground">none</span>{" "}
              — unlink this bug
            </button>
          </li>
          {cases.map((c, i) => {
            const disabled = c.decision !== "keep";
            return (
              <li key={c.uid}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(c.uid);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full rounded-sm px-2 py-1.5 text-left text-[11px]",
                    disabled
                      ? "cursor-not-allowed text-muted-foreground/40 line-through"
                      : "hover:bg-foreground/[0.05]",
                    selectedCaseUid === c.uid && !disabled && "bg-primary/[0.07]",
                  )}
                >
                  <span className="font-mono text-muted-foreground">
                    #{i + 1}
                  </span>{" "}
                  {c.title}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
