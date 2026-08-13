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
import { adoErrorMessage, listRepos, toAdoError, type RepoRef } from "@/modules/ado";
import { useEffect, useMemo, useState } from "react";

type Props = {
  /** ADO repo id currently bound, or null when this repo isn't linked. */
  value: string | null;
  /** Picking a repo passes it whole (the caller needs name + project, not just
   *  the id); "Not linked" passes null. */
  onChange: (repo: RepoRef | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Trigger tooltip. Required — this is an opaque control, and the tooltip is
   *  where "what happens if I click" lives. */
  tooltip: React.ReactNode;
  /** The trigger element. Rendered `asChild`, so it must forward props+ref. */
  children: React.ReactNode;
};

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; repos: RepoRef[] }
  | { kind: "error"; message: string };

/**
 * Picks the Azure DevOps repository a workspace repo publishes links into.
 *
 * Same cmdk-in-a-Popover shape as `BranchPicker` / `DeveloperPicker`, grouped by
 * project because `ado_list_repos` is org-wide: two projects can each hold a
 * `shared` repo, and the project is half of what makes a code link resolve.
 *
 * The list is fetched on first open rather than on mount — every repo row hosts
 * one of these, and the org's repo list is worth exactly one request per time
 * someone actually opens it.
 */
export function AdoRepoPicker({
  value,
  onChange,
  open,
  onOpenChange,
  tooltip,
  children,
}: Props) {
  const [state, setState] = useState<ListState | null>(null);

  useEffect(() => {
    if (!open) return;
    // Keep a loaded list across re-opens; retry only what failed.
    if (state && state.kind !== "error") return;
    let cancelled = false;
    setState({ kind: "loading" });
    void listRepos()
      .then((repos) => {
        if (!cancelled) setState({ kind: "ready", repos });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ kind: "error", message: adoErrorMessage(toAdoError(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groups = useMemo(() => {
    if (state?.kind !== "ready") return [];
    const byProject = new Map<string, RepoRef[]>();
    for (const repo of state.repos) {
      const key = repo.project?.trim() || "Other projects";
      const list = byProject.get(key);
      if (list) list.push(repo);
      else byProject.set(key, [repo]);
    }
    return [...byProject.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([project, repos]) => ({
        project,
        repos: [...repos].sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [state]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{children}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" sideOffset={4} className="w-[300px] p-0">
        {state?.kind === "loading" || state == null ? (
          <div className="flex flex-col gap-1.5 p-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : state.kind === "error" ? (
          <p className="px-3 py-4 text-[11.5px] leading-relaxed text-muted-foreground">
            {state.message}
          </p>
        ) : (
          <Command>
            <CommandInput placeholder="Search repositories…" />
            <CommandList className="max-h-[280px]">
              <CommandEmpty>No repositories match.</CommandEmpty>
              {value ? (
                <CommandGroup>
                  <CommandItem
                    value="__not-linked__"
                    onSelect={() => {
                      onChange(null);
                      onOpenChange(false);
                    }}
                    className="text-muted-foreground"
                  >
                    Not linked
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {groups.map((group) => (
                <CommandGroup key={group.project} heading={group.project}>
                  {group.repos.map((repo) => (
                    <CommandItem
                      key={repo.id}
                      // Search matches the project too, so typing a project
                      // name narrows to its repos.
                      value={`${group.project} ${repo.name}`}
                      data-checked={repo.id === value}
                      onSelect={() => {
                        onChange(repo);
                        onOpenChange(false);
                      }}
                    >
                      <span className="truncate font-mono text-[11.5px]">
                        {repo.name}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
