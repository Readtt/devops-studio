// The one place a path the model emitted becomes a real file on disk.
//
// Every AI-readable path is addressed as `<repoName>/<path-within-repo>`, at
// every repo count including one — a single form means one prompt, one code
// path, and an emitted path that always round-trips back to the repo it came
// from. The user never sees the prefix; it is stripped at publish time and when
// opening the viewer.
//
// This is also the app's ONLY path containment: nothing downstream of here
// checks a boundary. `workspace.rs`'s `resolve_path` is identity, so a tool
// that skips this function can read any file the user can.

import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceRepo } from "@/modules/settings/store";
import { checkReadable } from "./security";

export type RepoPathResult =
  | {
      ok: true;
      repo: WorkspaceRepo;
      /** Real path on disk, in the repo root's own separator style. */
      absPath: string;
      /** `<repo name>/<path within repo>` — the canonical form. */
      virtualPath: string;
      /** Set when the caller's input wasn't already {@link virtualPath}, so the
       *  tool result can echo the canonical spelling back and the model stops
       *  paying for the ambiguity probe below. */
      corrected?: string;
    }
  | { ok: false; reason: string };

/** Strip whitespace and surrounding quotes off a model-supplied path argument.
 *  Models routinely write `""` to mean "no value" and wrap real paths in
 *  quotes; both used to be joined verbatim, so `subpath: '""'` became
 *  `<root>\""` and Rust answered `not a directory` — a listing the model could
 *  never get to work. Quotes are illegal in Windows filenames and vanishingly
 *  rare elsewhere, and only the ends are touched, so stripping them is safe.
 *
 *  Mirrored (deliberately, to keep that module dependency-free) by the
 *  `list_files` label in generator/lib/activityLog.ts. */
export function cleanPathArg(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/** Join under a root in the root's OWN separator, throughout — the tail is
 *  re-separated too. The model's paths arrive forward-slashed and are
 *  normalized that way, so joining them raw onto a Windows root produced
 *  `C:\repo\src/auth/x.ts`: accepted by Windows, but two spellings of one file,
 *  which is enough to make the probe below miss a path it just built. */
export function joinPath(a: string, b: string): string {
  const sep = a.includes("\\") ? "\\" : "/";
  const aTrim = a.replace(/[\\/]+$/, "");
  const bTrim = b.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep);
  return `${aTrim}${sep}${bTrim}`;
}

const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/;

/**
 * Resolve a path the model emitted against the configured repos.
 *
 * In order: absolute paths must live under exactly one configured root; a
 * leading segment naming a repo selects it; a bare path is unambiguous at one
 * repo; beyond that we probe each repo for the file and accept a single hit.
 * Anything else is refused with a reason the model can act on — a rejection is
 * returned to it as the tool result, not thrown, so it self-corrects.
 */
export async function resolveRepoPath(
  input: string,
  repos: WorkspaceRepo[],
): Promise<RepoPathResult> {
  if (repos.length === 0) {
    return { ok: false, reason: "No source repos are configured." };
  }
  const cleaned = normalizePath(input);
  if (!cleaned) return { ok: false, reason: "Refused: empty path." };

  if (ABSOLUTE.test(cleaned)) {
    for (const repo of repos) {
      const rel = relativeUnder(repo.root, cleaned);
      if (rel !== null) return settle(repo, rel, cleaned);
    }
    return {
      ok: false,
      reason: `Refused: "${input}" is outside every configured repo (${roster(repos)}). Address files as <repo>/<path within repo>.`,
    };
  }

  const cut = cleaned.indexOf("/");
  const head = cut === -1 ? cleaned : cleaned.slice(0, cut);
  const named = repos.find((r) => r.name.toLowerCase() === head.toLowerCase());
  if (named) return settle(named, cut === -1 ? "" : cleaned.slice(cut + 1), cleaned);

  // A forgotten prefix is unambiguous when there is only one repo to mean.
  if (repos.length === 1) return settle(repos[0], cleaned, cleaned);

  const hits = (
    await Promise.all(
      repos.map(async (repo) =>
        (await exists(joinPath(repo.root, cleaned))) ? repo : null,
      ),
    )
  ).filter((r): r is WorkspaceRepo => r !== null);

  if (hits.length === 1) return settle(hits[0], cleaned, cleaned);
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `No configured repo contains "${cleaned}". Prefix the path with the repo it lives in — one of: ${roster(repos)}.`,
    };
  }
  return {
    ok: false,
    reason: `"${cleaned}" exists in more than one repo (${hits.map((r) => r.name).join(", ")}). Prefix it with the one you mean, e.g. "${hits[0].name}/${cleaned}".`,
  };
}

