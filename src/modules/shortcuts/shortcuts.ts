import { IS_MAC, MOD_PROP } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts. The Shortcuts settings
 * page renders whatever lives here; useGlobalShortcuts dispatches on it.
 *
 * Generator review-phase keys (j / k / space / p / Esc) are intentionally
 * context-local and not declared here — they only fire when the review
 * grid is on screen and the user isn't typing in an input.
 */

export type ShortcutId =
  | "palette.open"
  | "settings.open"
  | "sidebar.toggle"
  | "theme.cycle"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.pin"
  | "tab.duplicate"
  | "tab.closeOthers"
  | "tab.closeToRight"
  | "tab.closeAll"
  | "tab.reopenClosed"
  | "tab.jumpTo1"
  | "tab.jumpTo2"
  | "tab.jumpTo3"
  | "tab.jumpTo4"
  | "tab.jumpTo5"
  | "tab.jumpTo6"
  | "tab.jumpTo7"
  | "tab.jumpTo8"
  | "tab.jumpTo9"
  | "tab.moveToNextPane"
  | "tab.moveToPrevPane"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.close"
  | "pane.focusLeft"
  | "pane.focusRight"
  | "pane.focusUp"
  | "pane.focusDown"
  | "generator.new"
  | "terminal.new"
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.clear"
  | "terminal.fontSizeUp"
  | "terminal.fontSizeDown"
  | "codeReview.new"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Panes"
  | "View"
  | "ADO"
  | "Terminal";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  allowRepeat?: boolean;
};

function buildJumpToShortcuts(): Shortcut[] {
  const out: Shortcut[] = [];
  for (let i = 1; i <= 9; i++) {
    out.push({
      id: `tab.jumpTo${i}` as ShortcutId,
      label:
        i === 9 ? "Jump to last tab in pane" : `Jump to tab ${i} in pane`,
      group: "Tabs",
      defaultBindings: [{ [MOD_PROP]: true, key: String(i) }],
    });
  }
  return out;
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: "palette.open",
    label: "Open command palette",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "k" }],
  },
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "," }],
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar (Plans / History)",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "b" }],
  },
  {
    id: "theme.cycle",
    label: "Cycle theme (System → Light → Dark)",
    group: "General",
    // Rebound from Ctrl+Shift+T → Ctrl+Shift+L so the universal
    // "reopen closed tab" binding can take Ctrl+Shift+T. Users with a
    // custom binding in preferences keep theirs.
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "l" }],
  },
  {
    id: "generator.new",
    label: "New Generate tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "g" }],
  },
  {
    id: "terminal.new",
    label: "New terminal tab",
    group: "Tabs",
    // Ctrl/Cmd+Shift+` mirrors VS Code's "New Terminal" muscle memory.
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "`" }],
  },
  {
    id: "codeReview.new",
    label: "New code review",
    group: "Tabs",
    // Ctrl/Cmd+Shift+R — R for Review. Plain Ctrl+R is browser refresh in
    // most webviews, so we take the shift slot.
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "r" }],
  },
  {
    id: "terminal.copy",
    label: "Copy terminal selection",
    group: "Terminal",
    // Ctrl/Cmd+Shift+C is the standard "copy from terminal" binding on
    // every Unix terminal emulator. Avoids fighting Ctrl+C (interrupt).
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "c" }],
  },
  {
    id: "terminal.paste",
    label: "Paste into terminal",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "v" }],
  },
  {
    id: "terminal.clear",
    label: "Clear terminal viewport",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "k" }],
  },
  {
    id: "terminal.fontSizeUp",
    label: "Terminal font size +",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "=" }],
    allowRepeat: true,
  },
  {
    id: "terminal.fontSizeDown",
    label: "Terminal font size −",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "-" }],
    allowRepeat: true,
  },
  {
    id: "tab.close",
    label: "Close active tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "w" }],
  },
  {
    id: "tab.next",
    label: "Next tab (within focused pane)",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
  },
  {
    id: "tab.prev",
    label: "Previous tab (within focused pane)",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
  },
  {
    id: "tab.pin",
    label: "Pin / unpin active tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "p" }],
  },
  {
    id: "tab.duplicate",
    label: "Duplicate active tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "d" }],
  },
  {
    id: "tab.closeOthers",
    label: "Close other tabs in pane",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "w" }],
  },
  {
    id: "tab.closeToRight",
    label: "Close tabs to the right",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "w" }],
  },
  {
    id: "tab.closeAll",
    label: "Close all tabs in pane",
    group: "Tabs",
    defaultBindings: [
      { [MOD_PROP]: true, alt: true, shift: true, key: "w" },
    ],
  },
  {
    id: "tab.reopenClosed",
    label: "Reopen closed tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "t" }],
  },
  ...buildJumpToShortcuts(),
  {
    id: "tab.moveToNextPane",
    label: "Move active tab to next pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "]" }],
  },
  {
    id: "tab.moveToPrevPane",
    label: "Move active tab to previous pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "[" }],
  },
  {
    id: "pane.splitRight",
    label: "Split pane right",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "\\" }],
  },
  {
    id: "pane.splitDown",
    label: "Split pane down",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "\\" }],
  },
  {
    id: "pane.close",
    label: "Close pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "q" }],
  },
  {
    id: "pane.focusLeft",
    label: "Focus pane to the left",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowLeft" }],
  },
  {
    id: "pane.focusRight",
    label: "Focus pane to the right",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowRight" }],
  },
  {
    id: "pane.focusUp",
    label: "Focus pane above",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowUp" }],
  },
  {
    id: "pane.focusDown",
    label: "Focus pane below",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowDown" }],
  },
  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "=" },
      { [MOD_PROP]: true, shift: true, key: "+" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "-" },
      { [MOD_PROP]: true, shift: true, key: "_" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomReset",
    label: "Reset zoom",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "0" }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "Terminal",
  "ADO",
  "View",
];

/** Look up the user's first binding for a shortcut id, falling back to the
 *  first default binding. Used by UI elements (context menu, tooltips) that
 *  want to display the live keyboard hint. */
export function getPrimaryBinding(
  id: ShortcutId,
  userBindings?: Partial<Record<ShortcutId, KeyBinding[]>>,
): KeyBinding | undefined {
  const userList = userBindings?.[id];
  if (userList && userList.length > 0) return userList[0];
  const def = SHORTCUTS.find((s) => s.id === id);
  return def?.defaultBindings[0];
}

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
export function matchBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  _id?: ShortcutId,
): boolean {
  const eventKey = e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();
  if (eventKey !== bindingKey) return false;
  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
