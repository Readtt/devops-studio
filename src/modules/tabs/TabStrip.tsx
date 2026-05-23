import { memo, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { AppTab } from "./store/types";

type Props = {
  /** Tabs to render, in display order. Pinned-first sorting is the
   *  responsibility of the store selector. */
  tabs: AppTab[];
  activeTabId: number | null;
  /** Whether this leaf is the user's focused leaf (drives the active-tab
   *  styling so it's clear which pane keyboard shortcuts act on). */
  focused: boolean;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  /** Optional: middle-click closes, like browsers. */
  onMiddleClick?: (tabId: number) => void;
  /** Click anywhere in the strip area marks the owning leaf focused. */
  onFocus: () => void;
};

/**
 * Horizontal strip of tab chips. Wheel-scrolls horizontally (vertical
 * wheel → strip scroll), exactly like the original strip in App.tsx. The
 * scroll bar is hidden via the `tabs-scroll` class because window-drag
 * regions live alongside it and a visible bar would steal drag events.
 *
 * No dnd here yet — Step 5 layers SortableContext on top.
 */
export const TabStrip = memo(function TabStrip({
  tabs,
  activeTabId,
  focused,
  onActivate,
  onClose,
  onMiddleClick,
  onFocus,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeChipRef = useRef<HTMLDivElement | null>(null);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaX !== 0) return;
    if (e.deltaY === 0) return;
    el.scrollLeft += e.deltaY;
  }, []);

  // Keep the active tab visible when it changes (cycling shortcuts can
  // land on an offscreen chip).
  const setActiveChipRef = useCallback((el: HTMLDivElement | null) => {
    activeChipRef.current = el;
    if (!el) return;
    // requestAnimationFrame so the strip has laid out before we measure.
    requestAnimationFrame(() => {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }, []);

  return (
    <div
      ref={scrollRef}
      onWheel={onWheel}
      onPointerDown={onFocus}
      className="tabs-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
    >
      {tabs.length === 0 ? (
        <span className="px-2 text-[11px] text-muted-foreground">
          No tabs
        </span>
      ) : (
        tabs.map((t) => (
          <TabChip
            key={t.id}
            tab={t}
            active={t.id === activeTabId}
            focused={focused}
            chipRefCallback={t.id === activeTabId ? setActiveChipRef : undefined}
            onActivate={onActivate}
            onClose={onClose}
            onMiddleClick={onMiddleClick}
          />
        ))
      )}
    </div>
  );
});

type ChipProps = {
  tab: AppTab;
  active: boolean;
  focused: boolean;
  chipRefCallback?: (el: HTMLDivElement | null) => void;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onMiddleClick?: (tabId: number) => void;
};

const TabChip = memo(function TabChip({
  tab,
  active,
  focused,
  chipRefCallback,
  onActivate,
  onClose,
  onMiddleClick,
}: ChipProps) {
  const onAuxClick = useCallback(
    (e: React.MouseEvent) => {
      // Middle button = 1. Some browsers fire auxclick instead of click for it.
      if (e.button !== 1) return;
      e.preventDefault();
      onMiddleClick?.(tab.id);
    },
    [onMiddleClick, tab.id],
  );

  return (
    <div
      ref={chipRefCallback}
      onAuxClick={onAuxClick}
      onClick={() => onActivate(tab.id)}
      className={cn(
        "group flex h-7 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors",
        active && focused
          ? "bg-foreground/[0.08] text-foreground"
          : active
            ? "bg-foreground/[0.04] text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
      )}
      style={{ WebkitUserSelect: "none" } satisfies CSSProperties}
    >
      <span className="max-w-[220px] truncate">{tab.title}</span>
      <button
        type="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="ml-1 inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
      </button>
    </div>
  );
});