/** Which repo a canonical `<repo>/<path>` names, and what follows the prefix.
 *  The synchronous counterpart to {@link resolveRepoPath}, for callers that
 *  need the repo BINDING rather than the file — publish stamps a link with its
 *  repo's own branch and sha, and never touches the disk to do it.
 *
 *  A missing prefix is tolerated at one repo, matching the resolver's rule, so
 *  the same paths resolve the same way in both. */
export function splitRepoPath(
  input: string,
  repos: WorkspaceRepo[],
): { repo: WorkspaceRepo; within: string } | null {
  const cleaned = normalizePath(input);
  if (!cleaned || repos.length === 0) return null;
  const cut = cleaned.indexOf("/");
  const head = cut === -1 ? cleaned : cleaned.slice(0, cut);
  const named = repos.find((r) => r.name.toLowerCase() === head.toLowerCase());
  if (named) {
    return { repo: named, within: cut === -1 ? "" : cleaned.slice(cut + 1) };
  }
  return repos.length === 1 ? { repo: repos[0], within: cleaned } : null;
}

/** Apply the containment gates and build the result. `given` is the normalized
 *  input, used only to decide whether the model needs correcting. */
function settle(
  repo: WorkspaceRepo,
  rel: string,
  given: string,
): RepoPathResult {
  const within = normalizeRelative(rel);
  if (within === null) {
    return {
      ok: false,
      reason: `Refused: "${given}" points outside ${repo.name}.`,
    };
  }
  const absPath = within ? joinPath(repo.root, within) : repo.root;
  const gate = checkReadable(absPath);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const virtualPath = within ? `${repo.name}/${within}` : repo.name;
  return {
    ok: true,
    repo,
    absPath,
    virtualPath,
    ...(given === virtualPath ? {} : { corrected: virtualPath }),
  };
}

/** Forward slashes, no `./` lead, no trailing separator, no doubled separators
 *  — except a leading `//`, which is a UNC share and not noise. */
function normalizePath(raw: string): string {
  const slashed = cleanPathArg(raw)
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
  const collapsed = slashed.replace(/\/{2,}/g, "/");
  const s = slashed.startsWith("//") ? `/${collapsed}` : collapsed;
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/** Resolve `.` / `..` inside a repo-relative path. Returns null when the path
 *  climbs above the repo root — the traversal gate. */
function normalizeRelative(rel: string): string | null {
  const out: string[] = [];
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** The part of `abs` below `root`, or null when it isn't under it. Matching is
 *  separator- and case-insensitive, like the registry's own dedup key: a path
 *  that round-trips through a tool result or an event payload comes back in
 *  whichever spelling that layer preferred. */
function relativeUnder(root: string, abs: string): string | null {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const a = abs.toLowerCase();
  if (a === r) return "";
  if (a.startsWith(`${r}/`)) return abs.slice(r.length + 1);
  return null;
}

/** fs_stat REJECTS on a missing path rather than returning null, so a probe
 *  that doesn't catch takes the whole resolution down with it. */
async function exists(path: string): Promise<boolean> {
  return invoke("fs_stat", { path }).then(
    () => true,
    () => false,
  );
}

function roster(repos: WorkspaceRepo[]): string {
  return repos.map((r) => r.name).join(", ");
}

/** The repo list as a prompt block: a flat, unannotated roster of names and
 *  paths. Shared by every surface so the text can't drift between them.
 *
 *  Deliberately says nothing about what a repo is for or how it relates to the
 *  others. There is no role concept in the model, and inventing one in prose
 *  would bias the model toward a topology the user may not have — it discovers
 *  the relationships by reading, which is what the tools are for. */
export function renderRepoRoster(repos: WorkspaceRepo[]): string {
  return repos.map((r) => `- ${r.name}: ${r.root}`).join("\n");
}

/** The addressing rule, stated once for every surface that reads code. Without
 *  it the model emits bare paths and leans on `resolveRepoPath`'s ambiguity
 *  probe, which costs a correction round-trip per path it guesses at.
 *
 *  Deliberately short: it rides on every request of every AI surface, so it is
 *  permanent token cost. The tool descriptions carry the per-argument detail
 *  (which is where a model looks when it is about to call one); this is only
 *  the shape of a path and the one thing that is NOT a path — a `run_command`
 *  repo. */
export const REPO_PATH_RULE = `PATHS ARE REPO-PREFIXED
- Every path you read or emit is \`<repo>/<path within repo>\` — e.g. \`repo-one/src/services/handler.ts\`. The first segment is always one of the configured repo names; a bare path is ambiguous once more than one repo is configured, and an absolute path is refused.
- \`run_command\` runs inside ONE repo — pass \`repo\`, and remember that \`git log\` there cannot see another repo.
- The repos may relate to each other in any way, or not at all. Don't assume — read them.`;
