import { memo, useCallback, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  useFocusedLeafId,
  useLeafTabs,
  useTabsStore,
} from "./store/useTabsStore";
import type { LeafNode } from "./store/types";
import { TabStrip } from "./TabStrip";
import { TabContent } from "./TabContent";
import { leafCenterDropId } from "./dnd/dndIds";
import { DropEdges } from "./dnd/DropEdges";
import { LaunchMenuItems } from "./LaunchMenu";
import {
  launchCommitReview,
  launchGenerator,
  launchTerminal,
} from "./launchActions";
import { usePrimaryRepoRoot } from "@/modules/settings/preferences";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Props = {
  leaf: LeafNode;
  /** Empty-state shown when the leaf has zero tabs. Defaults to nothing —
   *  App.tsx supplies the welcome copy for the root leaf. */
  emptyState?: React.ReactNode;
};

/**
 * One pane in the workspace. Owns its own tab strip + content area. All
 * tabs in this leaf are mounted simultaneously with visibility-hidden on
 * inactive ones — same model the kind-Stacks used today. This preserves
 * scroll, CodeMirror state, in-progress generator analyses, and the live
 * dom of every panel while keeping switching instant.
 *
 * The leaf-center droppable covers BOTH the strip and the body so a tab
 * dragged from another leaf can be dropped on the empty strip area (or
 * anywhere on the body) and lands at the end of this leaf.
 */
export const LeafPane = memo(function LeafPane({ leaf, emptyState }: Props) {
  const tabs = useLeafTabs(leaf.id);
  const focusedLeafId = useFocusedLeafId();
  const focused = focusedLeafId === leaf.id;
  const activeId = leaf.activeTabId;
  const hasTabs = tabs.length > 0;

  const onActivate = useCallback(
    (tabId: number) => {
      useTabsStore.getState().setActiveInLeaf(leaf.id, tabId);
    },
    [leaf.id],
  );

  const onClose = useCallback((tabId: number) => {
    useTabsStore.getState().closeTab(tabId);
  }, []);

  const onMiddleClick = useCallback((tabId: number) => {
    useTabsStore.getState().closeTab(tabId);
  }, []);

  const onFocus = useCallback(() => {
    if (focusedLeafId === leaf.id) return;
    useTabsStore.getState().focusLeaf(leaf.id);
  }, [focusedLeafId, leaf.id]);

  // Leaf-wide droppable. When a tab is dragged from another leaf and the
  // pointer ends over this leaf (anywhere — strip or body), the tab is
  // appended. isOver gives a subtle visual confirmation.
  const { setNodeRef: setLeafRef, isOver: leafOver } = useDroppable({
    id: leafCenterDropId(leaf.id),
  });

  return (
    <div
      ref={setLeafRef}
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background",
        // Focused-pane signal lives on the active tab chip (it sits at
        // bg-foreground/[0.08] in the focused pane vs /[0.04] in an
        // unfocused pane). The previous inset ring was duplicate noise.
        // Cross-leaf drop hint: gentle inset, not a hard outline.
        leafOver && "bg-primary/[0.03]",
      )}
      onPointerDownCapture={onFocus}
    >
      {/* Tab strip with the "+" launcher inlined as a strip suffix —
          glued to the right of the last chip so it reads as part of
          the tab row instead of floating at the pane's far edge. */}
      {hasTabs ? (
        <div className="flex h-9 shrink-0 items-center border-b border-border/40 bg-card/40 px-1">
          <TabStrip
            tabs={tabs}
            activeTabId={activeId}
            leafId={leaf.id}
            focused={focused}
            onActivate={onActivate}
            onClose={onClose}
            onMiddleClick={onMiddleClick}
            onFocus={onFocus}
            inlineSuffix={<NewTabInlineLauncher />}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/* Drag-to-split edge zones. Only mounted during an active drag
            so they don't block hit-tests on the underlying content. */}
        <DropEdges leafId={leaf.id} />
        {!hasTabs
          ? emptyState
          : tabs.map((t) => {
              const visible = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "absolute inset-0",
                    visible ? "pointer-events-auto" : "pointer-events-none",
                  )}
                  style={{ visibility: visible ? "visible" : "hidden" }}
                  aria-hidden={!visible}
                >
                  <TabContent tab={t} />
                </div>
              );
            })}
      </div>
    </div>
  );
});

/** End-of-strip "+" launcher. Always visible when at least one tab is
 *  open in this leaf — gives the user a Chrome-style new-tab affordance
 *  without making them hunt for the top-bar button.
 *
 *  Composition note: Radix needs Tooltip to wrap PopoverTrigger (not the
 *  other way around) because Tooltip.Root is a Provider with no DOM
 *  element of its own — putting it inside `<PopoverTrigger asChild>`
 *  means Radix's Slot can't wire onClick to anything, and clicks get
 *  silently swallowed. So we own the Popover here and drop bare
 *  LaunchMenuItems into the content.
 */
function NewTabInlineLauncher() {
  const sourceRoot = usePrimaryRepoRoot();
  const [open, setOpen] = useState(false);
  const actions = {
    onGenerator: launchGenerator,
    onTerminal: launchTerminal,
    onCommitReview: launchCommitReview,
    sourceRoot,
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="New tab"
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-md",
                "text-muted-foreground transition-colors",
                "hover:bg-foreground/[0.06] hover:text-foreground",
                open && "bg-foreground/[0.06] text-foreground",
              )}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          New tab — Generate, Terminal, or Review
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
      >
        <LaunchMenuItems actions={actions} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
