import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CommandLineIcon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";

/**
 * Shared "open something" launcher. Same three entries — Generate /
 * Terminal / Review my changes — wherever the user can ask to open a
 * new tab: the top-bar "+" button, the end-of-tab-strip "+", and the
 * empty-state welcome screen.
 *
 * Two ways to consume this:
 *
 *   1. `<LaunchMenu>...</LaunchMenu>` — simple single-child trigger.
 *      Children become the Popover's direct trigger via asChild. Use
 *      this when the trigger doesn't need to be wrapped in a Tooltip.
 *
 *   2. `<LaunchMenuItems actions={...}/>` — bare menu items rendered
 *      inside a PopoverContent you own. Use this when you need to
 *      compose with Tooltip (Radix requires Tooltip to wrap
 *      PopoverTrigger, not the other way around — putting Tooltip
 *      as the asChild target swallows clicks because Tooltip.Root
 *      is a Provider, not a DOM element, so Radix Slot has nothing
 *      to wire onClick into).
 *
 * Popover state is local in case (1); the consumer owns it in case (2),
 * so multiple "+" buttons on screen don't interact.
 */

export type LaunchMenuActions = {
  onGenerator: () => void;
  onTerminal: () => void;
  /** Disabled when there's no source root. */
  onCodeReview: () => void;
  /** Used in the per-entry descriptions and to gate the Review entry. */
  sourceRoot?: string | null;
};

export function LaunchMenu({
  actions,
  children,
  align = "end",
  side = "bottom",
}: {
  actions: LaunchMenuActions;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
      >
        <LaunchMenuItems actions={actions} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Bare set of launcher rows — rendered inside an externally-managed
 * PopoverContent. The Tooltip+Popover composition rule means the
 * tab-strip "+" can't use LaunchMenu directly (Tooltip would have to
 * wrap the PopoverTrigger), so it owns the Popover itself and drops
 * this into the content.
 */
export function LaunchMenuItems({
  actions,
  onClose,
}: {
  actions: LaunchMenuActions;
  onClose: () => void;
}) {
  return (
    <>
      <LaunchMenuItem
        icon={SparklesIcon}
        label="New generation"
        description="Generate test cases from a feature spec — the QA workflow this app was built for."
        onSelect={() => {
          onClose();
          actions.onGenerator();
        }}
      />
      <LaunchMenuItem
        icon={CommandLineIcon}
        label="New terminal"
        description={
          actions.sourceRoot
            ? `Default shell in ${compactPath(actions.sourceRoot)}`
            : "Default shell in app cwd — pick a source dir for project context"
        }
        onSelect={() => {
          onClose();
          actions.onTerminal();
        }}
      />
      <LaunchMenuItem
        icon={Search01Icon}
        label="Code Review"
        description={
          actions.sourceRoot
            ? "AI review of your local branch diff vs main — clickable file:line citations"
            : "Set a source directory in Settings first"
        }
        disabled={!actions.sourceRoot}
        onSelect={() => {
          onClose();
          actions.onCodeReview();
        }}
      />
    </>
  );
}

function LaunchMenuItem({
  icon,
  label,
  description,
  disabled,
  onSelect,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  label: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left",
        "hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:bg-foreground/[0.05]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
      )}
    >
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">
        <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12px] font-medium leading-tight">{label}</span>
        <span className="text-[10.5px] leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function compactPath(p: string, max = 40): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return "…" + p.slice(-(max - 1));
  return parts[0] + "/…/" + parts.slice(-2).join("/");
}
