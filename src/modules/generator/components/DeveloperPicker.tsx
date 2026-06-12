import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
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
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TeamMember } from "@/modules/ado";

type Props = {
  /** Currently-assigned identity (a uniqueName/email or a raw display name).
   *  Null = unassigned. */
  value: string | null;
  /** Project team members to choose from. */
  members: TeamMember[];
  loading?: boolean;
  /** Fired with the chosen identity's uniqueName (or null to clear). */
  onChange: (assignedTo: string | null) => void;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  className?: string;
};

/**
 * Searchable developer picker for assigning bugs in the review phase. Same
 * cmdk-in-a-Popover pattern as BranchPicker so it reads identically to the
 * branch / suite pickers elsewhere — fuzzy search, capped height, an explicit
 * "Unassigned" reset at the top.
 */
export function DeveloperPicker({
  value,
  members,
  loading,
  onChange,
  placeholder = "Assign a developer…",
  className,
}: Props) {
  const [open, setOpen] = useState(false);

  // Resolve the stored identity to a display name when we can match it to a
  // known member; otherwise show the raw value (a name typed before the member
  // list loaded, or a person no longer on the team).
  const label = useMemo(() => {
    if (!value) return placeholder;
    const hit = members.find(
      (m) => m.uniqueName === value || m.displayName === value,
    );
    return hit?.displayName ?? value;
  }, [value, members, placeholder]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Assigned developer"
          className={cn(
            // Compact inline chip — reads as an editable metadata value next to
            // the row's 10.5px labels, not a chunky standalone button. Matches
            // the case/bug ref-chip vocabulary used elsewhere on this page.
            "inline-flex max-w-[200px] items-center gap-1 rounded-sm border border-border/55 bg-foreground/[0.04] px-1.5 py-0.5 text-[10.5px] leading-none transition-colors hover:bg-foreground/[0.08]",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/70"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-64 p-0"
      >
        <Command>
          <CommandInput placeholder="Search people…" className="h-8 text-[12px]" />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>
              {loading
                ? "Loading people…"
                : "No people found — check your ADO connection."}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__unassigned__"
                data-checked={!value}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="py-1.5 text-muted-foreground"
              >
                Unassigned
              </CommandItem>
            </CommandGroup>
            {members.length > 0 ? (
              <CommandGroup heading="People">
                {members.map((m) => {
                  const id = m.uniqueName || m.displayName;
                  return (
                    <CommandItem
                      key={id}
                      value={`${m.displayName} ${m.uniqueName}`}
                      data-checked={value === id || value === m.displayName}
                      onSelect={() => {
                        onChange(id);
                        setOpen(false);
                      }}
                      className="flex-col items-start gap-0 py-1.5"
                    >
                      <span className="truncate text-[12px]">{m.displayName}</span>
                      {m.uniqueName && m.uniqueName !== m.displayName ? (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {m.uniqueName}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
