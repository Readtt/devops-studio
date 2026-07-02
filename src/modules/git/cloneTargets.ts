// Folder-name resolution for the "Get source code" clone flow. Pure + tested so
// the wizard's preview and the actual clone always agree on the destination
// folder (a mismatch would clone into / adopt a different path than shown).

/** A folder name safe to append to a destination parent: trims, and replaces the
 *  characters that are illegal or path-significant on Windows/macOS/Linux. */
export function sanitizeDir(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "");
}

export type CloneTargetInput = {
  id: string;
  name: string;
  project?: string | null;
};

export type CloneTarget = {
  id: string;
  /** Display name (the repo name), for the preview list. */
  name: string;
  /** The collision-free subfolder to clone into, under the shared parent. */
  folder: string;
};

/**
 * Resolve each selected repo to a unique subfolder under one parent. Repos can
 * share a name across ADO projects, and Windows/macOS filesystems are
 * case-insensitive, so we dedupe case-insensitively: the first repo keeps the
 * plain name, a clash appends the sanitized project (`web` → `web-Platform`),
 * and anything still colliding falls back to a numeric suffix (`web-2`). Order
 * is preserved so the preview reads in selection order.
 */
export function resolveCloneTargets(repos: CloneTargetInput[]): CloneTarget[] {
  const used = new Set<string>();
  const take = (candidate: string): string => {
    used.add(candidate.toLowerCase());
    return candidate;
  };

  return repos.map((repo) => {
    const base = sanitizeDir(repo.name) || "repo";
    if (!used.has(base.toLowerCase())) {
      return { id: repo.id, name: repo.name, folder: take(base) };
    }
    // First tiebreaker: the owning project, which is what actually distinguishes
    // same-named repos in a cross-project org list.
    const proj = sanitizeDir(repo.project ?? "");
    const withProject = proj ? `${base}-${proj}` : base;
    if (proj && !used.has(withProject.toLowerCase())) {
      return { id: repo.id, name: repo.name, folder: take(withProject) };
    }
    // Last resort: numeric suffix off whichever base we settled on.
    const stem = proj ? withProject : base;
    let n = 2;
    let candidate = `${stem}-${n}`;
    while (used.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${stem}-${n}`;
    }
    return { id: repo.id, name: repo.name, folder: take(candidate) };
  });
}
