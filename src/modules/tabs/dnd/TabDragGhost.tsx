import { HugeiconsIcon } from "@hugeicons/react";
import { PinIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { AppTab, TabKind } from "../store/types";

type Props = { tab: AppTab };

/**
 * The chip that follows the cursor during a drag. Stripped-down clone of
 * TabChip — no close button, no context menu, no listeners. Visual depth
 * comes from a small shadow + opacity.
 */
export function TabDragGhost({ tab }: Props) {
  return (
    <div
      className={cn(
        "flex h-7 max-w-[260px] items-center gap-1 rounded-md bg-card px-2 text-[11.5px] text-foreground shadow-lg ring-1 ring-border/60",
      )}
      style={{ opacity: 0.95, pointerEvents: "none" }}
    >
      <span
        aria-hidden
        className={cn("h-[5px] w-[5px] shrink-0 rounded-full", kindDotClass(tab.kind))}
      />
      {tab.pinned ? (
        <HugeiconsIcon
          icon={PinIcon}
          size={9}
          strokeWidth={1.75}
          className="shrink-0 text-foreground/70"
        />
      ) : null}
      <span className="truncate">{tab.title}</span>
    </div>
  );
}

function kindDotClass(kind: TabKind): string {
  switch (kind) {
    case "generator":
      return "bg-sky-400 dark:bg-sky-500";
    case "test-case":
      return "bg-violet-400 dark:bg-violet-500";
    case "bug":
      return "bg-rose-400 dark:bg-rose-500";
    case "suite-chat":
      return "bg-amber-400 dark:bg-amber-500";
    case "code-viewer":
      return "bg-zinc-400 dark:bg-zinc-500";
    case "terminal":
      return "bg-emerald-400 dark:bg-emerald-500";
    case "commit-review":
      return "bg-fuchsia-400 dark:bg-fuchsia-500";
  }
}
