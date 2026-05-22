/** Suppress the native webview right-click menu in production.
 *
 *  The Chromium/Edge context menu Tauri ships with shows "Inspect element",
 *  "Reload", "Save as…", "View frame source" — entries that have no business
 *  in a polished desktop app shell. We keep the menu in dev (devtools is a
 *  productivity essential) and allow any element to opt back in via the
 *  `data-allow-context-menu` attribute (CodeMirror surfaces use this so
 *  users can still copy text via the OS context menu inside the editor).
 *
 *  Install once per window from the main entry — App.tsx for the main
 *  window, settings/main.tsx for the settings window. Idempotent across
 *  hot reloads. */
export function installContextMenuGuard(): () => void {
  if (import.meta.env.DEV) return () => {};
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("[data-allow-context-menu]")) return;
    e.preventDefault();
  };
  window.addEventListener("contextmenu", handler);
  return () => window.removeEventListener("contextmenu", handler);
}
