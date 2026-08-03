import { useEffect, useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { TypeTag } from "@/modules/ado/components/WorkItemMention";
import {
  getWorkItem,
  listRequirementTypes,
  searchWorkItems,
  type WorkItemRef,
} from "@/modules/ado";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  value: WorkItemRef | null;
  onChange: (item: WorkItemRef | null) => void;
  /** Scope the search, e.g. to the plan's area path. */
  areaPath?: string | null;
  disabled?: boolean;
  className?: string;
  /** Lets the owning dialog focus this on open. Without it, focus falls back
   *  to the first tabbable element — which in NewSuiteDialog is the "Static"
   *  mode toggle, so a reflexive Enter switched the user straight out of
   *  requirement mode. */
  triggerRef?: React.Ref<HTMLButtonElement>;
};

/**
 * Pick the work item a requirement-based suite will track.
 *
 * Same cmdk-in-a-Popover shape as BranchPicker / DeveloperPicker so it reads
 * like every other picker in the app. The list is restricted to the project's
 * Requirement category (User Story / PBI / Requirement / Issue, depending on
 * the process template) because Azure DevOps rejects anything else — offering
 * a Task here would just produce a server error the user can't act on.
 */
export function RequirementPicker({
  value,
  onChange,
  areaPath,
  disabled,
  className,
  triggerRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<string[] | null>(null);
  const [typesFailed, setTypesFailed] = useState(false);
  const [results, setResults] = useState<WorkItemRef[]>([]);
  const [loading, setLoading] = useState(false);

  // Resolve the project's requirement types once — they're process-template
  // dependent, so nothing here is hardcoded.
  useEffect(() => {
    let alive = true;
    listRequirementTypes()
      .then((t) => {
        if (!alive) return;
        setTypes(t);
        setTypesFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        // Fail OPEN (search every type) rather than showing an empty picker —
        // but say so, because ADO rejects a suite built on a non-requirement
        // type and the user would otherwise only find out at create time.
        setTypes([]);
        setTypesFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // `types === null` means the lookup is still in flight — the search effect
  // below hasn't started, so `loading` is still false and without this the
  // list would show "No matching requirements." before it ever searched.
  const busy = loading || types === null;
  const unfiltered = types !== null && types.length === 0;

  // Debounced search. A numeric query resolves the exact id, since ADO's title
  // search can't match ids — same rule the `#mention` picker uses.
  useEffect(() => {
    if (!open || types === null) return;
    let alive = true;
    setLoading(true);
    const q = query.trim();
    const t = setTimeout(() => {
      const run = /^\d+$/.test(q)
        ? getWorkItem(Number(q)).then((wi) =>
            // Keep it only if it's actually a requirement type; otherwise the
            // create call would fail after the user picked it.
            types.length === 0 || types.includes(wi.workItemType) ? [wi] : [],
          )
        : searchWorkItems({
            areaPath: areaPath ?? null,
            query: q || null,
            top: 20,
            workItemTypes: types,
          });
      void run
        .then((items) => alive && setResults(items))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query, areaPath, types]);

  const label = useMemo(() => {
    if (!value) return "Search work items…";
    return `#${value.id} — ${value.title}`;
  }, [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          id="new-suite-requirement"
          type="button"
          disabled={disabled}
          aria-label="Requirement"
          className={cn(
            // `min-w-0` + `overflow-hidden`: the label is a work-item title,
            // which is routinely long enough to blow out whatever lays this
            // button out unless it's explicitly allowed to shrink.
            "flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-input bg-transparent px-2.5 text-left text-[12px] transition-colors hover:bg-foreground/[0.03] disabled:cursor-not-allowed disabled:opacity-50",
            !value && "text-muted-foreground",
            className,
          )}
        >
          {value ? <TypeTag type={value.workItemType} compact /> : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by title, or type an id…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[280px]">
            {unfiltered ? (
              <div className="border-b border-border/50 px-2.5 py-2 text-[11px] text-muted-foreground">
                {typesFailed
                  ? "Couldn't read this project's requirement types, so every work-item type is listed. Azure DevOps will reject a suite built on a type that isn't a requirement."
                  : "This project reports no requirement work-item types, so every type is listed. Azure DevOps will reject a suite built on a type that isn't a requirement."}
              </div>
            ) : null}
            {busy && results.length === 0 ? (
              <div className="flex flex-col gap-1 p-1.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-7 w-full rounded-md" />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className="px-2.5 py-3 text-[11px] text-muted-foreground">
                  No matching requirements.
                </CommandEmpty>
                <CommandGroup>
                  {results.map((wi) => (
                    <CommandItem
                      key={wi.id}
                      value={String(wi.id)}
                      onSelect={() => {
                        onChange(wi);
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <TypeTag type={wi.workItemType} />
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        #{wi.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">
                        {wi.title}
                      </span>
                      {wi.state ? (
                        <span className="shrink-0 text-[10.5px] text-muted-foreground">
                          {wi.state}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
