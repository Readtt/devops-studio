import { memo, useCallback } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  useFocusedLeafId,
  useHasMultiplePanes,
  useLeafTabs,
  useTabsStore,
} from "./store/useTabsStore";
import type { LeafNode } from "./store/types";
import { TabStrip } from "./TabStrip";
import { TabContent } from "./TabContent";
import { leafCenterDropId } from "./dnd/dndIds";
import { DropEdges } from "./dnd/DropEdges";

type Props = {
  leaf: LeafNode;
  sourceRoot: string | null;
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
export const LeafPane = memo(function LeafPane({
  leaf,
  sourceRoot,
  emptyState,
}: Props) {
  const tabs = useLeafTabs(leaf.id);
  const focusedLeafId = useFocusedLeafId();
  const focused = focusedLeafId === leaf.id;
  const activeId = leaf.activeTabId;
  const hasMultiplePanes = useHasMultiplePanes();
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
        // Focus ring only helps the user when there's more than one pane
        // to compare against. Single-pane: the ring is just noise. Empty
        // single-pane (no tabs open): definitely no ring — the welcome
        // copy carries the visual weight instead.
        focused &&
          hasMultiplePanes &&
          hasTabs &&
          "ring-1 ring-primary/25 ring-inset",
        // Cross-leaf drop hint: gentle inset, not a hard outline.
        leafOver && "bg-primary/[0.03]",
      )}
      onPointerDownCapture={onFocus}
    >
      {/* Tab strip. Hidden when the leaf has no tabs — root leaf's empty
          state owns the whole area. */}
      {hasTabs ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 bg-card/40 px-1">
          <TabStrip
            tabs={tabs}
            activeTabId={activeId}
            leafId={leaf.id}
            focused={focused}
            onActivate={onActivate}
            onClose={onClose}
            onMiddleClick={onMiddleClick}
            onFocus={onFocus}
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
                  <TabContent tab={t} sourceRoot={sourceRoot} />
                </div>
              );
            })}
      </div>
    </div>
  );
});
