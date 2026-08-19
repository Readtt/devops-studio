import { Fragment, memo, useCallback } from "react";
import type { Layout } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { PaneNode } from "./store/types";
import { LeafPane } from "./LeafPane";
import { useTabsStore } from "./store/useTabsStore";

type Props = {
  node: PaneNode;
  /** Empty-state for the (single, root) leaf when no tabs are open. */
  emptyState?: React.ReactNode;
};

/**
 * Recursively walks the pane tree, rendering ResizablePanelGroups for
 * splits and LeafPanes for leaves. ResizablePanel size is read from the
 * node's `sizes` array on every paint — react-resizable-panels treats
 * `defaultSize` as initial-only, so persisted sizes survive restart but
 * the active drag state is also tracked by the library internally.
 */
export const PaneTreeRenderer = memo(function PaneTreeRenderer({
  node,
  emptyState,
}: Props) {
  if (node.kind === "leaf") {
    return <LeafPane leaf={node} emptyState={emptyState} />;
  }
  return <SplitRenderer node={node} />;
});

function SplitRenderer({ node }: { node: PaneNode & { kind: "split" } }) {
  const childrenIds = node.children.map((c) => c.id).join("|");
  const splitId = node.id;
  const childCount = node.children.length;
  const onLayoutChanged = useCallback(
    (layout: Layout) => {
      // Convert the library's id-keyed Layout map to an ordered sizes
      // array matching the children. `onLayoutChanged` is the debounced
      // variant so we don't burn cycles on every pixel of drag.
      const ids = childrenIds.split("|");
      const sizes = ids.map((id) => layout[id] ?? 100 / ids.length);
      useTabsStore.getState().setSplitSizes(splitId, sizes);
    },
    [childrenIds, splitId, childCount],
  );
  return (
    <ResizablePanelGroup
      orientation={node.direction}
      onLayoutChanged={onLayoutChanged}
      className="h-full min-h-0 w-full"
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <ResizablePanel
            id={child.id}
            defaultSize={`${node.sizes[i] ?? 100 / node.children.length}%`}
            minSize="10%"
          >
            <PaneTreeRenderer node={child} />
          </ResizablePanel>
          {i < node.children.length - 1 ? <ResizableHandle /> : null}
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
