import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useTestPlans } from "@/modules/test-plans/hooks/useTestPlans";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  RefreshIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import {
  adoErrorMessage,
  getConnection,
  listProjects,
  setConnection,
  toAdoError,
  type AdoError,
  type ProjectRef,
} from ".";

type Props = {
  /** Project name from the in-memory connection. Empty string before hydrate. */
  currentProject: string;
};

/**
 * Inline project switcher anchored to the explorer header. Avoids the
 * round-trip to Settings → Azure DevOps → Project select that the picker
 * previously required. Switching:
 *   - writes the new project to the persisted connection (keeps the PAT)
 *   - resets the in-memory plans / suites cache so we don't paint stale data
 *   - refreshes the connection probe so the new project's plans load
 */
export function ProjectSwitcher({ currentProject }: Props) {
  const reset = useTestPlans((s) => s.reset);
  const refreshConnection = useTestPlans((s) => s.refreshConnection);

  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AdoError | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProjects();
      list.sort((a, b) => a.name.localeCompare(b.name));
      setProjects(list);
    } catch (e) {
      setError(toAdoError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch lazily — only when the user opens the dropdown for the first time
  // in this mount, and refetch whenever they re-open (cheap, ~kb response).
  useEffect(() => {
    if (open) void fetchProjects();
  }, [open, fetchProjects]);

  const switchTo = useCallback(
    async (name: string) => {
      if (name === currentProject) {
        setOpen(false);
        return;
      }
      setSwitching(name);
      setError(null);
      try {
        // Pull the existing connection so we keep org URL + default branch
        // exactly as the user set them — switching project shouldn't
        // accidentally rewrite either.
        const curr = await getConnection();
        await setConnection({
          orgUrl: curr.orgUrl,
          project: name,
          defaultTrackingBranch:
            curr.defaultTrackingBranch && curr.defaultTrackingBranch.length > 0
              ? curr.defaultTrackingBranch
              : "main",
          // Omit pat → keeps the stored token untouched.
        });
        reset();
        await refreshConnection();
        setOpen(false);
      } catch (e) {
        setError(toAdoError(e));
      } finally {
        setSwitching(null);
      }
    },
    [currentProject, reset, refreshConnection],
  );

  const trigger = (
    <button
      type="button"
      className={cn(
        "group/project-trigger inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 text-[12px] font-medium text-foreground/90 outline-none transition-colors",
        "hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]",
        "data-[state=open]:bg-foreground/[0.08]",
      )}
    >
      <span className="min-w-0 truncate">
        {currentProject || "No project"}
      </span>
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        size={10}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/project-trigger:rotate-180"
      />
    </button>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-[220px]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Switch project</span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              void fetchProjects();
            }}
            aria-label="Refresh project list"
            className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={10}
              strokeWidth={1.75}
              className={loading ? "animate-spin" : ""}
            />
          </button>
        </DropdownMenuLabel>

        {loading && projects.length === 0 ? (
          <div className="flex flex-col gap-1 px-1.5 py-1.5">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : null}

        {error ? (
          <div className="px-2 py-1.5 text-[10.5px] leading-relaxed text-destructive">
            {adoErrorMessage(error)}
          </div>
        ) : null}

        {!loading && !error && projects.length === 0 ? (
          <div className="px-2 py-1.5 text-[10.5px] text-muted-foreground">
            No projects accessible with this PAT.
          </div>
        ) : null}

        {projects.map((p) => {
          const active = p.name === currentProject;
          const busy = switching === p.name;
          return (
            <DropdownMenuItem
              key={p.id}
              onSelect={(e) => {
                e.preventDefault();
                void switchTo(p.name);
              }}
              className={cn(
                "justify-between",
                active && "text-primary",
                busy && "opacity-70",
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              {active ? (
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  size={11}
                  strokeWidth={1.75}
                  className="shrink-0 text-primary"
                />
              ) : busy ? (
                <span className="font-mono text-[9.5px] text-muted-foreground">
                  …
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setOpen(false);
            void openSettingsWindow("azure-devops");
          }}
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Connection settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
