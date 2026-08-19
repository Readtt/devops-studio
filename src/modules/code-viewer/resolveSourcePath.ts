// Shared resolver for paths the analyst / bug pipeline hands the code viewer.
//
// Paths the model emits are `<repo>/<path within repo>`; paths parsed off older
// work items are bare and relative to whatever the single source dir was then.
// The Rust `fs_read_file` handler takes whatever it receives literally, so we
// absolutize on the frontend before dispatching the open-code-viewer event.
//
// Repo binding runs through `resolveRepoPath` — the app's one containment point
// — so a link that climbs out of a repo (a bug's code links are third-party
// data: anyone on the ADO project can edit them) is refused here rather than
// opened. What this file adds on top is the FUZZY half: a citation abbreviated
// to a bare filename still has to find its file, and past one repo it has to
// find the right repo's copy of it.

import { invoke } from "@tauri-apps/api/core";
import {
  joinPath,
  relativeUnder,
  resolveRepoPath,
  splitRepoPath,
} from "@/modules/ai/lib/repoPaths";
import { checkReadable } from "@/modules/ai/lib/security";
import type { WorkspaceRepo } from "@/modules/settings/store";

const ABS_POSIX = /^\//;
const ABS_WIN = /^[a-zA-Z]:[\\/]/;

/** A file on disk plus the repo it belongs to. `repo` is null when the path
 *  couldn't be attributed — an absolute path outside every configured repo, or
 *  a bare path nothing claimed. The viewer still opens it; it just can't label
 *  it. */
export type ResolvedSource = { path: string; repo: WorkspaceRepo | null };

/** Returns true when the path is already an absolute filesystem path. */
export function isAbsolutePath(p: string): boolean {
  return ABS_POSIX.test(p) || ABS_WIN.test(p);
}

/** Which separator a path "wants": backslash for Windows-style paths (drive
 *  letter or any backslash present), forward slash otherwise. */
function dominantSeparator(p: string): "\\" | "/" {
  return /\\/.test(p) || /^[a-zA-Z]:/.test(p) ? "\\" : "/";
}

/** Collapse every run of either separator into a single canonical one, so a
 *  joined path never ends up mixed like `C:\repo/sub/file.cs`. Leaves a POSIX
 *  root (`/…`) on forward slashes; a Windows root on backslashes. */
export function normalizeSeparators(p: string): string {
  if (!p) return p;
  return p.replace(/[\\/]+/g, dominantSeparator(p));
}

/** Display form for a resolved path: same canonical separators we resolve to,
 *  so what the user sees matches what's opened (and dedup keys line up). */
export function displaySourcePath(p: string): string {
  return normalizeSeparators(p);
}

/** The `<repo>/<path within repo>` form of an absolute path, for display. Falls
 *  back to the absolute path when the repo can't be matched — better a long
 *  path than a wrong prefix. */
export function virtualSourcePath(
  repos: WorkspaceRepo[],
  absPath: string,
): string {
  const owner = repoOwning(repos, absPath);
  if (!owner) return displaySourcePath(absPath);
  const within = relativeUnder(owner.root, absPath);
  return within ? `${owner.name}/${within}` : owner.name;
}

/** Bind a path to a repo and absolutize it WITHOUT touching the disk: an
 *  explicit `<repo>/…` prefix, an absolute path already under a repo, or — at
 *  exactly one configured repo — a bare path, matching the resolver's own
 *  tolerance. Returns null when nothing can be decided, which past one repo is
 *  the honest answer for a bare path: {@link resolveSourcePathDeep} is what
 *  goes and looks. */
export function resolveSourcePath(
  repos: WorkspaceRepo[],
  file: string,
): ResolvedSource | null {
  if (!file) return null;
  if (isAbsolutePath(file)) {
    const abs = normalizeSeparators(file);
    return readable(abs) ? { path: abs, repo: repoOwning(repos, abs) } : null;
  }
  const split = splitRepoPath(file, repos);
  if (!split) return null;
  const abs = normalizeSeparators(joinPath(split.repo.root, split.within));
  return readable(abs) ? { path: abs, repo: split.repo } : null;
}

