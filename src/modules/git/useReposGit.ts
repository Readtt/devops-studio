import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";

import { usePreferencesStore, usePrimaryRepoRoot } from "@/modules/settings/preferences";
import { sameRoot, type WorkspaceRepo } from "@/modules/settings/store";
import {
  EMPTY_REPO_INFO,
  EMPTY_STATUS,
  gitRepoInfo,
  gitStatusSummary,
  onSourceGitChanged,
  type GitRepoInfo,
  type GitStatusSummary,
} from "./gitOps";

const REFRESH_MS = 30_000;

/**
 * Poll `read` for every root in `roots`, keyed by root.
 *
 * Same cadence the single-root readers always had: every 30 s, on window focus,
 * and the moment an in-app git action lands. A change event that names a root
 * refreshes only that repo; one that names none refreshes all of them.
 *
 * `read` and `empty` must be module-level constants — they're effect deps, so an
 * inline arrow would restart the poll on every render.
 */
function useRootPoll<T>(
  roots: string[],
  read: (root: string) => Promise<T>,
  empty: T,
): Map<string, T> {
  const [byRoot, setByRoot] = useState<Map<string, T>>(() => new Map());
  // The array identity changes every render; its contents don't.
  const key = JSON.stringify(roots);

  useEffect(() => {
    const list = JSON.parse(key) as string[];
    if (list.length === 0) {
      setByRoot(new Map());
      return;
    }

    let cancelled = false;
    const refresh = async (only?: string) => {
      const targets = only ? list.filter((r) => sameRoot(r, only)) : list;
      if (targets.length === 0) return;
      const results = await Promise.all(
        targets.map((root) =>
          read(root)
            .then((v) => v ?? empty)
            .catch(() => empty),
        ),
      );
      if (cancelled) return;
      setByRoot((prev) => {
        const next = new Map(prev);
        targets.forEach((root, i) => next.set(root, results[i]));
        // Drop repos that left the registry while their read was in flight.
        for (const root of next.keys()) {
          if (!list.includes(root)) next.delete(root);
        }
        return next;
      });
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);

    // Focus catches branch switches made in an external terminal.
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

    const unlistenGit = onSourceGitChanged((root) => void refresh(root));

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (unlistenFocus) unlistenFocus();
      unlistenGit();
    };
  }, [key, read, empty]);

  return byRoot;
}

/** Re-key a by-root map onto repo ids, which is what callers hold. */
function byRepoId<T>(repos: WorkspaceRepo[], byRoot: Map<string, T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const repo of repos) {
    const value = byRoot.get(repo.root);
    if (value !== undefined) out.set(repo.id, value);
  }
  return out;
}

/** Branch + short SHA of every configured repo. A repo missing from the map
 *  hasn't been read yet — render a skeleton rather than a wrong answer. */
export function useReposGitInfo(): Map<string, GitRepoInfo> {
  const repos = usePreferencesStore((s) => s.repos);
  const byRoot = useRootPoll(
    repos.map((r) => r.root),
    gitRepoInfo,
    EMPTY_REPO_INFO,
  );
  return useMemo(() => byRepoId(repos, byRoot), [repos, byRoot]);
}

/** The richer working-tree summary the branch switcher needs — dirty state,
 *  ahead/behind, upstream, parked stash — for every configured repo. */
export function useReposStatus(): Map<string, GitStatusSummary> {
  const repos = usePreferencesStore((s) => s.repos);
  const byRoot = useRootPoll(
    repos.map((r) => r.root),
    gitStatusSummary,
    EMPTY_STATUS,
  );
  return useMemo(() => byRepoId(repos, byRoot), [repos, byRoot]);
}

/** The one repo the surfaces that still read a single root care about. Scoped
 *  to that root, so a surface needing one repo doesn't poll all of them. */
export function usePrimaryRepoGitInfo(): GitRepoInfo {
  const root = usePrimaryRepoRoot();
  const byRoot = useRootPoll(
    useMemo(() => (root ? [root] : []), [root]),
    gitRepoInfo,
    EMPTY_REPO_INFO,
  );
  return (root ? byRoot.get(root) : undefined) ?? EMPTY_REPO_INFO;
}
