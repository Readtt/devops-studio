import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { adoErrorMessage, getConnection, markForReview } from "@/modules/ado";
import { useTestPlans, type SuiteLoad } from "./hooks/useTestPlans";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ExternalLink,
  Link01Icon,
  PlusSignIcon,
  RefreshIcon,
  Settings01Icon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SuiteRef, TestCaseRef, TestPlanRef } from "@/modules/ado";

type Props = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onStartGenerator: (input?: {
    planId?: number | null;
    suiteId?: number | null;
  }) => void;
  /** Case id currently shown in the workspace, so its row can be highlighted. */
  activeCaseId?: number | null;
};

type ConnInfo = { orgUrl: string; project: string };

const FILTER_DEBOUNCE_MS = 250;

export function TestPlansPanel({ onOpenCase, onStartGenerator, activeCaseId }: Props) {
  const {
    initialized,
    configured,
    plans,
    plansLoading,
    plansError,
    bySuite,
    refreshConnection,
    refreshPlans,
    loadSuites,
    loadSuiteCases,
    cancelPlanLoads,
  } = useTestPlans();
  const [expandedPlans, setExpandedPlans] = useState<Set<number>>(new Set());
  const [expandedSuites, setExpandedSuites] = useState<Set<number>>(new Set());
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState(""); // debounced
  const [conn, setConn] = useState<ConnInfo | null>(null);

  useEffect(() => {
    if (!initialized) {
      void refreshConnection();
    }
  }, [initialized, refreshConnection]);

  // Once configured, grab the org/project so we can build "Open in ADO" URLs
  // without re-fetching on every menu open.
  useEffect(() => {
    if (!configured) {
      setConn(null);
      return;
    }
    void getConnection()
      .then((c) =>
        setConn({ orgUrl: c.orgUrl.replace(/\/$/, ""), project: c.project }),
      )
      .catch(() => setConn(null));
  }, [configured]);

  // Debounce the filter input — typing fast no longer triggers per-keystroke
  // matcher rebuilds + eager-load cascades.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setFilter(filterDraft);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [filterDraft]);

  const needle = useMemo(() => filter.trim().toLowerCase(), [filter]);
  const matches = useMemo(() => {
    if (!needle) return null;
    return (s: string) => s.toLowerCase().includes(needle);
  }, [needle]);

  // Eager-load: when there's an active needle, expand every plan in the tree
  // and trigger loadSuites/loadSuiteCases so a case-title-only match isn't
  // hidden behind a collapsed plan that the user has to click open.
  useEffect(() => {
    if (!needle || plans.length === 0) return;
    for (const p of plans) {
      // Plan name already matches — don't force its subtree open; the user
      // can drill down themselves.
      if (p.name.toLowerCase().includes(needle)) continue;
      void loadSuites(p.id);
      const sl = bySuite.get(p.id);
      if (!sl) continue;
      for (const s of sl.suites) {
        if (s.name.toLowerCase().includes(needle)) continue;
        void loadSuiteCases(p.id, s.id);
      }
    }
    // bySuite is intentionally NOT in the dep list — we don't want to refire
    // every time bySuite mutates (which is on every load completion). The
    // needle change is what should drive eager-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, plans, loadSuites, loadSuiteCases]);

  // When the filter is active, show subtrees regardless of expandedPlans /
  // expandedSuites so the user can see *what* matched.
  const forceExpand = needle.length > 0;

  const togglePlan = useCallback(
    (id: number) => {
      setExpandedPlans((curr) => {
        const next = new Set(curr);
        if (next.has(id)) {
          next.delete(id);
          cancelPlanLoads(id);
        } else {
          next.add(id);
          void loadSuites(id);
        }
        return next;
      });
    },
    [cancelPlanLoads, loadSuites],
  );

  const toggleSuite = useCallback(
    (planId: number, suiteId: number) => {
      setExpandedSuites((curr) => {
        const next = new Set(curr);
        if (next.has(suiteId)) {
          next.delete(suiteId);
        } else {
          next.add(suiteId);
          void loadSuiteCases(planId, suiteId);
        }
        return next;
      });
    },
    [loadSuiteCases],
  );

  if (!initialized) {
    return <PanelMessage>Loading…</PanelMessage>;
  }
  if (!configured) {
    return (
      <PanelMessage>
        <p className="text-[12px] font-medium text-foreground/85">
          Not connected to Azure DevOps
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Set your organization URL, project, and PAT in Settings to browse
          plans and cases.
        </p>
        <Button
          size="sm"
          className="mt-2"
          onClick={() => void openSettingsWindow("azure-devops")}
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Open settings
        </Button>
      </PanelMessage>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <input
          value={filterDraft}
          onChange={(e) => setFilterDraft(e.target.value)}
          placeholder="Filter plans, suites, cases…"
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label="Refresh plans"
              onClick={() => void refreshPlans()}
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                size={12}
                strokeWidth={1.75}
                className={plansLoading ? "animate-spin" : ""}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Refetch the plan list from Azure DevOps
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              className="h-6 px-1.5 text-[10.5px]"
              onClick={() => onStartGenerator()}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
              Generate
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Open the Generator to draft test cases from a spec
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {plansError ? (
          <div className="px-3 py-2 text-[11px] text-destructive">
            {adoErrorMessage(plansError)}
          </div>
        ) : null}
        {!plansLoading && plans.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            No test plans found in this project.
          </div>
        ) : null}
        <ul className="px-1 py-1">
          {plans.map((p) => (
            <PlanRow
              key={p.id}
              plan={p}
              expanded={forceExpand || expandedPlans.has(p.id)}
              onToggle={() => togglePlan(p.id)}
              matches={matches}
              expandedSuites={expandedSuites}
              forceExpand={forceExpand}
              onToggleSuite={(sid) => toggleSuite(p.id, sid)}
              onOpenCase={onOpenCase}
              onStartGenerator={onStartGenerator}
              bySuite={bySuite}
              loadSuites={loadSuites}
              loadSuiteCases={loadSuiteCases}
              conn={conn}
              activeCaseId={activeCaseId ?? null}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- Plan row ---------------------------------------------------------------

type PlanRowProps = {
  plan: TestPlanRef;
  expanded: boolean;
  onToggle: () => void;
  matches: ((s: string) => boolean) | null;
  expandedSuites: Set<number>;
  forceExpand: boolean;
  onToggleSuite: (suiteId: number) => void;
  onOpenCase: Props["onOpenCase"];
  onStartGenerator: Props["onStartGenerator"];
  bySuite: Map<number, SuiteLoad>;
  loadSuites: (planId: number) => Promise<void>;
  loadSuiteCases: (planId: number, suiteId: number) => Promise<void>;
  conn: ConnInfo | null;
  activeCaseId: number | null;
};

function PlanRow({
  plan,
  expanded,
  onToggle,
  matches,
  expandedSuites,
  forceExpand,
  onToggleSuite,
  onOpenCase,
  onStartGenerator,
  bySuite,
  loadSuites,
  conn,
  activeCaseId,
}: PlanRowProps) {
  const data = bySuite.get(plan.id);
  const planWebUrl = conn
    ? `${conn.orgUrl}/${encodeURIComponent(conn.project)}/_testPlans/define?planId=${plan.id}`
    : null;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-left text-[12px] hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              size={11}
              strokeWidth={1.75}
            />
            <span className="truncate font-medium">{plan.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-[12px]">
          <ContextMenuItem onSelect={() => void loadSuites(plan.id)}>
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Refresh suites
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onStartGenerator({ planId: plan.id, suiteId: null })}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.75} />
            Generate cases for plan
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!planWebUrl}
            onSelect={() => planWebUrl && void openUrl(planWebUrl)}
          >
            <HugeiconsIcon
              icon={ExternalLink}
              size={12}
              strokeWidth={1.75}
            />
            Open in Azure DevOps
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded ? (
        <ul className="ml-3 border-l border-border/40 pl-1.5">
          {data?.loading ? (
            <li className="flex flex-col gap-1.5 px-2 py-1.5">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ) : null}
          {data?.error ? (
            <li className="px-2 py-1 text-[11px] text-destructive">
              {adoErrorMessage(data.error)}
            </li>
          ) : null}
          {data?.suites
            .filter((s) => !matches || matches(s.name) || hasMatchingCase(data, s.id, matches))
            .map((s) => (
              <SuiteRow
                key={s.id}
                planId={plan.id}
                suite={s}
                expanded={forceExpand || expandedSuites.has(s.id)}
                onToggle={() => onToggleSuite(s.id)}
                suiteLoad={data}
                matches={matches}
                onOpenCase={onOpenCase}
                onStartGenerator={onStartGenerator}
                conn={conn}
                activeCaseId={activeCaseId}
              />
            ))}
        </ul>
      ) : null}
    </li>
  );
}

function hasMatchingCase(
  load: SuiteLoad,
  suiteId: number,
  matches: ((s: string) => boolean) | null,
): boolean {
  if (!matches) return true;
  const cases = load.suiteCases.get(suiteId)?.cases;
  if (!cases) return true; // not yet loaded — show optimistically
  return cases.some((c) => matches(c.title));
}

// --- Suite row --------------------------------------------------------------

type SuiteRowProps = {
  planId: number;
  suite: SuiteRef;
  expanded: boolean;
  onToggle: () => void;
  suiteLoad: SuiteLoad;
  matches: ((s: string) => boolean) | null;
  onOpenCase: Props["onOpenCase"];
  onStartGenerator: Props["onStartGenerator"];
  conn: ConnInfo | null;
  activeCaseId: number | null;
};

function SuiteRow({
  planId,
  suite,
  expanded,
  onToggle,
  suiteLoad,
  matches,
  onOpenCase,
  onStartGenerator,
  conn,
  activeCaseId,
}: SuiteRowProps) {
  const sc = suiteLoad.suiteCases.get(suite.id);
  const loading = sc?.loading ?? false;
  const cases = sc?.cases ?? null;
  const error = sc?.error ?? null;
  const suiteWebUrl = conn
    ? `${conn.orgUrl}/${encodeURIComponent(
        conn.project,
      )}/_testPlans/define?planId=${planId}&suiteId=${suite.id}`
    : null;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-left text-[11.5px] hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              size={10}
              strokeWidth={1.75}
            />
            <span className="truncate">{suite.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-[12px]">
          <ContextMenuItem
            onSelect={() => void useTestPlans.getState().loadSuiteCases(planId, suite.id)}
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Refresh cases
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              onStartGenerator({ planId, suiteId: suite.id })
            }
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.75} />
            Generate cases for suite
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!suiteWebUrl}
            onSelect={() => suiteWebUrl && void openUrl(suiteWebUrl)}
          >
            <HugeiconsIcon
              icon={ExternalLink}
              size={12}
              strokeWidth={1.75}
            />
            Open in Azure DevOps
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded ? (
        <ul className="ml-3 border-l border-border/40 pl-1.5">
          {loading ? (
            <li className="flex flex-col gap-1.5 px-2 py-1.5">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </li>
          ) : null}
          {error ? (
            <li className="px-2 py-1 text-[10.5px] text-destructive">
              {adoErrorMessage(error)}
            </li>
          ) : null}
          {!loading && cases?.length === 0 ? (
            <li className="px-2 py-1 text-[10.5px] text-muted-foreground">
              No cases in this suite
            </li>
          ) : null}
          {cases
            ?.filter((c) => !matches || matches(c.title))
            .map((c) => (
              <CaseRow
                key={c.id}
                tc={c}
                onOpenCase={onOpenCase}
                onStartGenerator={onStartGenerator}
                planId={planId}
                suiteId={suite.id}
                conn={conn}
                active={activeCaseId === c.id}
              />
            ))}
        </ul>
      ) : null}
    </li>
  );
}

