/**
 * Binding a workspace repo to the Azure DevOps repository it was cloned from.
 *
 * Published code links deep-link into ADO Repos, which needs the ADO repo NAME
 * and its owning PROJECT — and the project is not necessarily the connection's
 * one: `ado_list_repos` is org-wide, so a workspace can hold repos from several
 * projects. Guessing either half produces a link that 404s, so a repo we can't
 * identify is left unbound rather than bound to something plausible.
 *
 * Matching is deliberately tiered, cheapest and most certain first:
 *   1. the local `origin` URL equals the ADO repo's clone URL (normalised),
 *   2. both URLs name the same project + repo (catches SSH and the legacy
 *      `visualstudio.com` form, which never string-match the HTTPS one),
 *   3. exactly one ADO repo in the org is named like the local folder.
 * Anything else stays unbound; the Settings row's picker is the manual override.
 */
import { gitRemoteUrl } from "@/modules/git/gitOps";
import {
  setRepoAdo,
  repoBasename,
  type WorkspaceRepo,
} from "@/modules/settings/store";

import { listRepos, toAdoError } from "./native";
import type { RepoRef } from "./types";

export type AdoBinding = NonNullable<WorkspaceRepo["ado"]>;

/**
 * A remote URL reduced to what identifies the repository: no scheme, no
 * `user:pass@`, no trailing `.git`, lower-cased, percent-escapes resolved.
 *
 * `https://org@dev.azure.com/org/My%20Project/_git/repo.git` and
 * `https://dev.azure.com/org/My Project/_git/repo` both come out as
 * `dev.azure.com/org/my project/_git/repo`. ADO hands out the userinfo form as
 * the clone URL while its own API reports the bare one, which is exactly the
 * pair that has to compare equal.
 */
export function normalizeRemoteUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  if (scheme.test(s)) {
    s = s.replace(scheme, "");
  } else {
    // scp-style `git@host:path`, which git accepts and no URL parser does.
    s = s.replace(/^([^/]+):(?!\/)/, "$1/");
  }
  s = s.replace(/^[^/]*@/, "");
  s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // A stray `%` isn't an error here — compare the raw form instead.
  }
  const out = s.toLowerCase().trim();
  return out || null;
}

/** The `{project, repo}` an ADO remote names, in any of the shapes ADO hands
 *  out: `…/{project}/_git/{repo}` (dev.azure.com, visualstudio.com, on-prem
 *  collections) and `…/v3/{org}/{project}/{repo}` (SSH). Null for a remote that
 *  isn't ADO's — GitHub, a bare path, an unrecognised host. */
export function parseAdoRemote(
  raw: string | null | undefined,
): { project: string; repo: string } | null {
  const normalized = normalizeRemoteUrl(raw);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  const git = parts.indexOf("_git");
  if (git > 0 && git + 1 < parts.length) {
    return { project: parts[git - 1], repo: parts[git + 1] };
  }
  // SSH: {host}/v3/{org}/{project}/{repo}
  const v3 = parts.indexOf("v3");
  if (v3 >= 0 && v3 + 3 < parts.length) {
    const [, project, repo] = parts.slice(v3 + 1);
    if (project && repo) return { project, repo };
  }
  return null;
}

/** The project an ADO repo belongs to — the API's own field, falling back to
 *  the one its clone URL names (the field is optional on the schema). */
function projectOf(ref: RepoRef): string | null {
  const named = ref.project?.trim();
  if (named) return named;
  return parseAdoRemote(ref.remoteUrl)?.project ?? null;
}

/** A binding is only usable if we know the project — the deep link is
 *  `{org}/{project}/_git/{repo}`, so a blank project builds a dead URL. Shared
 *  with the manual picker so a hand-picked repo is recorded exactly like a
 *  detected one. */
export function bindingForAdoRepo(ref: RepoRef): AdoBinding | null {
  const project = projectOf(ref);
  if (!project) return null;
  return { repoId: ref.id, repoName: ref.name, project };
}

/**
 * The ADO repo this local repo was cloned from, or null when nothing matches
 * with enough certainty to be worth writing down.
 *
 * The basename tier requires a UNIQUE name match: repo names repeat across
 * projects, and picking one of several would bind the wrong project — which is
 * the failure this whole phase exists to remove.
 */
