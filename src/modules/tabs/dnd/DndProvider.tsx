import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useTabsStore } from "../store/useTabsStore";
import {
  parseLeafCenterId,
  parseLeafEdgeId,
  parseTabDragId,
} from "./dndIds";
import type { AppTab } from "../store/types";
import { findLeafByTab } from "../store/paneTreeOps";
import { TabDragGhost } from "./TabDragGhost";
import { tabAwareCollision } from "./collision";

type Props = { children: ReactNode };

/**
 * Single DndContext wrapping the entire workspace. Handles:
 *
 *  - reorder within a tab strip (sortable chip → sortable chip, same leaf)
 *  - cross-leaf move (chip → chip in another leaf, OR chip → leaf-center)
 *  - drag-to-split (chip → leaf-edge zone, in one of four directions)
 *
 * Holding Ctrl/Cmd during the drop clones the tab instead of moving it.
 * The clone behaves like Duplicate Tab — same content, new id, dropped
 * at the target index.
 */
export function DndProvider({ children }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [draggedTab, setDraggedTab] = useState<AppTab | null>(null);
  // Capture the modifier state at drop time (not start time) so the user
  // can decide mid-drag. dnd-kit's events don't expose the raw KeyboardEvent
  // on drop, so we listen to the native pointerup ourselves.
  const cloneOnDropRef = useRef(false);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const parsed = parseTabDragId(String(e.active.id));
    if (!parsed) return;
    const tab = useTabsStore.getState().tabs[parsed.tabId];
    if (tab) setDraggedTab(tab);
    cloneOnDropRef.current = false;
    const onUp = (ev: PointerEvent) => {
      cloneOnDropRef.current = ev.ctrlKey || ev.metaKey;
    };
    window.addEventListener("pointerup", onUp, { once: true, capture: true });
  }, []);

  const onDragEnd = useCallback((e: DragEndEvent) => {
    const clone = cloneOnDropRef.current;
    cloneOnDropRef.current = false;
    setDraggedTab(null);
    if (!e.over) return;

    const src = parseTabDragId(String(e.active.id));
    if (!src) return;

    const overId = String(e.over.id);

    // 1. Drop on another sortable chip → reorder or cross-leaf move.
    const dst = parseTabDragId(overId);
    if (dst) {
      const tree = useTabsStore.getState().paneTree;
      const srcLeaf = findLeafByTab(tree, src.tabId);
      if (!srcLeaf) return;
      if (clone) {
        const newId = useTabsStore.getState().duplicateTab(src.tabId);
        if (newId != null) {
          const dstLeaf = findLeafByTab(useTabsStore.getState().paneTree, dst.tabId);
          if (dstLeaf) {
            const at = dstLeaf.tabIds.indexOf(dst.tabId);
            useTabsStore
              .getState()
              .moveTabToLeaf(newId, dstLeaf.id, at < 0 ? undefined : at);
          }
        }
        return;
      }
      if (srcLeaf.id === dst.leafId) {
        const from = srcLeaf.tabIds.indexOf(src.tabId);
        const to = srcLeaf.tabIds.indexOf(dst.tabId);
        if (from < 0 || to < 0 || from === to) return;
        useTabsStore.getState().reorderInLeaf(srcLeaf.id, from, to);
        return;
      }
      const dstLeaf = findLeafByTab(tree, dst.tabId);
      if (!dstLeaf) return;
      const insertAt = dstLeaf.tabIds.indexOf(dst.tabId);
      useTabsStore
        .getState()
        .moveTabToLeaf(src.tabId, dstLeaf.id, insertAt < 0 ? undefined : insertAt);
      return;
    }

    // 2. Drop on an edge zone → split the leaf and place the tab. The
    // store's splitLeaf is cross-leaf aware: it removes the moved tab
    // from whichever leaf currently owns it, then puts it in the new
    // sibling adjacent to the target leaf.
    const edge = parseLeafEdgeId(overId);
    if (edge) {
      const direction =
        edge.side === "top" || edge.side === "bottom"
          ? "vertical"
          : "horizontal";
      const sideForSplit =
        edge.side === "right" || edge.side === "bottom" ? "after" : "before";
      const moveId = clone
        ? useTabsStore.getState().duplicateTab(src.tabId)
        : src.tabId;
      if (moveId == null) return;
      // No-op when dropping a tab on its own leaf's edge if it's the
      // only tab there (would collapse → identity), but the store
      // normalizes the tree afterward so we can call unconditionally.
      useTabsStore
        .getState()
        .splitLeaf(edge.leafId, direction, sideForSplit, moveId);
      return;
    }

    // 3. Drop on a leaf body (no chip, no edge) → append into that leaf.
    const centerLeafId = parseLeafCenterId(overId);
    if (centerLeafId) {
      const tree = useTabsStore.getState().paneTree;
      if (clone) {
        const newId = useTabsStore.getState().duplicateTab(src.tabId);
        if (newId != null) {
          useTabsStore.getState().moveTabToLeaf(newId, centerLeafId);
        }
        return;
      }
      const srcLeaf = findLeafByTab(tree, src.tabId);
      if (!srcLeaf || srcLeaf.id === centerLeafId) return;
      useTabsStore.getState().moveTabToLeaf(src.tabId, centerLeafId);
      return;
    }
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={tabAwareCollision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggedTab(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {draggedTab ? <TabDragGhost tab={draggedTab} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
