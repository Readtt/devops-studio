import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EMPTY_STATUS,
  SOURCE_GIT_CHANGED_EVENT,
  gitStatusSummary,
  type GitStatusSummary,
} from "./gitOps";

const REFRESH_MS = 30_000;

/**
 * Like {@link useSourceDirGitInfo} but the richer working-tree summary the
 * status-bar branch switcher needs: dirty state, ahead/behind, and upstream.
 * Polls every 30 s, on window focus, and immediately after an in-app switch /
 * pull (the `source-git-changed` event).
 */
export function useSourceDirStatus(): GitStatusSummary {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const [status, setStatus] = useState<GitStatusSummary>(EMPTY_STATUS);

  useEffect(() => {
    if (!sourceRoot) {
      setStatus(EMPTY_STATUS);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await gitStatusSummary(sourceRoot);
        if (!cancelled) setStatus(next ?? EMPTY_STATUS);
      } catch {
        if (!cancelled) setStatus(EMPTY_STATUS);
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);

    let unlistenFocus: (() => void) | null = null;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void refresh();
      })
      .then((un) => {
        if (cancelled) un();
        else unlistenFocus = un;
      })
      .catch(() => {});

    const onChanged = () => void refresh();
    window.addEventListener(SOURCE_GIT_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (unlistenFocus) unlistenFocus();
      window.removeEventListener(SOURCE_GIT_CHANGED_EVENT, onChanged);
    };
  }, [sourceRoot]);

  return status;
}
