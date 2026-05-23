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
 * Right-click menu over a single tab chip. Minimal by design — labels
 * carry the meaning, keybind hints sit on the right.
 */
export const TabContextMenu = memo(function TabContextMenu({
  tab,
  leafId,
  children,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => useTabsStore.getState().closeTab(tab.id)}
          disabled={tab.pinned}
        >
          Close
          <Kbd id="tab.close" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
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
          onSelect={() => useTabsStore.getState().togglePin(tab.id)}
        >
          {tab.pinned ? "Unpin tab" : "Pin tab"}
          <Kbd id="tab.pin" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => useTabsStore.getState().duplicateTab(tab.id)}
        >
          Duplicate
          <Kbd id="tab.duplicate" />
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={
            <HugeiconsIcon icon={Tag01Icon} size={12} strokeWidth={1.75} />
          }
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
