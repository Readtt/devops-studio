// Pure parsing/formatting helpers for code references. Kept framework-free
// (no React) so the parser — which has regressed before: dropped trailing
// ranges, missed .cshtml — can be unit-tested directly. CodeRefChip.tsx
// renders these; ChatMarkdown / ConfidenceDetailPanel parse with parseCodeRef.

export type CodeRange = { start: number; end?: number };

/** File extensions that linkify as code refs. Longest-first where a prefix
 *  collides (csproj before cs, vbproj/vbhtml before vb, config before conf) so
 *  the right alternative wins. Covers the .NET/web stack this tool reviews plus
 *  the usual source/markup/style/config files. Single source of truth shared by
 *  the in-prose scanner (ChatMarkdown) and the inline-code-span linkifier — keep
 *  them in sync by importing this, never by re-typing the list. */
export const CODE_REF_EXTENSIONS =
  "tsx?|jsx?|mjs|cjs|cshtml|csproj|cs|razor|vbproj|vbhtml|vb|xaml|fs|java|kt|go|py|rs|rb|php|swift|m|mm|c|cc|cpp|h|hpp|css|scss|sass|less|html?|json|jsonc|yaml|yml|md|sql|sh|ps1|toml|ini|xml|aspx|ascx|asax|ashx|asmx|master|resx|config|conf|props|targets|sln|vue|svelte|tauri";

/** Regex SOURCE (no anchors, no flags) for a file ref carrying at least one
 *  line or range: "foo.cs:42", "src/a/b.ts:1-9", "x.cs:376,594-600,1080".
 *  Embed it in a `g`-flagged scanner to find refs inside prose, or anchor it
 *  (see {@link isCodeRefToken}) to test a single token. The line requirement is
 *  deliberate — a bare "package.json" in prose shouldn't masquerade as a ref. */
export const CODE_REF_PATTERN = `(?:[\\w./-]+\\/)?[\\w.-]+\\.(?:${CODE_REF_EXTENSIONS}):\\d+(?:[-–]\\d+)?(?:\\s*,\\s*:?\\d+(?:[-–]\\d+)?)*`;

/** True when the WHOLE string is one code-ref token. Lets a citation the model
 *  wrapped in backticks (`src/auth/Login.cs:42`) still linkify instead of
 *  rendering as dead monospace — the most common reason a cited "source"
 *  wasn't clickable. */
export function isCodeRefToken(s: string): boolean {
  return new RegExp(`^(?:${CODE_REF_PATTERN})$`).test(s.trim());
}

/** Format one range for display: "42" or "42–58" (collapsed when start==end). */
export function fmtRange(r: CodeRange): string {
  return r.end && r.end !== r.start ? `${r.start}–${r.end}` : `${r.start}`;
}

/** Show the last two path segments when long, so the chip stays scannable
 *  ("src/auth/loginController.ts" → "…/auth/loginController.ts"). */
export function shortenPath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (norm.length <= 30) return norm;
  const segs = norm.split("/");
  if (segs.length <= 2) return norm;
  return `…/${segs.slice(-2).join("/")}`;
}

/** Parse "src/foo.ts" / "src/foo.ts:42" / "src/foo.ts:42-58" /
 *  "src/foo.ts:376,594-600,1080" (commas, optional leading ":" / "L" per range,
 *  en-dashes) into a path + ordered ranges. Tolerates a leading `file:` scheme
 *  and a Windows drive letter ("C:\repo\foo.cs:42" splits at the *line* colon,
 *  not the drive colon). Returns null only for empty input so callers can fall
 *  back to plain text. */
export function parseCodeRef(
  raw: string,
): { path: string; ranges: CodeRange[] } | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  // A stray `file:` scheme shouldn't break the ref (chat links normally strip
  // it, but model-emitted evidence refs occasionally carry it).
  trimmed = trimmed.replace(/^file:/i, "").trim();
  if (!trimmed) return null;
  // Split the path off at the first ":<digit>" that follows it. The non-greedy
  // path skips a Windows drive colon ("C:\…") because the char after it isn't a
  // line digit, landing on the real line separator instead.
  const m = trimmed.match(/^(.*?):(\s*L?\d.*)$/);
  if (!m) return { path: trimmed, ranges: [] };
  const path = m[1];
  const ranges: CodeRange[] = [];
  for (const part of m[2].split(",")) {
    const rm = part
      .trim()
      .replace(/^:/, "")
      .match(/^L?(\d+)(?:[-–]L?(\d+))?/);
    if (rm) {
      ranges.push({
        start: Number.parseInt(rm[1], 10),
        end: rm[2] ? Number.parseInt(rm[2], 10) : undefined,
      });
    }
  }
  return { path, ranges };
}
