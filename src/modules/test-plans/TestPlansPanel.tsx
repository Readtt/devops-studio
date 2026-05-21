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
import { AzureDevOpsLogo } from "@/components/AzureDevOpsLogo";
import { ProjectSwitcher } from "@/modules/ado/ProjectSwitcher";
import { cn } from "@/lib/utils";
import { adoErrorMessage, getConnection, markForReview } from "@/modules/ado";
import { useTestPlans, type CaseDetailsState, type SuiteLoad } from "./hooks/useTestPlans";
import { NewSuiteDialog } from "./NewSuiteDialog";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Bug01Icon,
  ExternalLink,
  FolderAddIcon,
  FolderIcon,
  Link01Icon,
  PlusSignIcon,
  RefreshIcon,
  Settings01Icon,
  TaskDone01Icon,
  UnfoldLessIcon,
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

// --- Suite tree --------------------------------------------------------------

type SuiteNode = {
  suite: SuiteRef;
  children: SuiteNode[];
};

/**
 * Group suites into a tree by `parent_suite_id`. ADO always returns a single
 * root suite per plan whose name matches the plan name; we hide that node
 * and render its children at the top level so the tree reads:
 *
 *     AsanaCRM
 *       Contacts
 *       Opportunities
 *       Accounts
 *       Leads
 *
 * instead of duplicating "AsanaCRM" as the first suite under "AsanaCRM".
 *
 * If we can't identify a single matching root (e.g. orphaned suites or a
 * plan with multiple roots), we fall back to rendering every parent-less
 * suite at the top — better to show something than to hide everything.
 */
function buildSuiteTree(suites: SuiteRef[], planName: string): SuiteNode[] {
  if (suites.length === 0) return [];

  const ids = new Set(suites.map((s) => s.id));
  const byParent = new Map<number | null, SuiteRef[]>();
  for (const s of suites) {
    // Treat a parent that points outside our snapshot as a root — same effect
    // as having no parent at all.
    const parentKey =
      s.parentSuiteId != null && ids.has(s.parentSuiteId)
        ? s.parentSuiteId
        : null;
    const list = byParent.get(parentKey) ?? [];
    list.push(s);
    byParent.set(parentKey, list);
  }
  const roots = byParent.get(null) ?? [];

  const buildNode = (s: SuiteRef): SuiteNode => ({
    suite: s,
    children: (byParent.get(s.id) ?? []).map(buildNode),
  });

  // Most common case: one root, named after the plan. Skip it and surface
  // its children as the top-level nodes.
  if (roots.length === 1 && roots[0].name === planName) {
    return (byParent.get(roots[0].id) ?? []).map(buildNode);
  }
  return roots.map(buildNode);
}

/** Find the root suite for a plan — the one with no parent (or whose parent
 *  isn't in the returned set). Used when creating a top-level suite so the
 *  new suite gets attached to the plan's root rather than orphaned. */
function findRootSuiteId(suites: SuiteRef[]): number | null {
  if (suites.length === 0) return null;
  const ids = new Set(suites.map((s) => s.id));
  const root = suites.find(
    (s) => s.parentSuiteId == null || !ids.has(s.parentSuiteId),
  );
  return root?.id ?? null;
}

// --- Panel --------------------------------------------------------------------

type NewSuiteRequest =
  | null
  | {
      planId: number;
      planName: string;
      parentSuiteId: number | null;
      parentSuiteName: string | null;
    };