// --- Case row ---------------------------------------------------------------

type CaseRowProps = {
  tc: TestCaseRef;
  onOpenCase: Props["onOpenCase"];
  onStartGenerator: Props["onStartGenerator"];
  planId: number;
  suiteId: number;
  conn: ConnInfo | null;
  active: boolean;
};

function CaseRow({
  tc,
  onOpenCase,
  onStartGenerator,
  planId,
  suiteId,
  conn,
  active,
}: CaseRowProps) {
  const caseWebUrl = conn
    ? `${conn.orgUrl}/${encodeURIComponent(conn.project)}/_workitems/edit/${tc.id}`
    : null;
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const open = () => onOpenCase({ caseId: tc.id, title: `#${tc.id} · ${tc.title}` });

  // When this row becomes the active case (e.g. via the command palette or
  // history pane), scroll it into view so the user can see where they are
  // in the tree.
  useEffect(() => {
    if (active) {
      buttonRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            onClick={open}
            data-active={active || undefined}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-sm border-l-2 border-transparent px-1.5 py-1.5 text-left text-[11px] transition-colors duration-150 hover:bg-foreground/[0.05]",
              active &&
                "border-primary bg-primary/10 text-foreground dark:bg-primary/[0.12]",
            )}
          >
            <HugeiconsIcon
              icon={TaskDone01Icon}
              size={10}
              strokeWidth={1.75}
              className={cn(
                "shrink-0 transition-colors duration-150",
                active ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className={cn("font-mono text-[10px]", active ? "text-primary" : "text-muted-foreground")}>
              #{tc.id}
            </span>
            <span className="truncate">{tc.title}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-[12px]">
          <ContextMenuItem onSelect={open}>
            <HugeiconsIcon
              icon={TaskDone01Icon}
              size={12}
              strokeWidth={1.75}
            />
            Open
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!caseWebUrl}
            onSelect={() => caseWebUrl && void openUrl(caseWebUrl)}
          >
            <HugeiconsIcon
              icon={ExternalLink}
              size={12}
              strokeWidth={1.75}
            />
            Open in Azure DevOps
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!caseWebUrl}
            onSelect={() => {
              if (!caseWebUrl) return;
              void navigator.clipboard.writeText(caseWebUrl);
            }}
          >
            <HugeiconsIcon icon={Link01Icon} size={12} strokeWidth={1.75} />
            Copy link
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              void markForReview(tc.id, "User requested review");
            }}
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Mark for review
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onStartGenerator({ planId, suiteId })}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.75} />
            Generate sibling cases
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      {children}
    </div>
  );
}
