import { memo, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
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
      <ContextMenuContent className="w-60 [&_[data-slot=context-menu-item]]:whitespace-nowrap">
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => useTabsStore.getState().closeTab(tab.id)}
          disabled={tab.pinned}
        >
          Close
          <ShortcutKbd id="tab.close" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => {
            useTabsStore.getState().setActiveInLeaf(leafId, tab.id);
            useTabsStore.getState().closeOthers(leafId);
          }}
        >
          Close others
          <ShortcutKbd id="tab.closeOthers" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => {
            useTabsStore.getState().setActiveInLeaf(leafId, tab.id);
            useTabsStore.getState().closeToRight(leafId);
          }}
        >
          Close to the right
          <ShortcutKbd id="tab.closeToRight" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => useTabsStore.getState().closeAll(leafId)}
        >
          Close all
          <ShortcutKbd id="tab.closeAll" />
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
          <ShortcutKbd id="tab.pin" />
        </ContextMenuItem>
        <ContextMenuItem
          icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
          onSelect={() => {
            // Generator tabs own a live per-tab session store the tabs store
            // can't reach, so a plain duplicate would spawn an empty draft.
            // Hand off to App, which clones the draft into an independent
            // new session. Everything else duplicates in place.
            if (tab.kind === "generator") {
              window.dispatchEvent(
                new CustomEvent("devops-studio:duplicate-generator", {
                  detail: { tabId: tab.id },
                }),
              );
            } else {
              useTabsStore.getState().duplicateTab(tab.id);
            }
          }}
        >
          Duplicate
          <ShortcutKbd id="tab.duplicate" />
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
          <ShortcutKbd id="pane.splitRight" />
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
          <ShortcutKbd id="pane.splitDown" />
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
          <ShortcutKbd id="tab.moveToNextPane" />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function ShortcutKbd({ id }: { id: ShortcutId }) {
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const b = getPrimaryBinding(id, userShortcuts);
  const tokens = getBindingTokens(b);
  if (tokens.length === 0) return null;
  // Single chip with tokens joined — "Ctrl+Shift+W" reads naturally and
  // fits a context-menu row even with 4 modifiers, where stacked chips
  // overflowed the menu and wrapped the label.
  return <Kbd className="ml-auto px-1.5">{tokens.join("+")}</Kbd>;
}
