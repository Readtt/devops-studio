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
 * Trigger is passed as `children`; Radix wires up its onClick. The
 * consumer renders whatever button/chip aesthetic fits their surface.
 *
 * Popover state is local — each instance has its own open/closed flag,
 * so multiple "+" buttons on screen don't interact.
 */

type Actions = {
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
  actions: Actions;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className="w-72 gap-0 rounded-lg p-1"
      >
        <LaunchMenuItem
          icon={SparklesIcon}
          label="New generation"
          description="Generate test cases from a feature spec — the QA workflow this app was built for."
          onSelect={() => {
            close();
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
            close();
            actions.onTerminal();
          }}
        />
        <LaunchMenuItem
          icon={Search01Icon}
          label="Review my changes"
          description={
            actions.sourceRoot
              ? "AI code review of your branch diff vs main — clickable file:line citations"
              : "Set a source directory in Settings first"
          }
          disabled={!actions.sourceRoot}
          onSelect={() => {
            close();
            actions.onCodeReview();
          }}
        />
      </PopoverContent>
    </Popover>
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