/** Like {@link resolveSourcePath}, but verifies the file actually exists and,
 *  when a naive join would 404, asks the backend to find the real location by
 *  path-suffix / basename match. This is what makes a citation like a bare
 *  "ReportDeltaProcess.cs" (the file actually lives in a subdirectory) open
 *  correctly instead of failing with "file not found".
 *
 *  Past one repo the fuzzy search fans across every repo, because a bare
 *  filename says nothing about which one holds it — searching only the first
 *  is how a citation used to open a same-named file from the wrong repo. An
 *  explicit repo prefix always wins over the fan-out, and a fan-out that hits
 *  in several repos takes the first in registry order: the guess is unavoidable
 *  at that point, but the viewer names the repo it landed in, so a wrong guess
 *  is visible instead of silent.
 *
 *  Falls back to the naive join on any error, so the viewer still has a path to
 *  show in its not-found hint. */
export async function resolveSourcePathDeep(
  repos: WorkspaceRepo[],
  file: string,
): Promise<ResolvedSource | null> {
  if (!file) return null;
  const bound = await resolveRepoPath(file, repos);
  if (bound.ok) {
    const within = bound.virtualPath.slice(bound.repo.name.length + 1);
    const abs = normalizeSeparators(bound.absPath);
    if (!within) return { path: abs, repo: bound.repo };
    const found = await findInRepo(bound.repo, within);
    return { path: found ?? abs, repo: bound.repo };
  }

  // Unclaimed: a bare path past one repo, or one whose prefix names nothing.
  // Both are worth a fuzzy look — the model abbreviates, and pre-multi-repo
  // work items carry bare paths that predate any prefix at all.
  if (isAbsolutePath(file)) {
    const abs = normalizeSeparators(file);
    return readable(abs) ? { path: abs, repo: repoOwning(repos, abs) } : null;
  }
  const needle = splitRepoPath(file, repos)?.within ?? file;
  // A path that climbs out of a repo is refused, never searched: joined under a
  // root on the Rust side it would resolve to a real file OUTSIDE it, which is
  // the containment `resolveRepoPath` just turned this input down for.
  if (!needle || needle.split(/[\\/]/).includes("..")) return null;
  // Fanned out, not walked one repo at a time: `fs_resolve_source_path` walks
  // the tree on a miss, and this runs on the click path with nothing on screen
  // to say so — serialized, an unresolvable citation costs the SUM of every
  // repo's walk. Taking the first non-null keeps registry order, which is the
  // tie-break this function documents.
  const found = await Promise.all(repos.map((repo) => findInRepo(repo, needle)));
  const hit = found.findIndex((p) => p !== null);
  if (hit !== -1) return { path: found[hit] as string, repo: repos[hit] };
  return resolveSourcePath(repos, file);
}

/** One repo's fuzzy lookup. `fs_resolve_source_path` returns null when nothing
 *  plausibly matches, and rejects only when the backend itself is unavailable
 *  — either way this repo simply doesn't answer. The hit runs the same read
 *  gate as everything else: a fuzzy walk that lands on `.env` must not be a way
 *  around it. */
async function findInRepo(
  repo: WorkspaceRepo,
  path: string,
): Promise<string | null> {
  try {
    const found = await invoke<string | null>("fs_resolve_source_path", {
      root: repo.root,
      path,
    });
    if (!found) return null;
    const abs = normalizeSeparators(found);
    return readable(abs) ? abs : null;
  } catch {
    return null;
  }
}

function readable(absPath: string): boolean {
  return checkReadable(absPath).ok;
}

/** The repo an absolute path lives under, matched separator- and
 *  case-insensitively like the registry's own dedup key. */
function repoOwning(
  repos: WorkspaceRepo[],
  absPath: string,
): WorkspaceRepo | null {
  return repos.find((r) => relativeUnder(r.root, absPath) !== null) ?? null;
}
