import { useCallback, useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setZoomLevel } from "@/modules/settings/store";

const ZOOM_STEP = 0.1;
// 80% is the lower bound where the app's 11-12 px UI density still
// reflows cleanly — anything tighter and the test-plan tree / generator
// review grid start clipping. Upper bound is generous for accessibility.
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 2.0;

function clampZoom(z: number): number {
  const rounded = Math.round(z * 100) / 100;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rounded));
}

/**
 * Apply the user's preferred zoom via Tauri's native webview API. This is
 * the same mechanism as Ctrl+Plus in a browser — Chromium handles reflow
 * cleanly, so layout, drag regions, Radix portals, and absolute positioning
 * all behave correctly. The CSS-based `zoom: var(--app-zoom)` approach we
 * had before broke Tauri drag regions and Radix Tooltip positioning.
 */
async function applyToWebview(z: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(z);
  } catch (e) {
    // Webview commands can fail during early init or if the permission
    // hasn't been granted. Don't crash the whole UI — log and move on.
    console.warn("setZoom failed:", e);
  }
}

export type UseZoomOptions = {
  /** When false, the hook only exposes the in/out/reset callbacks and
   *  never calls setZoom on the current webview. Use this in the
   *  Settings window so adjusting the slider doesn't rescale Settings
   *  itself (which makes the slider jump under the cursor). */
  apply?: boolean;
};

export function useZoom(options?: UseZoomOptions) {
  const apply = options?.apply ?? true;
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const lastAppliedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!apply) return;
    if (!hydrated) return;
    const next = clampZoom(zoomLevel);
    if (lastAppliedRef.current === next) return;
    lastAppliedRef.current = next;
    void applyToWebview(next);
    // If the persisted value was outside the current bounds (e.g. an old
    // 0.5 saved before we tightened the minimum), rewrite it so the
    // slider position and the actual zoom stay in sync.
    if (next !== zoomLevel) void setZoomLevel(next);
  }, [apply, hydrated, zoomLevel]);

  const zoomIn = useCallback(() => {
    const current = usePreferencesStore.getState().zoomLevel;
    const next = clampZoom(current + ZOOM_STEP);
    if (next !== current) void setZoomLevel(next);
  }, []);

  const zoomOut = useCallback(() => {
    const current = usePreferencesStore.getState().zoomLevel;
    const next = clampZoom(current - ZOOM_STEP);
    if (next !== current) void setZoomLevel(next);
  }, []);

  const zoomReset = useCallback(() => {
    if (usePreferencesStore.getState().zoomLevel !== 1.0) {
      void setZoomLevel(1.0);
    }
  }, []);

  return { zoomIn, zoomOut, zoomReset };
}
