import { cn } from "@/lib/utils";

/**
 * Compact keyboard-cap chip. Tuned smaller than the shadcn default
 * (which targets text-base UI) so the chip reads as inline metadata
 * inside the app's 11–12 px UI density. Same API as shadcn — Kbd as a
 * leaf, KbdGroup as a container of Kbd children.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 select-none items-center justify-center rounded-[4px] border border-border/60 bg-card px-1 font-mono text-[9.5px] leading-none text-muted-foreground",
        "in-data-[slot=input-group]:border-transparent in-data-[slot=input-group]:bg-input",
        "in-data-[slot=tooltip-content]:border-background/30 in-data-[slot=tooltip-content]:bg-background/15 in-data-[slot=tooltip-content]:text-background",
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
