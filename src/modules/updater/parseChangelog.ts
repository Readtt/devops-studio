/** A semantic chunk of release notes — one of "Added", "Fixed", etc. */
export interface ChangelogSection {
  /** Original label as it appeared in the markdown ("Added", "Fixed", …). */
  label: string;
  /** Slug we use to pick an accent color in the UI ("added" | "fixed" | …). */
  kind: "added" | "fixed" | "changed" | "removed" | "security" | "other";
  /** Bullet items, with markdown links flattened to plain text. */
  items: string[];
}

/** Strip basic markdown noise so a bullet renders cleanly in a small chip.
 *  We deliberately don't try to render rich markdown — release notes inside
 *  the toast are a glance affordance, not a reading surface. */
function flatten(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(label: string): ChangelogSection["kind"] {
  const l = label.toLowerCase();
  if (l.startsWith("add")) return "added";
  if (l.startsWith("fix")) return "fixed";
  if (l.startsWith("chang")) return "changed";
  if (l.startsWith("remov") || l.startsWith("delet")) return "removed";
  if (l.startsWith("sec")) return "security";
  return "other";
}

/** Parse a Keep-a-Changelog-style body into structured sections.
 *
 *  Handles continuation lines (indented or unprefixed lines after a bullet
 *  belong to that bullet) and tolerates bodies with no headers at all — in
 *  that case everything lands under an "Other" section so the UI never has
 *  to special-case "the changelog is just a paragraph". */
export function parseChangelog(body: string | undefined | null): ChangelogSection[] {
  if (!body) return [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  let pendingItem: string[] | null = null;

  const flushItem = () => {
    if (pendingItem && current) {
      const text = flatten(pendingItem.join(" "));
      if (text) current.items.push(text);
    }
    pendingItem = null;
  };

  const ensureCurrent = () => {
    if (!current) {
      current = { label: "Notes", kind: "other", items: [] };
      sections.push(current);
    }
    return current;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushItem();
      continue;
    }
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) {
      flushItem();
      const label = heading[1].trim();
      current = { label, kind: classify(label), items: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushItem();
      ensureCurrent();
      pendingItem = [bullet[1]];
      continue;
    }
    // Continuation: indented or just wrapped text following a bullet.
    if (pendingItem) {
      pendingItem.push(line.trim());
      continue;
    }
    // Free-floating prose — treat as its own item under the active section.
    ensureCurrent();
    pendingItem = [line.trim()];
  }
  flushItem();

  return sections.filter((s) => s.items.length > 0);
}
