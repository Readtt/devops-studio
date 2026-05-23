import { memo, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Cancel01Icon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AppTab, TabKind } from "./store/types";
import { TabContextMenu } from "./TabContextMenu";

type Props = {
  /** Tabs to render, in display order. Pinned-first sorting is the
   *  responsibility of the store selector. */
  tabs: AppTab[];
  activeTabId: number | null;
  /** Id of the leaf this strip belongs to — passed to the context menu
   *  for scope-correct close-others / split actions. */
  leafId: string;
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
 * Horizontal strip of tab chips per leaf. Includes per-chip context menu,
 * pin icon, kind dot, middle-click close, and hover tooltip. No dnd yet
 * — Step 5 layers SortableContext on top.
 */
export const TabStrip = memo(function TabStrip({
  tabs,
  activeTabId,
  leafId,
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
            leafId={leafId}
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
  leafId: string;
  active: boolean;
  focused: boolean;
  chipRefCallback?: (el: HTMLDivElement | null) => void;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onMiddleClick?: (tabId: number) => void;
};

const TabChip = memo(function TabChip({
  tab,
  leafId,
  active,
  focused,
  chipRefCallback,
  onActivate,
  onClose,
  onMiddleClick,
}: ChipProps) {
  const onAuxClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (tab.pinned) return; // middle-click skips pinned, matching browsers
      onMiddleClick?.(tab.id);
    },
    [onMiddleClick, tab.id, tab.pinned],
  );

  return (
    <TabContextMenu tab={tab} leafId={leafId}>
      <Tooltip>
        <TooltipTrigger asChild>
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
            <span
              aria-hidden
              className={cn(
                "h-[5px] w-[5px] shrink-0 rounded-full",
                kindDotClass(tab.kind),
              )}
            />
            {tab.pinned ? (
              <HugeiconsIcon
                icon={PinIcon}
                size={9}
                strokeWidth={1.75}
                className="shrink-0 text-foreground/70"
              />
            ) : null}
            <span className={cn("truncate", tab.pinned ? "max-w-[150px]" : "max-w-[220px]")}>
              {tab.title}
            </span>
            {!tab.pinned ? (
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
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[420px] text-[11px]">
          {describeTab(tab)}
        </TooltipContent>
      </Tooltip>
    </TabContextMenu>
  );
});

/**
 * 5px dot to the left of the title, color-coded by kind for at-a-glance
 * scanning. Uses Tailwind palette tokens so dark/light themes both work.
 */
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
  }
}

function kindLabel(kind: TabKind): string {
  switch (kind) {
    case "generator":
      return "Generator";
    case "test-case":
      return "Test case";
    case "bug":
      return "Bug";
    case "suite-chat":
      return "Suite chat";
    case "code-viewer":
      return "Code";
  }
}

function describeTab(tab: AppTab): string {
  const k = kindLabel(tab.kind);
  switch (tab.kind) {
    case "test-case":
      return `${k} · #${tab.caseId} — ${tab.title}`;
    case "bug":
      return `${k} · #${tab.bugId} — ${tab.title}`;
    case "code-viewer": {
      const range = tab.startLine
        ? `:${tab.startLine}${tab.endLine && tab.endLine !== tab.startLine ? `–${tab.endLine}` : ""}`
        : "";
      return `${k} · ${tab.path}${range}`;
    }
    case "suite-chat":
      return `${k} · ${tab.title}`;
    case "generator":
      return `${k} · ${tab.title}`;
  }
}
