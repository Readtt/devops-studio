import { Command as CommandPrimitive } from "cmdk";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  SearchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

export type SearchableSelectOption = {
  value: string;
  label: string;
  /** Optional secondary text shown to the right of the label (e.g. id). */
  hint?: string;
  /** When set, this option is shown but cannot be selected. */
  disabled?: boolean;
};

type Props = {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  /** Shown when there are zero options total (e.g. "No suites loaded"). */
  emptyLabel?: string;
  /** Shown when the search filter yields no matches. */
  noResultsLabel?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

/**
 * Searchable select restyled to match DevOps Studio's density (11.5–12px
 * type, 8px-row Inter, monospace hint). Anchored to the trigger with a
 * matching width so it doesn't feel like a generic web-app dropdown.
 *
 * Built on radix Popover + cmdk Command. We render our own minimal chrome
 * instead of using the shadcn Command wrapper because that one bakes in
 * a 14px / `rounded-3xl` look that fights the rest of the app.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  emptyLabel = "No options",
  noResultsLabel = "No matches",
  disabled = false,
  className,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Reset query when the popover closes so reopening starts clean.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "group flex h-8 w-full items-center gap-1.5 rounded-md border border-border/60 bg-input/40 px-2 text-[12px] transition-colors",
            "hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/30",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          {selected?.hint ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
              {selected.hint}
            </span>
          ) : null}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={1.75}
            // data-state lives on the trigger button, so the icon reads it
            // via group-* — a bare data-[state=open] here never matches.
            className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-(--radix-popover-trigger-width) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-md border border-border/60 bg-popover text-popover-foreground shadow-lg duration-100",
            "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <CommandPrimitive className="flex flex-col">
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2">
              <HugeiconsIcon
                icon={SearchIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground/70"
              />
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search…"
                className="h-8 w-full bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <CommandPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {options.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  {emptyLabel}
                </div>
              ) : (
                <CommandPrimitive.Empty className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  {noResultsLabel}
                </CommandPrimitive.Empty>
              )}
              {options.map((opt) => {
                const active = opt.value === value;
                return (
                  <CommandPrimitive.Item
                    key={opt.value}
                    value={`${opt.label} ${opt.hint ?? ""}`}
                    disabled={opt.disabled}
                    onSelect={() => {
                      onValueChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex cursor-default items-center gap-1.5 rounded-sm px-2 py-1 text-[11.5px] outline-hidden transition-colors",
                      "data-selected:bg-foreground/[0.06] data-selected:text-foreground",
                      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
                      active && "text-primary",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    {opt.hint ? (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {opt.hint}
                      </span>
                    ) : null}
                    {active ? (
                      <HugeiconsIcon
                        icon={CheckmarkCircle02Icon}
                        size={11}
                        strokeWidth={1.75}
                        className="shrink-0 text-primary"
                      />
                    ) : null}
                  </CommandPrimitive.Item>
                );
              })}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
