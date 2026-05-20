import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { getCase } from "@/modules/ado";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useStaleCases, useTestPlans } from "@/modules/test-plans";
import {
  AlertCircleIcon,
  CloudServerIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  Settings01Icon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onStartGenerator: (input?: {
    planId?: number | null;
    suiteId?: number | null;
  }) => void;
  onOpenStaleQueue: () => void;
  onOpenTestPlansSidebar: () => void;
};

/**
 * Cmd/Ctrl+K palette. Three modes:
 *   - default: action list + recent plans
 *   - search "#1234": jump to a case by ID (validates with ado_get_case)
 *   - search free text: cmdk filters items by their `value` substring
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenCase,
  onStartGenerator,
  onOpenStaleQueue,
  onOpenTestPlansSidebar,
}: Props) {
  const [query, setQuery] = useState("");
  const { plans, configured, refreshConnection } = useTestPlans();
  const refreshStale = useStaleCases((s) => s.scan);
  const staleCount = useStaleCases((s) => s.cases.length);

  // Keep the plan list warm when the palette is opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      if (!configured) void refreshConnection();
    }
  }, [open, configured, refreshConnection]);

  // Parse "#1234" or bare digits as an id-jump.
  const idMatch = query.match(/^\s*#?(\d{1,9})\s*$/);

  const run = (fn: () => void | Promise<void>) => {
    onOpenChange(false);
    void fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Type a command, paste #1234, or search a plan…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {idMatch ? (
          <CommandGroup heading="Open case">
            <CommandItem
              value={`open-case-${idMatch[1]}`}
              onSelect={() =>
                run(async () => {
                  const id = Number(idMatch[1]);
                  try {
                    const c = await getCase(id);
                    onOpenCase({ caseId: id, title: `#${id} · ${c.title}` });
                  } catch {
                    onOpenCase({ caseId: id, title: `#${id}` });
                  }
                })
              }
            >
              <HugeiconsIcon icon={Search01Icon} size={12} strokeWidth={1.75} />
              Open test case #{idMatch[1]}
            </CommandItem>
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Generator">
          <CommandItem
            value="new-session"
            onSelect={() => run(() => onStartGenerator())}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.75} />
            New test case generation session
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Test Plans">
          <CommandItem
            value="open-test-plans"
            onSelect={() => run(onOpenTestPlansSidebar)}
          >
            <HugeiconsIcon icon={TaskDone01Icon} size={12} strokeWidth={1.75} />
            Open Test Plans sidebar
          </CommandItem>
          <CommandItem
            value="refresh-stale"
            onSelect={() => run(() => refreshStale())}
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Refresh staleness scan
          </CommandItem>
          <CommandItem
            value="open-stale-queue"
            onSelect={() => run(onOpenStaleQueue)}
          >
            <HugeiconsIcon
              icon={AlertCircleIcon}
              size={12}
              strokeWidth={1.75}
            />
            Open Stale queue
            {staleCount > 0 ? (
              <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300">
                {staleCount}
              </span>
            ) : null}
          </CommandItem>
        </CommandGroup>

        {plans.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Generate for plan">
              {plans.slice(0, 10).map((p) => (
                <CommandItem
                  key={p.id}
                  value={`plan-${p.id}-${p.name}`}
                  onSelect={() => run(() => onStartGenerator({ planId: p.id }))}
                >
                  <HugeiconsIcon
                    icon={TaskDone01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  {p.name}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    #{p.id}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem
            value="settings-ado"
            onSelect={() => run(() => openSettingsWindow("azure-devops"))}
          >
            <HugeiconsIcon
              icon={CloudServerIcon}
              size={12}
              strokeWidth={1.75}
            />
            Azure DevOps settings
          </CommandItem>
          <CommandItem
            value="settings-general"
            onSelect={() => run(() => openSettingsWindow("general"))}
          >
            <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
            Open settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
