import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { type CopyableItem, copyItems } from "./copyableItems";

// The item shape + clipboard format live in copyableItems.ts so other surfaces
// (e.g. the suite context menu's "Copy all open bugs") copy identically.
// Re-exported here for existing importers.
export type { CopyableItem };

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
    try {
      await copyItems(kind, items);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // Clipboard write was rejected (permission denied, or insecure context).
      // Silent failure here is fine — the user can still read the values on
      // screen and would only see a vague error otherwise.
    }
  };

  const disabled = items.length === 0;
  // Drafts have no ADO id yet, so they copy as bare title rows — there's no
  // link to render. Only published items (id present) copy as "Kind <id>:
  // title", hyperlinked when a webUrl is known. The tooltip says which of
  // these the user will actually get so a draft copy doesn't promise a link
  // that isn't there.
  const hasIds = items.some((it) => it.id != null);
  const copyHint = hasIds
    ? `pastes as ${kind} ID + title rows (linked where published)`
    : `pastes as plain title rows`;
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
              : `Copy all ${items.length} ${label.toLowerCase()} — ${copyHint}`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
