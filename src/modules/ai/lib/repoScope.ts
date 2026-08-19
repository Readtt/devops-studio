// Per-run narrowing of the repo registry.
//
// A scope is a list of repo ids, or `null` for "every configured repo". Null is
// the default and is NOT the same as listing them all: the registry changes
// under a session (a repo added in Settings mid-draft), and only null means
// "whatever is configured when the run starts". Narrowing is always the user's
// explicit act — the app can't know which repos a given spec touches.

import type { WorkspaceRepo } from "@/modules/settings/store";

/** The repos a run may read, in registry order. Ids that no longer name a
 *  configured repo simply drop out, so a scope outlives a repo being removed. */
export function scopedRepos(
  repos: WorkspaceRepo[],
  scope: string[] | null,
): WorkspaceRepo[] {
  if (scope === null) return repos;
  const wanted = new Set(scope);
  return repos.filter((r) => wanted.has(r.id));
}

export function isRepoInScope(scope: string[] | null, repoId: string): boolean {
  return scope === null || scope.includes(repoId);
}

/** Flip one repo's membership.
 *
 *  Collapses back to `null` the moment every configured repo is selected, so
 *  "all on" has exactly one representation — otherwise a scope frozen at
 *  today's ids would quietly exclude a repo the user adds tomorrow. */
export function toggleRepoScope(
  scope: string[] | null,
  repos: WorkspaceRepo[],
  repoId: string,
): string[] | null {
  const ids = repos.map((r) => r.id);
  // A chip rendered from a snapshot the registry has moved past can name a repo
  // that is no longer configured. Adding it would push `next` up to `ids.length`
  // and collapse the scope to null — silently re-including every repo the user
  // deselected.
  if (!ids.includes(repoId)) return scope;
  const current = scope === null ? ids : scope.filter((id) => ids.includes(id));
  const next = current.includes(repoId)
    ? current.filter((id) => id !== repoId)
    : [...current, repoId];
  return next.length === ids.length ? null : next;
}
