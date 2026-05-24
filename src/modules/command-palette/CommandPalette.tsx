import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { getBug, getCase, type Bug, type TestCase } from "@/modules/ado";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useStaleCases, useTestPlans } from "@/modules/test-plans";
import {
  useSearchIndex,
  type SearchResult,
} from "@/modules/search/useSearchIndex";
import {
  AlertCircleIcon,
  Bug01Icon,
  Clock01Icon,
  CloudServerIcon,
  CommandLineIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  Settings01Icon,
  TaskDone01Icon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onOpenHistory?: () => void;
  onOpenBug?: (input: { bugId: number; title: string }) => void;
  /** Open a new terminal tab. When the caller doesn't pass a cwd the new
   *  tab inherits the user's source root (resolved on the App.tsx side). */
  onOpenTerminal?: (input?: { cwd?: string | null }) => void;
  /** Open a structured Code Review pane against the user's source root.
   *  No-op when no source dir is set — the callback handles routing the
   *  user to settings in that case. */
  onOpenCodeReview?: () => void;
  /** Absolute path of the user's source directory — surfaced in the
   *  "Open Terminal at source root" command's subtitle. */
  sourceRoot?: string | null;
};

/**
 * Cmd/Ctrl+K palette. Modes:
 *   - "#1234" / bare digits: look up case + bug by id, render previews with
 *     titles fetched in the background (debounced).
 *   - free text: search the in-memory plan/suite/case index built from
 *     whatever the user has loaded in the explorer.
 *   - default: action list + recent plans + settings shortcuts.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenCase,
  onStartGenerator,
  onOpenStaleQueue,
  onOpenTestPlansSidebar,
  onOpenHistory,
  onOpenBug,
  onOpenTerminal,
  onOpenCodeReview,
  sourceRoot,
}: Props) {
  const [query, setQuery] = useState("");
  const { plans, configured, refreshConnection } = useTestPlans();
  const refreshStale = useStaleCases((s) => s.scan);
  const staleCount = useStaleCases((s) => s.cases.length);
  const { search } = useSearchIndex();

  // Keep the plan list warm when the palette is opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      if (!configured) void refreshConnection();
    }
  }, [open, configured, refreshConnection]);

  // Parse "#1234" or bare digits as an id-jump (case + bug).
  // Parse "bug #1234" / "bug 1234" as an id-jump (bug-only).
  const bugOnlyMatch = query.match(/^\s*bug\s*#?(\d{1,9})\s*$/i);
  const idMatch = !bugOnlyMatch && query.match(/^\s*#?(\d{1,9})\s*$/);
  const numericId = idMatch ? Number(idMatch[1]) : null;
  const bugOnlyId = bugOnlyMatch ? Number(bugOnlyMatch[1]) : null;

  const caseLookup = useDebouncedLookup(numericId, getCase);
  const bugLookup = useDebouncedLookup(numericId ?? bugOnlyId, getBug);

  const searchResults = useMemo(() => {
    if (numericId !== null || bugOnlyId !== null) return [];
    return search(query, 30);
  }, [search, query, numericId, bugOnlyId]);

  const run = (fn: () => void | Promise<void>) => {
    onOpenChange(false);
    void fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Type #1234, search a case title, or pick a command…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {numericId !== null ? (
          <CommandGroup heading={`Jump to #${numericId}`}>
            <IdJumpRow
              icon={Search01Icon}
              label={`Open test case #${numericId}`}
              title={caseLookup.data?.title}
              loading={caseLookup.loading}
              error={caseLookup.error}
              onSelect={() =>
                run(() =>
                  onOpenCase({
                    caseId: numericId,
                    title: caseLookup.data
                      ? `#${numericId} · ${caseLookup.data.title}`
                      : `#${numericId}`,
                  }),
                )
              }
            />
            {onOpenBug ? (
              <IdJumpRow
                icon={Bug01Icon}
                label={`Open bug #${numericId}`}
                title={bugLookup.data?.title}
                loading={bugLookup.loading}
                error={bugLookup.error}
                onSelect={() =>
                  run(() =>
                    onOpenBug({
                      bugId: numericId,
                      title: bugLookup.data
                        ? `Bug #${numericId} · ${bugLookup.data.title}`
                        : `Bug #${numericId}`,
                    }),
                  )
                }
              />
            ) : null}
          </CommandGroup>
        ) : bugOnlyId !== null && onOpenBug ? (
          <CommandGroup heading={`Open bug #${bugOnlyId}`}>
            <IdJumpRow
              icon={Bug01Icon}
              label={`Open bug #${bugOnlyId}`}
              title={bugLookup.data?.title}
              loading={bugLookup.loading}
              error={bugLookup.error}
              onSelect={() =>
                run(() =>
                  onOpenBug({
                    bugId: bugOnlyId,
                    title: bugLookup.data
                      ? `Bug #${bugOnlyId} · ${bugLookup.data.title}`
                      : `Bug #${bugOnlyId}`,
                  }),
                )
              }
            />
          </CommandGroup>
        ) : null}

        {searchResults.length > 0 ? (
          <>
            <CommandGroup heading="Matches in loaded plans">
              {searchResults.map((r) => (
                <SearchRow
                  key={`${r.kind}-${r.id}`}
                  result={r}
                  onOpenCase={(id, title) =>
                    run(() => onOpenCase({ caseId: id, title }))
                  }
                  onOpenSuite={(planId, suiteId) =>
                    run(() => onStartGenerator({ planId, suiteId }))
                  }
                  onOpenPlan={(planId) =>
                    run(() => onStartGenerator({ planId }))
                  }
                />
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
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

        {onOpenTerminal || onOpenCodeReview ? (
          <CommandGroup heading="Developer">
            {onOpenCodeReview ? (
              <CommandItem
                value="open-code-review"
                onSelect={() => run(() => onOpenCodeReview())}
              >
                <HugeiconsIcon icon={Search01Icon} size={12} strokeWidth={1.75} />
                <div className="flex min-w-0 flex-col">
                  <span>Review my changes</span>
                  {sourceRoot ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      Streaming review of your branch diff · {sourceRoot}
                    </span>
                  ) : (
                    <span className="text-[10.5px] text-muted-foreground/70">
                      Set a source directory in Settings first
                    </span>
                  )}
                </div>
              </CommandItem>
            ) : null}
            {onOpenTerminal ? (
              <CommandItem
                value="open-terminal"
                onSelect={() => run(() => onOpenTerminal())}
              >
                <HugeiconsIcon
                  icon={CommandLineIcon}
                  size={12}
                  strokeWidth={1.75}
                />
                <div className="flex min-w-0 flex-col">
                  <span>Open Terminal</span>
                  {sourceRoot ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {sourceRoot}
                    </span>
                  ) : (
                    <span className="text-[10.5px] text-muted-foreground/70">
                      Set a source directory in Settings to land here
                    </span>
                  )}
                </div>
              </CommandItem>
            ) : null}
            {onOpenTerminal ? (
              <CommandItem
                value="open-terminal-default"
                onSelect={() => run(() => onOpenTerminal({ cwd: null }))}
              >
                <HugeiconsIcon
                  icon={CommandLineIcon}
                  size={12}
                  strokeWidth={1.75}
                />
                <div className="flex min-w-0 flex-col">
                  <span>Open Terminal (default directory)</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    Launches in the app's process cwd — ignore source root
                  </span>
                </div>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

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
          {onOpenHistory ? (
            <CommandItem
              value="open-history"
              onSelect={() => run(onOpenHistory)}
            >
              <HugeiconsIcon icon={Clock01Icon} size={12} strokeWidth={1.75} />
              Open Generation history
            </CommandItem>
          ) : null}
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

function IdJumpRow({
  icon,
  label,
  title,
  loading,
  error,
  onSelect,
}: {
  icon: typeof Search01Icon;
  label: string;
  title: string | undefined;
  loading: boolean;
  error: string | null;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {loading ? (
          <Skeleton className="mt-0.5 h-2.5 w-32" />
        ) : title ? (
          <span className="truncate text-[10.5px] text-muted-foreground">
            {title}
          </span>
        ) : error ? (
          <span className="text-[10.5px] text-muted-foreground/60">
            (couldn't load preview)
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
}

function SearchRow({
  result,
  onOpenCase,
  onOpenSuite,
  onOpenPlan,
}: {
  result: SearchResult;
  onOpenCase: (id: number, title: string) => void;
  onOpenSuite: (planId: number, suiteId: number) => void;
  onOpenPlan: (planId: number) => void;
}) {
  if (result.kind === "case") {
    return (
      <CommandItem
        value={`case-${result.id}-${result.title}`}
        onSelect={() =>
          onOpenCase(result.id, `#${result.id} · ${result.title}`)
        }
      >
        <HugeiconsIcon icon={Search01Icon} size={12} strokeWidth={1.75} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{result.title}</span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {result.planName} › {result.suiteName}
          </span>
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          #{result.id}
        </span>
      </CommandItem>
    );
  }
  if (result.kind === "suite") {
    return (
      <CommandItem
        value={`suite-${result.id}-${result.title}`}
        onSelect={() => onOpenSuite(result.planId, result.id)}
      >
        <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{result.title}</span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {result.planName} · open in generator
          </span>
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          #{result.id}
        </span>
      </CommandItem>
    );
  }
  return (
    <CommandItem
      value={`plan-${result.id}-${result.title}`}
      onSelect={() => onOpenPlan(result.id)}
    >
      <HugeiconsIcon icon={TaskDone01Icon} size={12} strokeWidth={1.75} />
      <span className="truncate">{result.title}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">
        #{result.id}
      </span>
    </CommandItem>
  );
}

/** Debounced ADO lookup. Refires when the id changes; cancels stale promises
 *  via a ref-counted token so a slow earlier response can't overwrite a
 *  fast later one. Used by the palette to surface titles for numeric input. */
function useDebouncedLookup<T extends TestCase | Bug>(
  id: number | null,
  fetcher: (id: number) => Promise<T>,
): { data: T | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: false, error: null });
  const tokenRef = useRef(0);

  useEffect(() => {
    if (id === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const token = ++tokenRef.current;
    setState((s) => ({ data: s.data, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      void fetcher(id)
        .then((data) => {
          if (token !== tokenRef.current) return;
          setState({ data, loading: false, error: null });
        })
        .catch((e) => {
          if (token !== tokenRef.current) return;
          setState({
            data: null,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [id, fetcher]);

  return state;
}
