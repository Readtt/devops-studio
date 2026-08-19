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
import { cn } from "@/lib/utils";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";

type Props = {
  value: string;
  /** Suggestions to offer. May be empty — the user can still type a value. */
  options: string[];
  onChange: (next: string) => void;
  disabled?: boolean;
  /** True while `options` is being fetched. Renders skeleton rows. */
  loading?: boolean;
  /** Shown in place of the list when there are no options and we aren't
   *  loading — explain why the list is empty and that typing still works. */
  emptyHint?: React.ReactNode;
  /** Fired when the popover opens, so the parent can fetch lazily. */
  onOpen?: () => void;
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
  className?: string;
};

/**
 * Combobox over a suggestion list that also accepts anything the user types.
 *
 * Sibling of `BranchPicker`, but for values we can only *suggest*: a custom
 * model endpoint may not list its models, may list them wrong, or may be
 * offline when the user configures it — so the typed value always wins and
 * the list is a convenience, never a constraint.
 */
export function ComboboxCreatable({
  value,
  options,
  onChange,
  disabled,
  loading = false,
  emptyHint,
  onOpen,
  placeholder = "Select or type a value…",
  searchPlaceholder = "Search or type…",
  ariaLabel,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const o of options) {
      if (o && !seen.has(o)) {
        out.push(o);
        seen.add(o);
      }
    }
    // A value set earlier must stay visible even when the endpoint stops
    // listing it (server restarted with a different model loaded, typo, etc.).
    if (value && !seen.has(value)) out.unshift(value);
    return out;
  }, [options, value]);

  const typed = query.trim();
  const showCreate = typed.length > 0 && !items.includes(typed);

  const commit = (next: string) => {
    onChange(next);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
        else setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-input/40 px-2 py-1 text-left transition-colors outline-none",
            "hover:bg-input/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[11.5px]",
              !value && "font-sans text-muted-foreground",
            )}
          >
            {value || placeholder}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/70"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        // Match the trigger width so the list lines up with the field it fills.
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
          />
          <CommandList className="max-h-[280px]">
            {loading ? (
              <div className="flex flex-col gap-1 p-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {emptyHint ?? "Nothing matches — type a value to use it."}
                </CommandEmpty>
                {showCreate ? (
                  <CommandGroup>
                    {/* value === the search text, so cmdk's fuzzy filter always
                        scores this row a perfect match and never hides it. */}
                    <CommandItem value={typed} onSelect={() => commit(typed)}>
                      <span className="truncate text-[11.5px] text-muted-foreground">
                        Use{" "}
                        <span className="font-mono text-foreground">
                          {typed}
                        </span>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {items.length > 0 ? (
                  <CommandGroup heading={showCreate ? "Available" : undefined}>
                    {items.map((o) => (
                      <CommandItem
                        key={o}
                        value={o}
                        data-checked={value === o}
                        onSelect={() => commit(o)}
                      >
                        <span className="truncate font-mono text-[11.5px]">
                          {o}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
