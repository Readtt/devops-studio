// The single inline notice used across the generator surfaces (attachment
// errors, refine failures, chat-send failures, review warnings). Before this
// existed, each surface hand-rolled its own destructive/amber box — they
// drifted on border opacity, padding, icon presence, and dismiss styling.
// This is derived from the most polished of those (the refine-error banner),
// not a new look: icon · optional mono label · message · optional muted hint ·
// optional dismiss, in one "error" or "warning" tone.

import { type ReactNode } from "react";
import { AlertCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type InlineNoticeTone = "error" | "warning";

const TONE: Record<
  InlineNoticeTone,
  { box: string; icon: string; label: string; body: string; dismiss: string }
> = {
  error: {
    box: "border-destructive/30 bg-destructive/[0.06]",
    icon: "text-destructive",
    label: "text-destructive/85",
    body: "text-destructive/90",
    dismiss:
      "text-destructive/70 hover:bg-destructive/15 hover:text-destructive",
  },
  warning: {
    box: "border-amber-500/30 bg-amber-500/[0.06]",
    icon: "text-amber-600 dark:text-amber-400",
    label: "text-amber-700 dark:text-amber-300",
    body: "text-amber-700/90 dark:text-amber-300/90",
    dismiss:
      "text-amber-700/70 hover:bg-amber-500/15 hover:text-amber-700 dark:text-amber-300/70 dark:hover:text-amber-300",
  },
};

export function InlineNotice({
  tone = "error",
  label,
  children,
  hint,
  action,
  icon = AlertCircleIcon,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  role = "alert",
}: {
  tone?: InlineNoticeTone;
  /** ARIA live-region behavior. "alert" (default) is assertive — right for
   *  event-driven failures. Use "status" (polite) for a passive, persistent
   *  notice that re-renders as data changes, so screen readers don't interrupt
   *  and re-announce it on every recount. */
  role?: "alert" | "status";
  /** Optional mono-uppercase tag above the message (e.g. "refine failed"). */
  label?: string;
  /** Message body — plain text, or richer content like a list of file errors. */
  children: ReactNode;
  /** Muted helper line under the message (e.g. "Your draft is unchanged…"). */
  hint?: ReactNode;
  /** Recovery controls under the message — the pattern RunErrorPanel uses for
   *  "Resume run", kept here so an inline failure can offer the same one-click
   *  continuation instead of stacking a second banner above it. */
  action?: ReactNode;
  /** Glyph in the left rail. Defaults to the alert circle. */
  icon?: typeof AlertCircleIcon;
  /** When provided, renders a dismiss (×) button wired to this handler. */
  onDismiss?: () => void;
  /** Accessible label + tooltip for the dismiss button. */
  dismissLabel?: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5",
        t.box,
        className,
      )}
    >
      <HugeiconsIcon
        icon={icon}
        size={12}
        strokeWidth={1.75}
        className={cn("mt-0.5 shrink-0", t.icon)}
      />
      <div className="min-w-0 flex-1">
        {label ? (
          <p
            className={cn(
              "font-mono text-[10.5px] uppercase tracking-wider",
              t.label,
            )}
          >
            {label}
          </p>
        ) : null}
        <div
          className={cn(
            "break-words text-[10.5px] leading-relaxed",
            label && "mt-0.5",
            t.body,
          )}
        >
          {children}
        </div>
        {hint ? (
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {action ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {action}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              className={cn(
                "shrink-0 rounded-sm p-0.5 transition-colors",
                t.dismiss,
              )}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {dismissLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
