import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getWorkItem,
  searchWorkItems as adoSearchWorkItems,
  type WorkItemRef,
} from "@/modules/ado";
import { Cancel01Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";

/**
 * Inline `#id` work-item mention for chat composers. Type `#` in the textarea
 * and a dropdown of matching Azure DevOps work items appears; pick one to
 * attach it as read-only context (it's NOT modified — folded into the prompt
 * so answers can reference its title / repro / code links).
 *
 * Replaces the old standalone "Bugs" attach button: discovery now lives where
 * the user is already typing. `#123` resolves the exact item by id; `#login`
 * does a title search; a bare `#` lists recent bugs.
 *
 * The hook owns detection + search + keyboard nav; the consuming composer wires
 * its textarea to the returned handlers, renders <MentionDropdown> above the
 * input, and renders <WorkItemChips> for the attached set.
 */

// Work-item type → a tiny abbreviation + tint. Kept minimal: one small mono
// tag per row/chip so the type reads at a glance without a heavy badge.
const TYPE_ABBR: Record<string, string> = {
  Bug: "BUG",
  Task: "TASK",
  "User Story": "STORY",
  "Product Backlog Item": "PBI",
  Feature: "FEAT",
  Epic: "EPIC",
  Issue: "ISSUE",
};
const TYPE_TINT: Record<string, string> = {
  Bug: "text-rose-500 dark:text-rose-400",
  Task: "text-amber-600 dark:text-amber-400",
  "User Story": "text-sky-600 dark:text-sky-400",
  "Product Backlog Item": "text-sky-600 dark:text-sky-400",
  Feature: "text-violet-600 dark:text-violet-400",
  Epic: "text-fuchsia-600 dark:text-fuchsia-400",
  Issue: "text-emerald-600 dark:text-emerald-400",
};

function typeAbbr(type: string): string {
  return TYPE_ABBR[type] ?? (type ? type.slice(0, 4).toUpperCase() : "ITEM");
}
function typeTint(type: string): string {
  return TYPE_TINT[type] ?? "text-muted-foreground";
}

/** Minimal type marker: a small tinted mono abbreviation. `compact` drops the
 *  fixed width for inline use on chips. */
function TypeTag({
  type,
  compact,
}: {
  type: string;
  compact?: boolean;
}) {
  return (
    <span
      title={type || "Work item"}
      className={cn(
        "shrink-0 font-mono text-[8.5px] font-semibold uppercase tracking-wider tabular-nums",
        compact ? "" : "w-9",
        typeTint(type),
      )}
    >
      {typeAbbr(type)}
    </span>
  );
}

type Token = { start: number; query: string };

/** Find an open `#token` ending at the caret. The `#` must sit at a word
 *  boundary so mid-word "#" (rare) doesn't trigger. */
function detectToken(value: string, caret: number): Token | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)#([A-Za-z0-9_]*)$/);
  if (!m) return null;
  const query = m[1];
  return { start: caret - query.length - 1, query };
}

export type WorkItemMention = {
  active: boolean;
  query: string;
  results: WorkItemRef[];
  loading: boolean;
  highlight: number;
  setHighlight: (i: number) => void;
  accept: (item: WorkItemRef) => void;
  dismiss: () => void;
  /** Call from the textarea's onChange (after propagating the value up). */
  noteInput: (value: string, caret: number) => void;
  /** Call from the textarea's onSelect / onClick / onKeyUp to track the caret. */
  noteCaret: (value: string, caret: number) => void;
  /** Call from the textarea's onKeyDown FIRST. Returns true when the mention
   *  consumed the key (caller must then not run its own handler). */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
};

