import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { usePreferencesStore } from "@/modules/settings/preferences";

export type GitRepoInfo = {
  branch: string | null;
  commit: string | null;
  isRepo: boolean;
  detached: boolean;
};

const EMPTY: GitRepoInfo = {
  branch: null,
  commit: null,
  isRepo: false,
  detached: false,
};

const REFRESH_MS = 30_000;

/**
 * Track the current git branch + short SHA of the user's selected source
 * directory. Refreshes on a 30 s timer and whenever the window regains
 * focus, so switching branches in a terminal shows up without the user
 * having to do anything.
 */
export function useSourceDirGitInfo(): GitRepoInfo {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const [info, setInfo] = useState<GitRepoInfo>(EMPTY);

  useEffect(() => {
    if (!sourceRoot) {
      setInfo(EMPTY);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await invoke<GitRepoInfo>("git_repo_info", { path: sourceRoot });
        if (!cancelled) setInfo(next ?? EMPTY);
      } catch {
        if (!cancelled) setInfo(EMPTY);
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);

    // Refresh on focus so branch switches in an external terminal surface
    // immediately the next time the user touches the app.
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

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (unlistenFocus) unlistenFocus();
    };
  }, [sourceRoot]);

  return info;
}