export function TestPlansPanel({ onOpenCase, onStartGenerator, activeCaseId }: Props) {
  const {
    initialized,
    configured,
    plans,
    plansLoading,
    plansError,
    bySuite,
    caseDetails,
    refreshConnection,
    refreshPlans,
    loadSuites,
    loadSuiteCases,
    loadCaseDetails,
    cancelPlanLoads,
  } = useTestPlans();
  const [expandedPlans, setExpandedPlans] = useState<Set<number>>(new Set());
  const [expandedSuites, setExpandedSuites] = useState<Set<number>>(new Set());
  const [expandedCases, setExpandedCases] = useState<Set<number>>(new Set());
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState(""); // debounced
  const [conn, setConn] = useState<ConnInfo | null>(null);
  const [newSuiteRequest, setNewSuiteRequest] = useState<NewSuiteRequest>(null);

  useEffect(() => {
    if (!initialized) {
      void refreshConnection();
    }
  }, [initialized, refreshConnection]);

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

  // Eager-load when filtering, so a suite-title-only match isn't hidden
  // behind a collapsed plan. We deliberately STOP at suites — fanning out
  // case loads per suite on every keystroke (potentially hundreds of ADO
  // calls) was the dominant cost at scale. For deep case-title search,
  // the Ctrl/Cmd+K palette has a proper in-memory index that's instant.
  useEffect(() => {
    if (!needle || plans.length === 0) return;
    for (const p of plans) {
      if (p.name.toLowerCase().includes(needle)) continue;
      void loadSuites(p.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, plans, loadSuites]);

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

  const toggleCase = useCallback(
    (caseId: number) => {
      setExpandedCases((curr) => {
        const next = new Set(curr);
        if (next.has(caseId)) {
          next.delete(caseId);
        } else {
          next.add(caseId);
          void loadCaseDetails(caseId);
        }
        return next;
      });
    },
    [loadCaseDetails],
  );

  // Collapse-all: close every plan, suite, and expanded case row. Also
  // cancels any in-flight loads for those plans so we don't paint stale
  // data into a tree the user just hid.
  const collapseAll = useCallback(() => {
    for (const pid of expandedPlans) cancelPlanLoads(pid);
    setExpandedPlans(new Set());
    setExpandedSuites(new Set());
    setExpandedCases(new Set());
  }, [expandedPlans, cancelPlanLoads]);

  const anythingExpanded =
    expandedPlans.size > 0 || expandedSuites.size > 0 || expandedCases.size > 0;

  const openNewSuiteForPlan = useCallback(
    (planId: number, planName: string) => {
      const suites = bySuite.get(planId)?.suites ?? [];
      const rootId = findRootSuiteId(suites);
      // If we haven't loaded suites yet, pass `null` and the backend resolves
      // the root for us. The dialog will refresh suites after creation.
      setNewSuiteRequest({
        planId,
        planName,
        parentSuiteId: rootId,
        parentSuiteName: null,
      });
    },
    [bySuite],
  );

  const openNewSuiteForSuite = useCallback(
    (
      planId: number,
      planName: string,
      parentSuiteId: number,
      parentSuiteName: string,
    ) => {
      setNewSuiteRequest({
        planId,
        planName,
        parentSuiteId,
        parentSuiteName,
      });
    },
    [],
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
          Set your organization URL and PAT in Settings to browse plans and
          cases.
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
      {/* Project header — title-band that doubles as the project switcher. */}
      <ProjectHeader projectName={conn?.project ?? ""} />

      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <input
          value={filterDraft}
          onChange={(e) => setFilterDraft(e.target.value)}
          placeholder="Filter plans, suites, cases…"
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
        />
        {anythingExpanded ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Collapse all"
                onClick={collapseAll}
              >
                <HugeiconsIcon
                  icon={UnfoldLessIcon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Collapse all expanded plans, suites, and cases
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
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
          <TooltipContent side="bottom">
            Refetch the plan list from Azure DevOps
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="xs" onClick={() => onStartGenerator()}>
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
              Generate
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
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
              expandedCases={expandedCases}
              forceExpand={forceExpand}
              onToggleSuite={(sid) => toggleSuite(p.id, sid)}
              onToggleCase={toggleCase}
              onOpenCase={onOpenCase}
              onStartGenerator={onStartGenerator}
              onNewSuiteForPlan={() => openNewSuiteForPlan(p.id, p.name)}
              onNewSuiteForSuite={(sid, sname) =>
                openNewSuiteForSuite(p.id, p.name, sid, sname)
              }
              bySuite={bySuite}
              caseDetails={caseDetails}
              loadSuites={loadSuites}
              loadSuiteCases={loadSuiteCases}
              activeCaseId={activeCaseId ?? null}
              conn={conn}
            />
          ))}
        </ul>
      </div>

      {newSuiteRequest ? (
        <NewSuiteDialog
          open
          onOpenChange={(open) => {
            if (!open) setNewSuiteRequest(null);
          }}
          planId={newSuiteRequest.planId}
          planName={newSuiteRequest.planName}
          parentSuiteId={newSuiteRequest.parentSuiteId}
          parentSuiteName={newSuiteRequest.parentSuiteName}
          onCreated={(sid) => {
            // Expand the plan + parent suite (if any) + new suite so the
            // user sees their freshly-created node in context.
            setExpandedPlans((s) => new Set(s).add(newSuiteRequest.planId));
            if (newSuiteRequest.parentSuiteId !== null) {
              setExpandedSuites((s) =>
                new Set(s).add(newSuiteRequest.parentSuiteId!),
              );
            }
            setExpandedSuites((s) => new Set(s).add(sid));
          }}
        />
      ) : null}
    </div>
  );
}

// --- Project header ----------------------------------------------------------

function ProjectHeader({
  projectName,
}: {
  projectName: string;
}) {
  // Collapse All lives in the filter toolbar below — keep the project header
  // focused on identity (logo + switcher) so it doesn't read as a control
  // bar.
  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
      <AzureDevOpsLogo size={11} className="shrink-0" />
      <ProjectSwitcher currentProject={projectName} />
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
  expandedCases: Set<number>;
  forceExpand: boolean;
  onToggleSuite: (suiteId: number) => void;
  onToggleCase: (caseId: number) => void;
  onOpenCase: Props["onOpenCase"];
  onStartGenerator: Props["onStartGenerator"];
  onNewSuiteForPlan: () => void;
  onNewSuiteForSuite: (parentSuiteId: number, parentSuiteName: string) => void;
  bySuite: Map<number, SuiteLoad>;
  caseDetails: Map<number, CaseDetailsState>;
  loadSuites: (planId: number, opts?: { force?: boolean }) => Promise<void>;
  loadSuiteCases: (planId: number, suiteId: number) => Promise<void>;
  activeCaseId: number | null;
  conn: ConnInfo | null;
};

function PlanRow({
  plan,
  expanded,
  onToggle,
  matches,
  expandedSuites,
  expandedCases,
  forceExpand,
  onToggleSuite,
  onToggleCase,
  onOpenCase,
  onStartGenerator,
  onNewSuiteForPlan,
  onNewSuiteForSuite,
  bySuite,
  caseDetails,
  loadSuites,
  activeCaseId,
  conn,
}: PlanRowProps) {
  const data = bySuite.get(plan.id);
  const planWebUrl = conn
    ? `${conn.orgUrl}/${encodeURIComponent(conn.project)}/_testPlans/define?planId=${plan.id}`
    : null;

  const tree = useMemo(
    () => (data ? buildSuiteTree(data.suites, plan.name) : []),
    [data, plan.name],
  );

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-left text-[12px] transition-colors duration-150 hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium">{plan.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => void loadSuites(plan.id, { force: true })}
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Refresh suites
          </ContextMenuItem>
          <ContextMenuItem onSelect={onNewSuiteForPlan}>
            <HugeiconsIcon icon={FolderAddIcon} size={12} strokeWidth={1.75} />
            New suite…
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
          {!data?.loading && tree.length === 0 ? (
            <li className="px-2 py-1 text-[10.5px] text-muted-foreground">
              No suites in this plan.
            </li>
          ) : null}
          {tree
            .filter((node) =>
              !matches ||
              matches(node.suite.name) ||
              treeHasMatchingCase(node, data!, matches) ||
              treeHasMatchingSuite(node, matches),
            )
            .map((node) => (
              <SuiteRow
                key={node.suite.id}
                planId={plan.id}
                node={node}
                expandedSuites={expandedSuites}
                expandedCases={expandedCases}
                forceExpand={forceExpand}
                onToggleSuite={onToggleSuite}
                onToggleCase={onToggleCase}
                suiteLoad={data!}
                caseDetails={caseDetails}
                matches={matches}
                onOpenCase={onOpenCase}
                onStartGenerator={onStartGenerator}
                onNewSuite={onNewSuiteForSuite}
                conn={conn}
                activeCaseId={activeCaseId}
              />
            ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Does any case under this suite (or its descendants) match the filter? */
function treeHasMatchingCase(
  node: SuiteNode,
  load: SuiteLoad,
  matches: ((s: string) => boolean) | null,
): boolean {
  if (!matches) return true;
  const own = load.suiteCases.get(node.suite.id)?.cases;
  // Not yet loaded — keep the node visible so the eager-load can fire.
  if (own === undefined || own === null) return true;
  if (own.some((c) => matches(c.title))) return true;
  return node.children.some((child) => treeHasMatchingCase(child, load, matches));
}

/** Does this suite or any descendant suite name match the filter? */
function treeHasMatchingSuite(
  node: SuiteNode,
  matches: ((s: string) => boolean) | null,
): boolean {
  if (!matches) return true;
  if (matches(node.suite.name)) return true;
  return node.children.some((c) => treeHasMatchingSuite(c, matches));
}

// --- Suite row --------------------------------------------------------------

type SuiteRowProps = {
  planId: number;
  node: SuiteNode;
  expandedSuites: Set<number>;
  expandedCases: Set<number>;
  forceExpand: boolean;
  onToggleSuite: (suiteId: number) => void;
  onToggleCase: (caseId: number) => void;
  suiteLoad: SuiteLoad;
  caseDetails: Map<number, CaseDetailsState>;
  matches: ((s: string) => boolean) | null;
  onOpenCase: Props["onOpenCase"];
  onStartGenerator: Props["onStartGenerator"];
  onNewSuite: (parentSuiteId: number, parentSuiteName: string) => void;
  conn: ConnInfo | null;
  activeCaseId: number | null;
};

function SuiteRow({
  planId,
  node,
  expandedSuites,
  expandedCases,
  forceExpand,
  onToggleSuite,
  onToggleCase,
  suiteLoad,
  caseDetails,
  matches,
  onOpenCase,
  onStartGenerator,
  onNewSuite,
  conn,
  activeCaseId,
}: SuiteRowProps) {
  const { suite, children } = node;
  const expanded = forceExpand || expandedSuites.has(suite.id);
  const sc = suiteLoad.suiteCases.get(suite.id);
  const loading = sc?.loading ?? false;
  const cases = sc?.cases ?? null;
  const error = sc?.error ?? null;
  const hasChildren = children.length > 0;
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
            onClick={() => onToggleSuite(suite.id)}
            className="flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-left text-[11.5px] transition-colors duration-150 hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              size={10}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <HugeiconsIcon
              icon={FolderIcon}
              size={10}
              strokeWidth={1.75}
              className={cn(
                "shrink-0",
                hasChildren ? "text-foreground/70" : "text-muted-foreground/70",
              )}
            />
            <span className="truncate">{suite.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              void useTestPlans.getState().loadSuiteCases(planId, suite.id)
            }
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Refresh cases
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onNewSuite(suite.id, suite.name)}>
            <HugeiconsIcon icon={FolderAddIcon} size={12} strokeWidth={1.75} />
            New nested suite…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onStartGenerator({ planId, suiteId: suite.id })}
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
          {/* Child suites first, then direct cases — matches the ADO web UI. */}
          {children
            .filter(
              (child) =>
                !matches ||
                matches(child.suite.name) ||
                treeHasMatchingCase(child, suiteLoad, matches) ||
                treeHasMatchingSuite(child, matches),
            )
            .map((child) => (
              <SuiteRow
                key={child.suite.id}
                planId={planId}
                node={child}
                expandedSuites={expandedSuites}
                expandedCases={expandedCases}
                forceExpand={forceExpand}
                onToggleSuite={onToggleSuite}
                onToggleCase={onToggleCase}
                suiteLoad={suiteLoad}
                caseDetails={caseDetails}
                matches={matches}
                onOpenCase={onOpenCase}
                onStartGenerator={onStartGenerator}
                onNewSuite={onNewSuite}
                conn={conn}
                activeCaseId={activeCaseId}
              />
            ))}
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
          {!loading && cases?.length === 0 && !hasChildren ? (
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
                expanded={expandedCases.has(c.id)}
                onToggleExpand={() => onToggleCase(c.id)}
                details={caseDetails.get(c.id)}
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
  expanded: boolean;
  onToggleExpand: () => void;
  details?: CaseDetailsState;
};

function CaseRow({
  tc,
  onOpenCase,
  onStartGenerator,
  planId,
  suiteId,
  conn,
  active,
  expanded,
  onToggleExpand,
  details,
}: CaseRowProps) {
  const caseWebUrl = conn
    ? `${conn.orgUrl}/${encodeURIComponent(conn.project)}/_workitems/edit/${tc.id}`
    : null;
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const open = () => onOpenCase({ caseId: tc.id, title: `#${tc.id} · ${tc.title}` });

  useEffect(() => {
    if (active) {
      buttonRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-0.5 rounded-sm border-l-2 border-transparent pl-0 pr-1 transition-colors duration-150 hover:bg-foreground/[0.05]",
          active &&
            "border-primary bg-primary/10 text-foreground dark:bg-primary/[0.12]",
        )}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse details" : "Show details"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon
            icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
            size={9}
            strokeWidth={1.75}
          />
        </button>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              ref={buttonRef}
              type="button"
              onClick={open}
              data-active={active || undefined}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1.5 pl-0.5 pr-1 text-left text-[11px]",
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
              <span
                className={cn(
                  "font-mono text-[10px]",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                #{tc.id}
              </span>
              <span className="truncate">{tc.title}</span>
              {tc.state ? (
                <StateBadge state={tc.state} />
              ) : null}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
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
      </div>
      {expanded ? (
        <CaseDetails details={details} caseWebUrl={caseWebUrl} />
      ) : null}
    </li>
  );
}

/**
 * Inline expand for a case row. Lazy-loads full case data (state, priority,
 * assignee, linked work items) so the user can peek without opening a tab.
 */
function CaseDetails({
  details,
  caseWebUrl,
}: {
  details?: CaseDetailsState;
  caseWebUrl: string | null;
}) {
  if (!details || details.loading) {
    return (
      <div className="ml-6 mt-0.5 mb-1 flex flex-col gap-1 border-l border-border/40 pl-2.5">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (details.error) {
    return (
      <div className="ml-6 mt-0.5 mb-1 border-l border-destructive/40 pl-2.5 text-[10.5px] text-destructive">
        {adoErrorMessage(details.error)}
      </div>
    );
  }
  const tc = details.data;
  if (!tc) return null;

  const meta: { label: string; value: string }[] = [];
  if (tc.priority != null) meta.push({ label: "P", value: String(tc.priority) });
  if (tc.assignedTo) meta.push({ label: "@", value: tc.assignedTo });
  if (tc.changedDate) {
    meta.push({ label: "Δ", value: formatDate(tc.changedDate) });
  }

  return (
    <div className="ml-6 mt-0.5 mb-1 flex flex-col gap-1.5 border-l border-border/40 pl-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
        {meta.map((m) => (
          <span
            key={m.label}
            className="inline-flex items-center gap-1 rounded-sm bg-foreground/[0.05] px-1 py-px"
          >
            <span className="text-muted-foreground/70">{m.label}</span>
            <span className="text-foreground/85">{m.value}</span>
          </span>
        ))}
        {tc.steps?.length ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-foreground/[0.05] px-1 py-px">
            <span className="text-muted-foreground/70">steps</span>
            <span className="text-foreground/85">{tc.steps.length}</span>
          </span>
        ) : null}
      </div>

      {tc.linkedWorkItems.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {tc.linkedWorkItems.slice(0, 6).map((lwi) => {
            const isLikelyBug = lwi.kind === "Tested by" || lwi.kind === "Tests";
            return (
              <li
                key={`${lwi.rel}-${lwi.id}`}
                className="flex items-center gap-1.5 text-[10.5px]"
              >
                <HugeiconsIcon
                  icon={isLikelyBug ? Bug01Icon : Link01Icon}
                  size={9}
                  strokeWidth={1.75}
                  className={cn(
                    "shrink-0",
                    isLikelyBug ? "text-rose-500/80" : "text-muted-foreground/70",
                  )}
                />
                <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                  {lwi.kind}
                </span>
                <span className="font-mono text-[9.5px] text-muted-foreground">
                  #{lwi.id}
                </span>
                {isLikelyBug ? (
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("devops-studio:open-bug", {
                          detail: { bugId: lwi.id },
                        }),
                      )
                    }
                    className="truncate text-foreground/85 hover:text-primary hover:underline"
                  >
                    open in app
                  </button>
                ) : lwi.webUrl ? (
                  <button
                    type="button"
                    onClick={() => void openUrl(lwi.webUrl)}
                    className="truncate text-foreground/70 hover:text-foreground"
                  >
                    open in ADO
                  </button>
                ) : null}
              </li>
            );
          })}
          {tc.linkedWorkItems.length > 6 ? (
            <li className="text-[9.5px] text-muted-foreground/70">
              + {tc.linkedWorkItems.length - 6} more — open case to view all
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-[10px] italic text-muted-foreground/60">
          No linked work items.
        </p>
      )}

      {caseWebUrl ? (
        <button
          type="button"
          onClick={() => void openUrl(caseWebUrl)}
          className="inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={ExternalLink} size={9} strokeWidth={1.75} />
          open in azure devops
        </button>
      ) : null}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone = state.toLowerCase();
  const cls =
    tone === "design" || tone === "draft"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : tone === "ready" || tone === "active"
        ? "bg-primary/15 text-primary"
        : tone === "closed" || tone === "completed"
          ? "bg-foreground/[0.08] text-muted-foreground line-through decoration-muted-foreground/60"
          : "bg-foreground/[0.06] text-muted-foreground";
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-sm px-1 py-px font-mono text-[9px] uppercase tracking-wider",
        cls,
      )}
    >
      {state}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days < 1) return "today";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
  } catch {
    return iso;
  }
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      {children}
    </div>
  );
}