export function useWorkItemMention({
  value,
  onValueChange,
  onAdd,
  selectedIds,
  areaPath,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onAdd: (item: WorkItemRef) => void;
  selectedIds: number[];
  areaPath?: string | null;
}): WorkItemMention {
  const [token, setToken] = useState<Token | null>(null);
  const [results, setResults] = useState<WorkItemRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const selectedSet = new Set(selectedIds);

  // Debounced search whenever the active token's query changes.
  useEffect(() => {
    if (!token) {
      setResults([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setHighlight(0);
    const q = token.query;
    const t = setTimeout(() => {
      void fetchMentionItems(q, areaPath ?? null)
        .then((items) => {
          if (alive) setResults(items.filter((b) => !selectedSet.has(b.id)));
        })
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // selectedSet identity churns each render; gate on the stable id list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.query, token === null, areaPath, selectedIds.join(",")]);

  const dismiss = useCallback(() => setToken(null), []);

  const accept = useCallback(
    (item: WorkItemRef) => {
      if (token) {
        const after = token.start + 1 + token.query.length;
        const next = value.slice(0, token.start) + value.slice(after);
        onValueChange(next.replace(/\s{2,}$/, " "));
      }
      onAdd(item);
      setToken(null);
    },
    [token, value, onValueChange, onAdd],
  );

  const noteInput = useCallback((v: string, caret: number) => {
    setToken(detectToken(v, caret));
  }, []);
  const noteCaret = useCallback((v: string, caret: number) => {
    setToken(detectToken(v, caret));
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!token) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        setToken(null);
        return true;
      }
      if (results.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % results.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + results.length) % results.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const item = results[highlight];
        if (item) {
          e.preventDefault();
          accept(item);
          return true;
        }
      }
      return false;
    },
    [token, results, highlight, accept],
  );

  return {
    active: token !== null,
    query: token?.query ?? "",
    results,
    loading,
    highlight,
    setHighlight,
    accept,
    dismiss,
    noteInput,
    noteCaret,
    onKeyDown,
  };
}

/** Resolve work items for a mention query. Numeric → exact fetch by id (ADO's
 *  title search can't match ids); text → title search; empty → recent items.
 *  Spans every work-item type, not just Bugs. */
async function fetchMentionItems(
  query: string,
  areaPath: string | null,
): Promise<WorkItemRef[]> {
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    try {
      return [await getWorkItem(Number(q))];
    } catch {
      return [];
    }
  }
  return adoSearchWorkItems({ areaPath, query: q || null, top: 8 });
}

export function MentionDropdown({
  mention,
}: {
  mention: WorkItemMention;
}) {
  const { query, results, loading, highlight, setHighlight, accept } = mention;
  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-xl">
      <div className="border-b border-border/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
        {query ? (
          <>
            Attaching{" "}
            <span className="font-mono text-foreground/80">#{query}</span> —
            pick a work item
          </>
        ) : (
          "Recent work items — type an id or keywords"
        )}
      </div>
      <div className="max-h-[240px] overflow-y-auto py-1">
        {loading && results.length === 0 ? (
          <div className="flex flex-col gap-1 px-2 py-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-7 w-full rounded-md" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
            {query ? "No work items match." : "No work items found."}
          </p>
        ) : (
          results.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so the textarea doesn't blur first.
                e.preventDefault();
                accept(b);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
                i === highlight ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
              )}
            >
              <TypeTag type={b.workItemType} />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                #{b.id}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {b.title}
              </span>
              {b.state ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {b.state}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function WorkItemChips({
  items,
  onRemove,
}: {
  items: WorkItemRef[];
  onRemove: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((b) => (
        <Tooltip key={b.id}>
          <TooltipTrigger asChild>
            <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border/50 bg-card px-1.5 text-[10.5px]">
              <TypeTag type={b.workItemType} compact />
              <span className="font-mono text-muted-foreground">#{b.id}</span>
              <span className="max-w-[10rem] truncate text-foreground/80">
                {b.title}
              </span>
              <button
                type="button"
                onClick={() => onRemove(b.id)}
                aria-label={`Remove #${b.id}`}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent
            variant="panel"
            side="bottom"
            className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-1.5">
                <span className={cn("font-mono text-[9px] font-semibold uppercase tracking-wider", typeTint(b.workItemType))}>
                  {b.workItemType || "Work item"}
                </span>
                <span className="font-mono text-muted-foreground">#{b.id}</span>
              </div>
              <span className="text-foreground/85">{b.title}</span>
              <span className="text-[10px] text-muted-foreground/70">
                Attached as read-only context.
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** Tiny hint chip shown near the composer so users discover the `#` syntax.
 *  Reuses the Loading spinner only when a mention search is mid-flight. */
export function MentionHint({ loading }: { loading?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
      {loading ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={9}
          strokeWidth={2}
          className="animate-spin"
        />
      ) : null}
      Type <span className="font-mono text-foreground/70">#id</span> to attach a
      work item
    </span>
  );
}