export function matchAdoRepo(
  local: { remoteUrl: string | null; basename: string },
  adoRepos: RepoRef[],
): RepoRef | null {
  const remote = normalizeRemoteUrl(local.remoteUrl);
  if (remote) {
    const exact = adoRepos.find((r) => normalizeRemoteUrl(r.remoteUrl) === remote);
    if (exact) return exact;

    const id = parseAdoRemote(local.remoteUrl);
    if (id) {
      const sameRepo = adoRepos.filter((r) => {
        const project = projectOf(r);
        return (
          r.name.toLowerCase() === id.repo &&
          project != null &&
          project.toLowerCase() === id.project
        );
      });
      if (sameRepo.length === 1) return sameRepo[0];
      // The remote says outright which ADO repository this is, and it isn't
      // one we can see. Falling through to the basename tier would bind it to
      // a same-named repo in a DIFFERENT project — a deep link that resolves
      // to a real page showing an unrelated repository's file, so nothing
      // 404s to signal the mistake.
      return null;
    }
  }

  const base = local.basename.trim().toLowerCase();
  if (!base) return null;
  const named = adoRepos.filter((r) => r.name.trim().toLowerCase() === base);
  return named.length === 1 ? named[0] : null;
}

export type BindOutcome =
  /** Matched and written to the registry. */
  | { status: "bound"; ado: AdoBinding }
  /** Nothing in the org matched with enough certainty. */
  | { status: "no-match" }
  /** No ADO connection, or the org-wide repo list couldn't be read. */
  | { status: "unavailable"; message: string };

/** Resolve and persist one repo's binding. `adoRepos` lets a sweep share a
 *  single org-wide fetch across N repos. */
export async function bindRepo(
  repo: WorkspaceRepo,
  adoRepos?: RepoRef[],
  /** Remote already read by a sweep, so a batch doesn't pay one serialized git
   *  round-trip per repo before any binding is written. */
  remoteUrl?: string | null,
): Promise<BindOutcome> {
  let repos = adoRepos;
  if (!repos) {
    try {
      repos = await listRepos();
    } catch (e) {
      return { status: "unavailable", message: adoUnavailableMessage(e) };
    }
  }
  // A folder that isn't a repo (or has moved) simply has no remote — it can
  // still bind by name.
  const remote =
    remoteUrl !== undefined
      ? remoteUrl
      : await gitRemoteUrl(repo.root).catch(() => null);
  const match = matchAdoRepo(
    { remoteUrl: remote, basename: repoBasename(repo.root) },
    repos,
  );
  const ado = match ? bindingForAdoRepo(match) : null;
  if (!ado) return { status: "no-match" };
  await setRepoAdo(repo.id, ado);
  return { status: "bound", ado };
}

/**
 * Bind every repo in `repos` that has no binding yet, best-effort and silent:
 * this runs as a side effect of adding a folder, and a workspace repo with no
 * ADO counterpart is a normal state, not an error.
 *
 * Writes are sequential because `setRepoAdo` is read-modify-write against the
 * shared registry — racing them would drop all but the last.
 */
export async function autoBindRepos(repos: WorkspaceRepo[]): Promise<void> {
  const unbound = repos.filter((r) => !r.ado);
  if (unbound.length === 0) return;
  let adoRepos: RepoRef[];
  try {
    adoRepos = await listRepos();
  } catch {
    return;
  }
  if (adoRepos.length === 0) return;
  // Remotes first, in parallel: only the WRITE has to be serialized, and each
  // repo's git read is independent — a scan-add of twenty folders otherwise
  // spends twenty serialized round-trips before the first binding lands.
  const remotes = await Promise.all(
    unbound.map((r) => gitRemoteUrl(r.root).catch(() => null)),
  );
  for (const [i, repo] of unbound.entries()) {
    await bindRepo(repo, adoRepos, remotes[i]).catch(() => undefined);
  }
}

function adoUnavailableMessage(e: unknown): string {
  const err = toAdoError(e);
  return err.kind === "not-configured"
    ? "Connect Azure DevOps to link repos."
    : "Couldn't read the repository list from Azure DevOps.";
}
