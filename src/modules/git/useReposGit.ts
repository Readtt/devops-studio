import { useEffect, useMemo, useState } from "react";

import { usePreferencesStore, usePrimaryRepoRoot } from "@/modules/settings/preferences";
import type { WorkspaceRepo } from "@/modules/settings/store";
import {
  EMPTY_REPO_INFO,
  EMPTY_STATUS,
  gitRepoInfo,
  gitStatusSummary,
  type GitRepoInfo,
  type GitStatusSummary,
} from "./gitOps";
import { subscribeRootPoll } from "./repoPollRegistry";

/**
 * Subscribe to the shared poll for `read` over `roots`.
 *
 * The poll itself lives in `repoPollRegistry` — outside React, shared by every
 * mounted consumer — because each read is a git subprocess per repo and this
 * hook has many simultaneous callers. `read` and `empty` must be module-level
 * constants: `read` is the channel's identity, and both are effect deps.
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
    const { values, unsubscribe } = subscribeRootPoll(read, empty, list, setByRoot);
    // Adopt whatever the channel already knows, so a remounted pane paints the
    // last known branch instead of flashing a skeleton.
    setByRoot(values);
    return unsubscribe;
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
