import { memo, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeftRightIcon,
  Cancel01Icon,
  Copy01Icon,
  PinIcon,
  SquareLock01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import {
  getBindingTokens,
  getPrimaryBinding,
  type ShortcutId,
} from "@/modules/shortcuts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTabsStore } from "./store/useTabsStore";
import type { AppTab } from "./store/types";

type Props = {
  tab: AppTab;
  /** Id of the leaf the tab currently belongs to. Used as the scope for
   *  Close Others / Close to Right / Close All. */
  leafId: string;
  children: ReactNode;
};

/**
 * Right-click menu over a single tab chip. Items use the Linear-style
 * `icon` + `description` props (NOT nested Tooltip — radix portals would
 * fight inside ContextMenu) so right-clickers can preview each action.
 */
export const TabContextMenu = memo(function TabContextMenu({
  tab,
  leafId,
  children,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-72">
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          description={
            tab.pinned
              ? "Pinned tab — unpin first to close it."
              : "Close this tab. Reopen with Ctrl+Shift+T."
          }
          onSelect={() =>
            useTabsStore.getState().closeTab(tab.id)
          }
          disabled={tab.pinned}
        >
          Close
          <Kbd id="tab.close" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          description="Close every tab in this pane except this one. Pinned tabs are kept."
          onSelect={() => {
            useTabsStore.getState().setActiveInLeaf(leafId, tab.id);
            useTabsStore.getState().closeOthers(leafId);
          }}
        >
          Close others
          <Kbd id="tab.closeOthers" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          description="Close tabs to the right of this one in the pane. Pinned tabs are kept."
          onSelect={() => {
            useTabsStore.getState().setActiveInLeaf(leafId, tab.id);
            useTabsStore.getState().closeToRight(leafId);
          }}
        >
          Close to the right
          <Kbd id="tab.closeToRight" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          description="Close every tab in this pane. Pinned tabs are kept."
          onSelect={() => useTabsStore.getState().closeAll(leafId)}
        >
          Close all
          <Kbd id="tab.closeAll" />
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={
            <HugeiconsIcon
              icon={tab.pinned ? SquareLock01Icon : PinIcon}
              size={12}
              strokeWidth={1.75}
            />
          }
          description={
            tab.pinned
              ? "Unpin this tab. It'll behave like a normal tab again."
              : "Pin this tab. Pinned tabs stay at the left of the strip and survive Close All / Close Others."
          }
          onSelect={() => useTabsStore.getState().togglePin(tab.id)}
        >
          {tab.pinned ? "Unpin tab" : "Pin tab"}
          <Kbd id="tab.pin" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
          description="Open a second copy of this tab. Generator tabs start fresh — drafts aren't duplicated."
          onSelect={() => useTabsStore.getState().duplicateTab(tab.id)}
        >
          Duplicate tab
          <Kbd id="tab.duplicate" />
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={
            <HugeiconsIcon icon={Tag01Icon} size={12} strokeWidth={1.75} />
          }
          description="Split this pane horizontally and move this tab into the new pane to the right."
          onSelect={() => {
            useTabsStore
              .getState()
              .splitLeaf(leafId, "horizontal", "after", tab.id);
          }}
        >
          Split right
          <Kbd id="pane.splitRight" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={
            <HugeiconsIcon icon={Tag01Icon} size={12} strokeWidth={1.75} />
          }
          description="Split this pane vertically and move this tab into the new pane below."
          onSelect={() => {
            useTabsStore
              .getState()
              .splitLeaf(leafId, "vertical", "after", tab.id);
          }}
        >
          Split down
          <Kbd id="pane.splitDown" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={
            <HugeiconsIcon
              icon={ArrowLeftRightIcon}
              size={12}
              strokeWidth={1.75}
            />
          }
          description="Move this tab to the next pane in tree order. Only useful when more than one pane is open."
          onSelect={() => useTabsStore.getState().moveTabToNextPane(tab.id)}
        >
          Move to next pane
          <Kbd id="tab.moveToNextPane" />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function Kbd({ id }: { id: ShortcutId }) {
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const b = getPrimaryBinding(id, userShortcuts);
  const tokens = getBindingTokens(b);
  if (tokens.length === 0) return null;
  return <ContextMenuShortcut>{tokens.join(" ")}</ContextMenuShortcut>;
}
