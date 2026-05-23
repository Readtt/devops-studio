import { memo, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  useFocusedLeafId,
  useLeafTabs,
  useTabsStore,
} from "./store/useTabsStore";
import type { LeafNode } from "./store/types";
import { TabStrip } from "./TabStrip";
import { TabContent } from "./TabContent";

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

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background",
        // Focus ring only matters once there's more than one pane. It's
        // safe to render always — the single-pane case won't notice 1px
        // of inset ring it can't compare to anything. Subtle by design.
        focused && "ring-1 ring-primary/20 ring-inset",
      )}
      onPointerDownCapture={onFocus}
    >
      {/* Tab strip. Hidden when the leaf has no tabs — root leaf's empty
          state owns the whole area. */}
      {tabs.length > 0 ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 bg-card/40 px-1">
          <TabStrip
            tabs={tabs}
            activeTabId={activeId}
            focused={focused}
            onActivate={onActivate}
            onClose={onClose}
            onMiddleClick={onMiddleClick}
            onFocus={onFocus}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0
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
