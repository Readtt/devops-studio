/**
 * Bug repro-steps carry a `<!-- devops-studio:code-links:v1 -->` block holding
 * a list of `{ file, lines, sha? }` anchors. The Rust side (bugs.rs) writes
 * the block; this module reads it back.
 *
 * The Rust serializer formats each entry as a `<LI>` inside `<UL>` after the
 * marker, with text like:
 *
 *   src/checkout.ts:42-58 (commit abc1234)
 *   src/checkout.ts:42
 *   src/checkout.ts:42 (commit abc1234)
 *
 * We're tolerant on parse — any line we can't pattern-match is dropped.
 */
import type { CodeLink } from "@/modules/ado";

const MARKER_OPEN = "<!-- devops-studio:code-links:v1 -->";
const MARKER_CLOSE = "<!-- /devops-studio:code-links -->";

export function parseCodeLinks(html: string): CodeLink[] {
  const open = html.indexOf(MARKER_OPEN);
  if (open < 0) return [];
  const close = html.indexOf(MARKER_CLOSE, open);
  if (close < 0) return [];
  const body = html.slice(open + MARKER_OPEN.length, close);

  const out: CodeLink[] = [];
  // Pull out every <LI>…</LI>, case-insensitive.
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = liRegex.exec(body))) {
    const text = htmlToPlain(match[1]).trim();
    const parsed = parseLine(text);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Strip the code-links block out of repro-steps HTML before rendering the
 *  human-facing repro text. The block has its own dedicated UI section. */
export function stripCodeLinksBlock(html: string): string {
  return html.replace(
    /<P><!-- devops-studio:code-links:v1 -->[\s\S]*?<!-- \/devops-studio:code-links --><\/P>/g,
    "",
  );
}

function parseLine(line: string): CodeLink | null {
  // Match `path:start-end` or `path:start`, optionally followed by `(commit XYZ)`.
  // The path can include slashes, dots, and most filename chars. We anchor on
  // the LAST `:line[-line]` so paths with embedded colons (rare but possible)
  // still parse.
  const m = line.match(
    /^(.+):(\d+)(?:[–—-](\d+))?(?:\s*\(commit\s+([0-9a-f]+)\))?\s*$/i,
  );
  if (!m) return null;
  const file = m[1].trim();
  const startLine = Number.parseInt(m[2], 10);
  const endLine = m[3] ? Number.parseInt(m[3], 10) : undefined;
  const commitSha = m[4] ? m[4] : undefined;
  if (!file || !Number.isFinite(startLine)) return null;
  return { file, startLine, endLine, commitSha };
}

function htmlToPlain(s: string): string {
  // Strip tags first, then decode the handful of entities the producer emits.
  const tagless = s.replace(/<[^>]*>/g, "");
  return tagless
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
