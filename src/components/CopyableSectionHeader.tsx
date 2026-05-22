import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

/** Shape of a single row the header knows how to copy. */
export type CopyableItem = {
  /** ADO work-item id, or null for pre-publish drafts. When present the
   *  clipboard payload renders the prefix as a hyperlink to webUrl so a
   *  paste into Asana / Notion auto-recognises the work item. */
  id: number | null;
  title: string;
  /** Browser-openable URL to the work item. Required for the HTML payload
   *  to carry a real link; without it we fall back to plain text. */
  webUrl?: string | null;
};

type Props = {
  /** Display label — "Cases" / "Bugs" / "Bug suggestions" / etc. */
  label: string;
  /** Singular human-readable type prefix used in the clipboard payload.
   *  e.g. "Test Case" → "Test Case 15285: <title>". */
  kind: string;
  /** The rows to assemble into the clipboard payload. Filtering (e.g. only
   *  copy successfully-published items) is the caller's responsibility. */
  items: CopyableItem[];
  /** Optional total count badge appended to the label, e.g. "Cases (5)". */
  count?: number;
  className?: string;
};

/**
 * Section header that surfaces a copy-on-hover affordance. The label sits in
 * a row; on hover, a tiny copy glyph fades in to the right. Clicking writes
 * the items to the clipboard as both plain text and HTML — the HTML form
 * carries hyperlinks on the id prefix (e.g. `<a href="...">Test Case
 * 15285</a>: <title>`) so pasting into a rich-text destination like Asana
 * preserves the work-item link, while a plain-text destination still gets the
 * readable form.
 */
export function CopyableSectionHeader({
  label,
  kind,
  items,
  count,
  className,
}: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (items.length === 0) return;
    const { plain, html } = buildPayload(kind, items);
    try {
      // Prefer the rich form when supported. ClipboardItem isn't available
      // in older webviews, so fall back to plain text — that still satisfies
      // the "paste my published IDs somewhere" use case, just without the
      // automatic hyperlink on the id.
      if (
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard &&
        // Some webviews ship ClipboardItem but not navigator.clipboard.write.
        typeof navigator.clipboard.write === "function"
      ) {
        const blobs: Record<string, Blob> = {
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        };
        await navigator.clipboard.write([new ClipboardItem(blobs)]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // Clipboard write was rejected (permission denied, or insecure context).
      // Silent failure here is fine — the user can still read the values on
      // screen and would only see a vague error otherwise.
    }
  };

  const disabled = items.length === 0;
  return (
    <div
      className={cn(
        "group/copyheader mb-1.5 flex items-center gap-2",
        className,
      )}
    >
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {count != null ? (
          <span className="ml-1 text-muted-foreground/55">({count})</span>
        ) : null}
      </h2>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onCopy}
            disabled={disabled}
            aria-label={`Copy all ${label.toLowerCase()}`}
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-all duration-150",
              "opacity-0 group-hover/copyheader:opacity-100 focus-visible:opacity-100",
              disabled
                ? "cursor-not-allowed text-muted-foreground/30"
                : copied
                  ? "bg-primary/15 text-primary opacity-100"
                  : "text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={10}
              strokeWidth={1.75}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-[11px]">
          {disabled
            ? `Nothing to copy yet`
            : copied
              ? `Copied ${items.length} ${label.toLowerCase()}`
              : `Copy all ${items.length} ${label.toLowerCase()} — pastes as <link>: title rows`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Assemble the plain-text and HTML payloads for a set of items. The HTML
 *  payload wraps the "<Kind> <id>" prefix in an anchor so rich-text targets
 *  like Asana auto-link it; the plain payload is the same string without
 *  anchor markup. Items missing an id still copy — just without a leading
 *  reference (`<title>` alone) so the caller doesn't have to filter. */
function buildPayload(
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
