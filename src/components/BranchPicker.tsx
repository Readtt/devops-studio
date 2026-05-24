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
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";

type Props = {
  value: string;
  /** Full branch list. Local + remote. The picker promotes
   *  main/master/develop to the top automatically. */
  branches: string[];
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Placeholder shown when `value` is empty. Default "Select a branch…".
   *  Pass a domain-specific hint (e.g. "Detecting base…") for context. */
  placeholder?: string;
  /** Optional sentinel option — used by the ADO settings panel to expose
   *  the "$current" → resolve at scan time behavior. Rendered above the
   *  branch list with a distinct label. */
  sentinel?: {
    value: string;
    label: string;
    description: string;
  };
  /** Trigger size — small for inline use in headers, medium for setting
   *  rows. Affects only the trigger button; the popover is the same. */
  size?: "sm" | "md";
  /** Accessible label. */
  ariaLabel?: string;
  /** Width of the trigger button. Default 'auto' lets the label set it;
   *  pass a number (px) for a fixed-width inline placement. */
  triggerWidth?: number | "auto";
  className?: string;
};

const PRIORITY = ["main", "master", "develop"];

/**
 * Branch picker with fuzzy search, capped to ~280px height so the
 * dropdown stays readable on long branch lists. Used by:
 *   - Code Review pane (base branch)
 *   - Azure DevOps settings (tracking branch)
 *
 * Why a Combobox instead of plain Select: large monorepos can have
 * hundreds of branches. A Select with no search forces the user to
 * scroll past everything they don't want, and tall Selects swallow the
 * viewport. cmdk's fuzzy match makes typing two characters of a branch
 * name enough to find it.
 */
export function BranchPicker({
  value,
  branches,
  onChange,
  disabled,
  placeholder = "Select a branch…",
  sentinel,
  size = "sm",
  ariaLabel = "Branch",
  triggerWidth = "auto",
  className,
}: Props) {
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    // Priority bases first, in their canonical order.
    for (const p of PRIORITY) {
      if (branches.includes(p) && !seen.has(p)) {
        out.push(p);
        seen.add(p);
      }
    }
    // Then the saved value (if it's somehow off the list — stale config),
    // then everything else alphabetically.
    if (value && !seen.has(value) && !sentinel?.value.includes(value)) {
      out.push(value);
      seen.add(value);
    }
    for (const b of [...branches].sort()) {
      if (!seen.has(b)) {
        out.push(b);
        seen.add(b);
      }
    }
    return out;
  }, [branches, value, sentinel]);

  const displayValue = sentinel && value === sentinel.value
    ? sentinel.label
    : value || placeholder;

  const triggerH = size === "md" ? "h-8" : "h-6";
  const triggerText = size === "md" ? "text-[12px]" : "text-[11.5px]";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          style={triggerWidth === "auto" ? undefined : { width: triggerWidth }}
          className={cn(
            "inline-flex w-fit max-w-full items-center gap-1.5 rounded-md px-2 transition-colors",
            triggerH,
            triggerText,
            "border border-transparent hover:bg-foreground/[0.04]",
            "data-[state=open]:bg-foreground/[0.04]",
            "disabled:cursor-not-allowed disabled:opacity-50",
            triggerWidth !== "auto" && "justify-between",
            className,
          )}
        >
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={size === "md" ? 13 : 12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate font-mono text-foreground/85">
            {displayValue}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/70"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        // Override popover's default rounded-3xl + p-4 — too lush for a
        // picker. Cap height so even monorepos with 200 branches don't
        // swallow the viewport.
        className="w-72 gap-0 rounded-lg p-0"
      >
        <Command>
          <CommandInput
            placeholder="Search branches…"
            className="h-8 text-[12px]"
          />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>No branches match.</CommandEmpty>
            {sentinel ? (
              <CommandGroup>
                <CommandItem
                  value={`__${sentinel.label}__`}
                  data-checked={value === sentinel.value}
                  onSelect={() => {
                    onChange(sentinel.value);
                    setOpen(false);
                  }}
                  className="flex-col items-start gap-0.5 py-2"
                >
                  <span className="text-[12px] font-medium">
                    {sentinel.label}
                  </span>
                  <span className="text-[10.5px] font-normal text-muted-foreground">
                    {sentinel.description}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup heading={sentinel ? "Branches" : undefined}>
              {sorted.map((b) => (
                <CommandItem
                  key={b}
                  value={b}
                  data-checked={value === b}
                  onSelect={() => {
                    onChange(b);
                    setOpen(false);
                  }}
                  className="py-1.5"
                >
                  <span className="truncate font-mono text-[12px]">{b}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
