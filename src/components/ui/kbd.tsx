import { cn } from "@/lib/utils";

/**
 * Compact, borderless keyboard chip. Inline metadata vibe — a single
 * tinted rectangle of monospaced text, no outline, no shadow. Reads as
 * "this is a key" without screaming for attention.
 *
 * Tuned for the 11-12 px UI density of this app. Same API as shadcn:
 * Kbd as a leaf, KbdGroup as a container of Kbd children.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 select-none items-center justify-center rounded-[3px] bg-foreground/[0.06] px-1 font-mono text-[9.5px] leading-none text-foreground/75",
        "in-data-[slot=tooltip-content]:bg-background/15 in-data-[slot=tooltip-content]:text-background/85",
        "dark:in-data-[slot=tooltip-content]:bg-background/10",
        "[&_svg:not([class*='size-'])]:size-2.5",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
