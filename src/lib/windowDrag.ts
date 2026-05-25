import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Window-drag handling for our custom title bars.
 *
 * We intentionally do NOT use Tauri's `data-tauri-drag-region` attribute.
 * That attribute calls `startDragging()` on *mousedown* — and on Windows a
 * plain click (press + release with no movement) drops the window into the
 * native move-loop (`WM_NCLBUTTONDOWN`). The webview never sees the matching
 * mouseup, so the window "sticks" to the cursor and keeps moving until the
 * next click. That's the "click the top bar and it auto-drags" bug.
 *
 * Fix: start the OS drag only after the pointer has actually moved a few
 * pixels while the button is held. A press that never crosses the threshold
 * stays a click and the window doesn't move. Real drags (where the user is
 * holding and moving) hit the normal `startDragging()` path, which ends
 * correctly on button release because a move is genuinely in progress.
 */

// Pixels the pointer must travel while held before we treat it as a drag.
// Small enough to feel instant, large enough to never fire on a click.
const DRAG_THRESHOLD_PX = 4;

function beginDrag(e: ReactPointerEvent<HTMLElement>) {
  // Primary button only, and only when the press landed on the drag surface
  // itself — buttons that live in the title bar bubble their events up to it,
  // and we must not hijack their clicks into a window drag.
  if (e.button !== 0 || e.target !== e.currentTarget) return;

  const startX = e.screenX;
  const startY = e.screenY;
  let dragStarted = false;

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", cleanup, true);
    window.removeEventListener("pointercancel", cleanup, true);
  };

  const onMove = (ev: PointerEvent) => {
    if (dragStarted) return;
    const moved = Math.abs(ev.screenX - startX) + Math.abs(ev.screenY - startY);
    if (moved < DRAG_THRESHOLD_PX) return;
    // Crossed the threshold → hand off to the OS. Tear down our listeners
    // first: once the native move-loop owns the pointer the webview stops
    // getting events anyway, and this keeps the handoff single-shot.
    dragStarted = true;
    cleanup();
    void getCurrentWindow().startDragging();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", cleanup, true);
  window.addEventListener("pointercancel", cleanup, true);
}

function toggleMaximize(e: ReactMouseEvent<HTMLElement>) {
  if (e.target !== e.currentTarget) return;
  void getCurrentWindow().toggleMaximize();
}

/**
 * Spread onto a title-bar element to make it a window-drag handle.
 * Double-click toggles maximize, so use this only on resizable windows.
 */
export const windowDragProps = {
  onPointerDown: beginDrag,
  onDoubleClick: toggleMaximize,
} as const;

/**
 * Drag handle without double-click maximize — for fixed-size windows
 * (e.g. Settings) where maximizing makes no sense.
 */
export const windowDragPropsFixed = {
  onPointerDown: beginDrag,
} as const;
