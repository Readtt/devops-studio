// Sub-agent isolation for the verify stage: give it a window scoped to what it
// is actually judging instead of re-inlining the whole change a second time.
//
// The two-stage engine already has the SHAPE of a sub-agent split — investigate
// runs its own agentic loop, verify runs a second one from a clean transcript —
// but verify's prompt re-sent every raw patch in full ALONGSIDE the candidate
// JSON. Every byte of every diff was therefore paid for twice per review, and
// re-sent on each of verify's up-to-12 agentic steps.
//
// The narrowing is DETERMINISTIC, not a model call. That is the whole reason it
// is a token win: the textbook sub-agent pattern (have investigate write a
// 1–2k-token summary for verify to work from) costs an extra ~1,500 OUTPUT
// tokens, billed at roughly 5x input, and on a single small commit that is more
// than the diff it saves. Slicing the patch down to the files the candidates
// actually cite costs nothing and can only remove tokens.
//
// Two guardrails keep it from ever making verify worse than it is today:
//
//   • It refuses to narrow unless the patch is genuinely big
//     ({@link VERIFY_FOCUS_MIN_BYTES}). On a small diff the saving is noise and
//     the "some files omitted" note would itself cost more than it frees.
//   • It refuses to narrow when NO section matches a cited file — candidates can
//     legitimately point at a caller the diff never touched, and a verify pass
//     handed an empty patch is blind. Full patch, unchanged.
//
// Whatever it does drop is named in a recovery note, and both stages have the
// read-only tools (`read_file`, and `git show <sha> -- <path>` via
// `run_command`) to fetch any of it back.

import type { CandidateFinding } from "./schema";

/** Below this the whole exercise is a rounding error — the note costs more than
 *  the hunks it elides. Roughly a third of `PATCH_MAX_BYTES` (30 KiB in
 *  `git.rs`), so a typical single-file commit is never touched. */
export const VERIFY_FOCUS_MIN_BYTES = 12 * 1024;

/** Line that opens each per-file section of a git patch. */
const FILE_SECTION_PREFIX = "diff --git ";

export type FocusedPatch = {
  /** The kept hunks, joined back into a valid patch. */
  text: string;
  /** Files whose hunks were dropped — named in the prompt's recovery note. */
  omitted: string[];
};

/** Every file path the candidate findings point at: where the bug is claimed to
 *  be, plus wherever a suggested fix would land (they can differ — a finding
 *  about a caller often patches the callee). */
export function focusPathsFromCandidates(
  candidates: readonly CandidateFinding[],
): string[] {
  const paths = new Set<string>();
  for (const c of candidates) {
    if (c.file) paths.add(c.file);
    const fix = c.suggestedFix;
    if (fix?.path) paths.add(fix.path);
  }
  return [...paths];
}

/** Split a git patch into its per-file sections, preserving any preamble. */
function splitPatchSections(rawPatch: string): {
  preamble: string;
  sections: string[];
} {
  const lines = rawPatch.split("\n");
  const preamble: string[] = [];
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(FILE_SECTION_PREFIX)) {
      if (current) sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current.join("\n"));
  return { preamble: preamble.join("\n"), sections };
}

/** Whether a patch section is one of the files we're keeping.
 *
 *  Matched by substring against the `diff --git a/x b/x` header rather than by
 *  parsing a path out of it. Git quotes and escapes paths containing spaces or
 *  non-ASCII, renames put two different paths on the line, and a mode-change
 *  section has no `+++` at all — a substring test sidesteps every one of those,
 *  and the only failure mode it has (keeping a file it didn't need to) is the
 *  safe direction. */
function sectionMatches(section: string, keepPaths: readonly string[]): boolean {
  const header = section.slice(0, section.indexOf("\n") + 1 || section.length);
  return keepPaths.some((p) => p.length > 0 && header.includes(p));
}

/** The file a section concerns, for the recovery note. Best-effort: falls back
 *  to the raw header when the path can't be read off it. */
function sectionLabel(section: string): string {
  const nl = section.indexOf("\n");
  const header = (nl === -1 ? section : section.slice(0, nl)).trim();
  const body = header.slice(FILE_SECTION_PREFIX.length);
  // `a/src/x.ts b/src/x.ts` → `src/x.ts`. Anything unusual (quoted paths,
  // renames) is left as-is rather than mangled.
  const m = /^a\/(.+?) b\/(.+)$/.exec(body);
  if (m) return m[2];
  return body || header;
}

/** Drop the hunks for files no candidate finding cites.
 *
 *  Returns null — meaning "send the patch unchanged" — whenever narrowing would
 *  be pointless or unsafe: a small patch, an unsplittable one, nothing matched,
 *  or nothing to drop. */
export function focusPatchOnFiles(
  rawPatch: string,
  keepPaths: readonly string[],
): FocusedPatch | null {
  if (rawPatch.length < VERIFY_FOCUS_MIN_BYTES) return null;
  if (keepPaths.length === 0) return null;

  const { preamble, sections } = splitPatchSections(rawPatch);
  if (sections.length < 2) return null;

  const kept: string[] = [];
  const omitted: string[] = [];
  for (const section of sections) {
    if (sectionMatches(section, keepPaths)) kept.push(section);
    else omitted.push(sectionLabel(section));
  }

  // Nothing cited lives in this patch: the findings are about code the diff
  // doesn't contain. Narrowing here would hand verify an empty patch.
  if (kept.length === 0) return null;
  if (omitted.length === 0) return null;

  const text = [preamble.trim(), ...kept].filter(Boolean).join("\n");
  // Paranoia, not arithmetic: a pathological patch where the kept sections
  // somehow outweigh the original must not be sent.
  if (text.length >= rawPatch.length) return null;
  return { text, omitted };
}
