/**
 * Source-links block lives inside the ADO Test Case Description as a
 * delimited Markdown chunk so we don't need ADO custom fields. See plan §D.
 *
 *   <!-- devops-studio:source-links:v1 -->
 *   - repo: MyApp / branch: main / file: src/auth/login.cs / symbol: LoginController.Authenticate / lines: 42-78 / sha: abc123 / generation-branch: feature/2fa
 *   - repo: MyApp / branch: main / file: src/auth/sms.cs / symbol: SmsSender.Send
 *   <!-- /devops-studio:source-links -->
 *
 * The serializer is intentionally simple — every link occupies one line and
 * uses `key: value` pairs separated by ` / `. We tolerate missing optional
 * fields when parsing.
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
  const parts: string[] = [
    `repo: ${escape(l.repoName)}`,
    `branch: ${escape(l.trackingBranch)}`,
    `file: ${escape(l.filePath)}`,
  ];
  if (l.symbol) parts.push(`symbol: ${escape(l.symbol)}`);
  if (l.lineRange) parts.push(`lines: ${l.lineRange.start}-${l.lineRange.end}`);
  parts.push(`sha: ${l.generationSha}`);
  if (l.generationBranch !== l.trackingBranch) {
    parts.push(`generation-branch: ${escape(l.generationBranch)}`);
  }
  parts.push(`repo-id: ${l.repoId}`);
  return `- ${parts.join(" / ")}`;
}

function parseLine(line: string): SourceLink | null {
  const fields = new Map<string, string>();
  for (const part of line.split("/")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    fields.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const repoName = fields.get("repo");
  const trackingBranch = fields.get("branch");
  const filePath = fields.get("file");
  if (!repoName || !trackingBranch || !filePath) return null;
  const lineRange = parseLineRange(fields.get("lines"));
  const sha = fields.get("sha") ?? "";
  const repoId = fields.get("repo-id") ?? repoName;
  return {
    repoId,
    repoName,
    generationBranch: fields.get("generation-branch") ?? trackingBranch,
    generationSha: sha,
    trackingBranch,
    filePath,
    symbol: fields.get("symbol"),
    lineRange,
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
  // Avoid the " / " separator turning up inside a value.
  return s.replace(/\s*\/\s*/g, " ∕ ");
}
