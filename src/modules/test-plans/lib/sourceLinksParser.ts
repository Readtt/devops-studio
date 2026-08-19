/**
 * Source-links block lives inside the ADO Test Case Description as a
 * delimited Markdown chunk so we don't need ADO custom fields. See plan §D.
 *
 *   <!-- devops-studio:source-links:v1 -->
 *   - repo: MyApp / project: Payments / branch: main / file: src ∕ auth ∕ login.cs / symbol: LoginController.Authenticate / lines: 42-78 / sha: abc123 / repo-id: 6f1e…
 *   - repo: MyApp / project: Payments / branch: main / file: src ∕ auth ∕ sms.cs / symbol: SmsSender.Send / repo-id: 6f1e…
 *   <!-- /devops-studio:source-links -->
 *
 * Every link occupies one line of `key: value` pairs separated by ` / `. Since
 * the separator is a slash, a value's own slashes are written as U+2215
 * DIVISION SLASH: `escape` and `unescape` are a pair, and dropping either end
 * corrupts every path and every slashed branch name on the way back out.
 *
 * The block is appended verbatim to the ADO work item's Description, which is
 * an HTML field — so `<`, `>` and `&` are escaped too. A C# symbol is the case
 * that bites: `Repository<T>.GetAsync` writes a live `<T>` tag, which ADO's
 * renderer swallows, and the user reads `Repository.GetAsync` in a description
 * they can't tell has been mangled. `unescape` decodes unconditionally, which
 * is a no-op on the blocks written before this and repairs the ones where ADO
 * did the encoding itself.
 *
 * Only `repo` and `file` are required. Everything else is optional — notably
 * `branch`, absent whenever the case was published without source-branch
 * tagging, and `project`, absent for an unbound repo and for every case
 * published before repo binding existed — and an empty value reads as an
 * absent one. Making any of them required would drop the whole line, i.e.
 * silently erase the links on cases an older build published. Unknown keys are
 * ignored so a newer build's extra fields don't invalidate the whole link.
 */
import type { SourceLink } from "@/modules/ado";

const MARKER_OPEN = "<!-- devops-studio:source-links:v1 -->";
const MARKER_CLOSE = "<!-- /devops-studio:source-links -->";

export function parseSourceLinks(description: string): SourceLink[] {
  const open = description.indexOf(MARKER_OPEN);
  if (open < 0) return [];
  const close = description.indexOf(MARKER_CLOSE, open);
  if (close < 0) return [];
  const body = description.slice(open + MARKER_OPEN.length, close);
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => parseLine(l.slice(2)))
    .filter((l): l is SourceLink => l !== null);
}

export function injectSourceLinks(
  description: string,
  links: SourceLink[],
): string {
  const block = renderBlock(links);
  const open = description.indexOf(MARKER_OPEN);
  if (open < 0) {
    const sep = description.endsWith("\n") || description.length === 0 ? "" : "\n\n";
    return `${description}${sep}${block}`;
  }
  const close = description.indexOf(MARKER_CLOSE, open);
  if (close < 0) {
    // Malformed — strip everything after the open marker and re-append.
    return `${description.slice(0, open)}${block}`;
  }
  const before = description.slice(0, open);
  const after = description.slice(close + MARKER_CLOSE.length);
  return `${before}${block}${after}`;
}

export function renderBlock(links: SourceLink[]): string {
  const lines = links.map(renderLine);
  return `${MARKER_OPEN}\n${lines.join("\n")}\n${MARKER_CLOSE}`;
}

function renderLine(l: SourceLink): string {
  const parts: string[] = [`repo: ${escape(l.repoName)}`];
  // Absent for an unbound repo, and for every case published before repo
  // binding — the reader falls back to the connection's project, which is what
  // those links always meant.
  if (l.project) parts.push(`project: ${escape(l.project)}`);
  // An empty branch means no provenance was stamped, which is a legitimate
  // state ("Tag with source branch" off, detached HEAD, non-git source dir).
  // Emit no key at all rather than a blank one.
  if (l.trackingBranch) parts.push(`branch: ${escape(l.trackingBranch)}`);
  parts.push(`file: ${escape(l.filePath)}`);
  if (l.symbol) parts.push(`symbol: ${escape(l.symbol)}`);
  if (l.lineRange) parts.push(`lines: ${l.lineRange.start}-${l.lineRange.end}`);
  if (l.generationSha) parts.push(`sha: ${escape(l.generationSha)}`);
  if (l.generationBranch && l.generationBranch !== l.trackingBranch) {
    parts.push(`generation-branch: ${escape(l.generationBranch)}`);
  }
  parts.push(`repo-id: ${escape(l.repoId)}`);
  return `- ${parts.join(" / ")}`;
}

function parseLine(line: string): SourceLink | null {
  const fields = new Map<string, string>();
  for (const part of line.split("/")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const value = unescape(part.slice(idx + 1).trim());
    // Empty reads as absent, so every `?? fallback` below behaves the same for
    // a key that was omitted and one that was written blank by an older build.
    if (value) fields.set(part.slice(0, idx).trim(), value);
  }
  const repoName = fields.get("repo");
  const filePath = fields.get("file");
  if (!repoName || !filePath) return null;
  const trackingBranch = fields.get("branch") ?? "";
  return {
    repoId: fields.get("repo-id") ?? repoName,
    repoName,
    project: fields.get("project"),
    generationBranch: fields.get("generation-branch") ?? trackingBranch,
    generationSha: fields.get("sha") ?? "",
    trackingBranch,
    filePath,
    symbol: fields.get("symbol"),
    lineRange: parseLineRange(fields.get("lines")),
  };
}

function parseLineRange(
  raw: string | undefined,
): { start: number; end: number } | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function escape(s: string): string {
  // Newlines first: a record is ONE line, and `parseLine` only reads lines that
  // start with `- `, so a value carrying a newline silently truncates the
  // record — the line range, the provenance sha and the repo id after it all
  // vanish on the round trip. Then avoid the " / " separator turning up inside
  // a value. Markup last, and `&` before the others so the ampersands it
  // introduces aren't escaped a second time.
  return s
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, " ∕ ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescape(s: string): string {
  // Tolerant of the padding `escape` adds and of values that never had a
  // slash, so already-clean text passes through untouched — which is also what
  // makes this safe to run over blocks written before the markup escaping
  // existed. `&amp;` LAST, so `&amp;lt;` decodes to the literal `&lt;` rather
  // than being decoded twice into `<`.
  return s
    .replace(/\s*∕\s*/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}
