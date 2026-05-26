import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { listBugs, type BugRef } from "@/modules/ado";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  selected: BugRef[];
  onAdd: (bug: BugRef) => void;
  onRemove: (id: number) => void;
  /** Optional area-path scope for the WIQL query. */
  areaPath?: string | null;
  disabled?: boolean;
};

/** Severity → dot color. Severity strings are "1 - Critical" … "4 - Low". */
function severityDot(sev?: string | null): string {
  if (!sev) return "bg-muted-foreground/40";
  if (sev.startsWith("1")) return "bg-rose-500";
  if (sev.startsWith("2")) return "bg-amber-500";
  if (sev.startsWith("3")) return "bg-sky-500";
  return "bg-muted-foreground/50";
}

/**
 * Attach existing ADO bugs as read-only context for an AI surface. The bugs
 * are NOT modified — they're folded into the prompt so the model can reference
 * repro steps, severity, and embedded code links. Mirrors the cmdk combobox
 * pattern of BranchPicker; selected bugs render as removable chips inline.
 */
export function BugContextPicker({
  selected,
  onAdd,
  onRemove,
  areaPath,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BugRef[]>([]);
  const [loading, setLoading] = useState(false);

  // Debounced server-side WIQL search while the popover is open. shouldFilter
  // is off on the Command so the list shows server results verbatim (the WIQL
  // CONTAINS search reaches bugs beyond the first page, unlike client filter).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      void listBugs({ areaPath: areaPath ?? null, query: query.trim() || null, top: 50 })
        .then((bugs) => alive && setResults(bugs))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query, areaPath]);

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label="Attach bugs as context"
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] text-muted-foreground transition-colors",
                  "hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04]",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  selected.length > 0 && "text-foreground/85",
                )}
              >
                <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.75} />
                <span>Bugs</span>
                {selected.length > 0 ? (
                  <span className="rounded-sm bg-primary/15 px-1 text-[10px] font-medium tabular-nums text-primary">
                    {selected.length}
                  </span>
                ) : null}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Attach existing Azure DevOps bugs as context. They're included in
            the prompt (title, repro, code links) so answers can reference them
            — the bugs themselves are not modified.
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className="w-80 gap-0 rounded-lg p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search bugs by title…"
              className="h-8 text-[12px]"
            />
            <CommandList className="max-h-[280px]">
              {loading && results.length === 0 ? (
                <div className="flex flex-col gap-1 p-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-7 w-full rounded-md" />
                  ))}
                </div>
              ) : (
                <CommandEmpty>No bugs match.</CommandEmpty>
              )}
              <CommandGroup>
                {results.map((b) => {
                  const isSel = selected.some((x) => x.id === b.id);
                  return (
                    <CommandItem
                      key={b.id}
                      value={String(b.id)}
                      onSelect={() => (isSel ? onRemove(b.id) : onAdd(b))}
                      className="gap-2 py-1.5"
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          severityDot(b.severity),
                        )}
                      />
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
                      {isSel ? (
                        <HugeiconsIcon
                          icon={CheckmarkCircle02Icon}
                          size={13}
                          strokeWidth={1.75}
                          className="shrink-0 text-emerald-500"
                        />
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.map((b) => (
        <Tooltip key={b.id}>
          <TooltipTrigger asChild>
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border/50 bg-card px-1.5 text-[10.5px]">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  severityDot(b.severity),
                )}
              />
              <span className="font-mono text-muted-foreground">#{b.id}</span>
              <button
                type="button"
                onClick={() => onRemove(b.id)}
                aria-label={`Remove bug #${b.id}`}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            {b.title}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
