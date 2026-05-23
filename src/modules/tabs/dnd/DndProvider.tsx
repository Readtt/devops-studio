import { useCallback, useState, type ReactNode } from "react";
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
import { parseLeafCenterId, parseTabDragId } from "./dndIds";
import type { AppTab } from "../store/types";
import { findLeafByTab } from "../store/paneTreeOps";
import { TabDragGhost } from "./TabDragGhost";

type Props = { children: ReactNode };

/**
 * Single DndContext wrapping the entire workspace. Step 5 implements only
 * reorder-within-strip (drop targets: `tab-slot:*`). Cross-leaf moves and
 * edge-zone splits land in steps 6 and 7.
 *
 * PointerSensor activation distance: 4px. Without this, clicking a tab to
 * activate it could be intercepted as the start of a drag.
 */
export function DndProvider({ children }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [draggedTab, setDraggedTab] = useState<AppTab | null>(null);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const parsed = parseTabDragId(String(e.active.id));
    if (!parsed) return;
    const tab = useTabsStore.getState().tabs[parsed.tabId];
    if (tab) setDraggedTab(tab);
  }, []);

  const onDragEnd = useCallback((e: DragEndEvent) => {
    setDraggedTab(null);
    if (!e.over) return;
    const src = parseTabDragId(String(e.active.id));
    if (!src) return;

    const overId = String(e.over.id);

    // Reorder when dropping over another sortable chip. SortableContext
    // gives us the destination tab's id; we translate to leaf-index moves.
    const dst = parseTabDragId(overId);
    if (dst) {
      const tree = useTabsStore.getState().paneTree;
      const srcLeaf = findLeafByTab(tree, src.tabId);
      if (!srcLeaf) return;
      // Same-leaf reorder.
      if (srcLeaf.id === dst.leafId) {
        const from = srcLeaf.tabIds.indexOf(src.tabId);
        const to = srcLeaf.tabIds.indexOf(dst.tabId);
        if (from < 0 || to < 0 || from === to) return;
        useTabsStore.getState().reorderInLeaf(srcLeaf.id, from, to);
        return;
      }
      // Cross-leaf move. Insert at the destination tab's index.
      const dstLeaf = findLeafByTab(tree, dst.tabId);
      if (!dstLeaf) return;
      const insertAt = dstLeaf.tabIds.indexOf(dst.tabId);
      useTabsStore
        .getState()
        .moveTabToLeaf(src.tabId, dstLeaf.id, insertAt < 0 ? undefined : insertAt);
      return;
    }

    // Drop into the body of a leaf (no specific tab as target) — append.
    const centerLeafId = parseLeafCenterId(overId);
    if (centerLeafId) {
      const tree = useTabsStore.getState().paneTree;
      const srcLeaf = findLeafByTab(tree, src.tabId);
      if (!srcLeaf || srcLeaf.id === centerLeafId) return;
      useTabsStore.getState().moveTabToLeaf(src.tabId, centerLeafId);
      return;
    }
  }, []);

  return (
    <DndContext
      sensors={sensors}
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

