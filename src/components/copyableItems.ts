/** Shared clipboard format for "copy these work items" affordances. One source
 *  of truth so every surface (history Cases/Bugs sections, the suite context
 *  menu, …) copies identically: plain text `<Kind> <id>: <title>` rows, plus an
 *  HTML payload that hyperlinks the `<Kind> <id>` prefix to the work item so a
 *  paste into Asana / Notion auto-recognises it. */

/** A single row the copy helpers know how to render. */
export type CopyableItem = {
  /** ADO work-item id, or null for pre-publish drafts (copies as a bare title). */
  id: number | null;
  title: string;
  /** Browser-openable URL — required for the HTML payload to carry a real link. */
  webUrl?: string | null;
};

/** Assemble the plain-text and HTML payloads for a set of items. The HTML
 *  payload wraps the "<Kind> <id>" prefix in an anchor so rich-text targets
 *  auto-link it; the plain payload is the same string without anchor markup.
 *  Items missing an id still copy — just without a leading reference. */
export function buildCopyPayload(
  kind: string,
  items: CopyableItem[],
): { plain: string; html: string } {
  const lines = items.map((it) => {
    const ref = it.id != null ? `${kind} ${it.id}` : null;
    const plain = ref ? `${ref}: ${it.title}` : it.title;
    const safeTitle = escapeHtml(it.title);
    let html: string;
    if (ref && it.webUrl) {
      html = `<a href="${escapeHtml(it.webUrl)}">${escapeHtml(ref)}</a>: ${safeTitle}`;
    } else if (ref) {
      html = `${escapeHtml(ref)}: ${safeTitle}`;
    } else {
      html = safeTitle;
    }
    return { plain, html };
  });
  return {
    plain: lines.map((l) => l.plain).join("\n"),
    html: `<div>${lines.map((l) => l.html).join("<br>")}</div>`,
  };
}

/**
 * Write items to the clipboard as a rich (HTML + plain) payload when the
 * webview supports it, falling back to plain text. Throws when the clipboard is
 * unavailable or the write is rejected so the caller can surface it; a no-op
 * for an empty list.
 */
export async function copyItems(
  kind: string,
  items: CopyableItem[],
): Promise<void> {
  if (items.length === 0) return;
  const { plain, html } = buildCopyPayload(kind, items);
  // Prefer the rich form. ClipboardItem isn't in older webviews (and some ship
  // it without navigator.clipboard.write), so fall back to plain text — that
  // still satisfies "paste my ids somewhere", just without the hyperlink.
  if (
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === "function"
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } else if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(plain);
  } else {
    throw new Error("Clipboard unavailable in this context.");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
