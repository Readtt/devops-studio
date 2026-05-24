import { memo, useCallback, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Cancel01Icon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { AppTab, TabKind } from "./store/types";
import { useTabsStore } from "./store/useTabsStore";
import { TabContextMenu } from "./TabContextMenu";
import { tabDragId } from "./dnd/dndIds";

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
  /** Rendered immediately after the last chip, inside the scrollable
   *  area. Used by LeafPane to drop the "+" launcher right next to
   *  the tabs (Chrome-style) instead of pinning it to the pane's
   *  right edge. */
  inlineSuffix?: React.ReactNode;
};

/**
 * Horizontal strip of tab chips. Each chip is a dnd-kit sortable item.
 * Cross-leaf drops are handled by the top-level DndProvider.
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
  inlineSuffix,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaX !== 0) return;
    if (e.deltaY === 0) return;
    el.scrollLeft += e.deltaY;
  }, []);

  // SortableContext expects a stable array of dnd ids. Encode "tab + leaf"
  // so identical tab ids across leaves stay disambiguated.
  const sortableIds = useMemo(
    () => tabs.map((t) => tabDragId(t.id, leafId)),
    [tabs, leafId],
  );

  return (
    <div
      ref={scrollRef}
      onWheel={onWheel}
      onPointerDown={onFocus}
      className="tabs-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
    >
      {tabs.length === 0 ? (
        <span className="px-2 text-[11px] text-muted-foreground">No tabs</span>
      ) : (
        <SortableContext
          items={sortableIds}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((t) => (
            <SortableTabChip
              key={t.id}
              tab={t}
              leafId={leafId}
              active={t.id === activeTabId}
              focused={focused}
              onActivate={onActivate}
              onClose={onClose}
              onMiddleClick={onMiddleClick}
            />
          ))}
        </SortableContext>
      )}
      {/* Launcher rides inside the scroll container so it stays glued
          to the last chip — when the strip overflows, the launcher
          scrolls with the tabs instead of floating away on the pane's
          right edge. ml-0.5 keeps the same gap rhythm as between chips. */}
      {inlineSuffix ? <div className="ml-0.5 flex shrink-0 items-center">{inlineSuffix}</div> : null}
    </div>
  );
});

type ChipProps = {
  tab: AppTab;
  leafId: string;
  active: boolean;
  focused: boolean;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onMiddleClick?: (tabId: number) => void;
};

function SortableTabChip(props: ChipProps) {
  const id = tabDragId(props.tab.id, props.leafId);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    WebkitUserSelect: "none",
    // Hide the sortable-source chip while it follows the cursor in the
    // DragOverlay — feels nicer than two clones onscreen.
    opacity: isDragging ? 0.35 : undefined,
  };

  return (
    <TabContextMenu tab={props.tab} leafId={props.leafId}>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        // Native title carries the long hover description (path, ids, etc.)
        // without nesting a Radix Tooltip — which would collide with the
        // ContextMenu's asChild trigger and break right-click pin/dup/close.
        title={describeTab(props.tab)}
        // Opt back into the OS contextmenu pipeline; the production-only
        // right-click guard (lib/contextMenuGuard.ts) blocks contextmenu
        // outside this attribute, which would otherwise also suppress the
        // Radix menu in built apps.
        data-allow-context-menu="true"
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          if (props.tab.pinned) return;
          props.onMiddleClick?.(props.tab.id);
        }}
        onClick={() => props.onActivate(props.tab.id)}
        className={cn(
          "group flex h-7 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors",
          props.active && props.focused
            ? "bg-foreground/[0.08] text-foreground"
            : props.active
              ? "bg-foreground/[0.04] text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-[5px] w-[5px] shrink-0 rounded-full",
            kindDotClass(props.tab.kind),
          )}
        />
        {props.tab.pinned ? (
          <HugeiconsIcon
            icon={PinIcon}
            size={9}
            strokeWidth={1.75}
            className="shrink-0 text-foreground/70"
          />
        ) : null}
        <span
          className={cn(
            "truncate",
            props.tab.pinned ? "max-w-[150px]" : "max-w-[220px]",
          )}
        >
          {props.tab.title}
        </span>
        {/* Pin toggle — appears on hover. Pinned tabs still show the
            small leading PinIcon above so users can see the state at a
            glance; this button is the action surface for changing it. */}
        <button
          type="button"
          aria-label={props.tab.pinned ? "Unpin tab" : "Pin tab"}
          title={props.tab.pinned ? "Unpin tab" : "Pin tab"}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            useTabsStore.getState().togglePin(props.tab.id);
          }}
          className={cn(
            "ml-1 inline-flex size-4 items-center justify-center rounded text-muted-foreground",
            "hover:bg-foreground/10 hover:text-foreground",
            // Hide unless the chip is hovered OR the tab is pinned (we
            // need the unpin affordance ALWAYS visible for pinned tabs
            // since they have no close button to telegraph "here's where
            // actions live").
            !props.tab.pinned && "opacity-0 transition-opacity group-hover:opacity-100",
          )}
        >
          <HugeiconsIcon
            icon={props.tab.pinned ? PinOffIcon : PinIcon}
            size={10}
            strokeWidth={1.75}
          />
        </button>
        {!props.tab.pinned ? (
          <button
            type="button"
            aria-label="Close tab"
            title="Close (middle-click also works)"
            onPointerDown={(e) => {
              // Stop the sortable's drag-listener from grabbing this
              // pointerdown — otherwise the close button is unclickable
              // because the chip starts dragging the moment you press.
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose(props.tab.id);
            }}
            className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
          </button>
        ) : null}
      </div>
    </TabContextMenu>
  );
}

// Memoize the sortable chip so unrelated tabs don't re-render on every drag tick.
const MemoizedChip = memo(SortableTabChip);
export { MemoizedChip as TabChip };

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
    case "terminal":
      return "bg-emerald-400 dark:bg-emerald-500";
    case "code-review":
      return "bg-fuchsia-400 dark:bg-fuchsia-500";
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
    case "terminal":
      return "Terminal";
    case "code-review":
      return "Code review";
  }
}

function describeTab(tab: AppTab): string {
  const k = kindLabel(tab.kind);
  const pinNote = tab.pinned ? " · pinned" : "";
  const hint = "\nRight-click for options · Middle-click to close";
  let line: string;
  switch (tab.kind) {
    case "test-case":
      line = `${k} · #${tab.caseId} — ${tab.title}`;
      break;
    case "bug":
      line = `${k} · #${tab.bugId} — ${tab.title}`;
      break;
    case "code-viewer": {
      const range = tab.startLine
        ? `:${tab.startLine}${tab.endLine && tab.endLine !== tab.startLine ? `–${tab.endLine}` : ""}`
        : "";
      line = `${k} · ${tab.path}${range}`;
      break;
    }
    case "suite-chat":
      line = `${k} · ${tab.title}`;
      break;
    case "generator":
      line = `${k} · ${tab.title}`;
      break;
    case "terminal":
      line = `${k} · ${tab.title}`;
      break;
    case "code-review":
      line = `${k} · ${tab.title}`;
      break;
  }
  return `${line}${pinNote}${hint}`;
}
