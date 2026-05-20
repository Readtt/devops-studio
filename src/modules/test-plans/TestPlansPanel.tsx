import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { adoErrorMessage } from "@/modules/ado";
import { useTestPlans, type SuiteLoad } from "./hooks/useTestPlans";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlusSignIcon,
  RefreshIcon,
  Settings01Icon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import type { SuiteRef, TestCaseRef, TestPlanRef } from "@/modules/ado";

type Props = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onStartGenerator: (input?: {
    planId?: number | null;
    suiteId?: number | null;
  }) => void;
};

export function TestPlansPanel({ onOpenCase, onStartGenerator }: Props) {
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
  } = useTestPlans();
  const [expandedPlans, setExpandedPlans] = useState<Set<number>>(new Set());
  const [expandedSuites, setExpandedSuites] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!initialized) {
      void refreshConnection();
    }
  }, [initialized, refreshConnection]);

  const matches = useMemo(() => {
    if (!filter.trim()) return null;
    const needle = filter.trim().toLowerCase();
    return (s: string) => s.toLowerCase().includes(needle);
  }, [filter]);

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
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter plans, suites, cases…"
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Refresh"
          onClick={() => void refreshPlans()}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={12}
            strokeWidth={1.75}
            className={plansLoading ? "animate-spin" : ""}
          />
        </Button>
        <Button
          size="sm"
          className="h-6 px-1.5 text-[10.5px]"
          onClick={() => onStartGenerator()}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
          Generate
        </Button>
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
              expanded={expandedPlans.has(p.id)}
              onToggle={() => togglePlan(p.id)}
              matches={matches}
              expandedSuites={expandedSuites}
              onToggleSuite={(sid) => toggleSuite(p.id, sid)}
              onOpenCase={onOpenCase}
              bySuite={bySuite}
              loadSuites={loadSuites}
              loadSuiteCases={loadSuiteCases}
            />
          ))}
        </ul>
      </div>
    </div>
  );

  function togglePlan(id: number) {
    setExpandedPlans((curr) => {
      const next = new Set(curr);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        void loadSuites(id);
      }
      return next;
    });
  }

  function toggleSuite(planId: number, suiteId: number) {
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
  }
}

type PlanRowProps = {
  plan: TestPlanRef;
  expanded: boolean;
  onToggle: () => void;
  /** Title-substring filter; applied to suite/case rows. Plan rows always show. */
  matches: ((s: string) => boolean) | null;
  expandedSuites: Set<number>;
  onToggleSuite: (suiteId: number) => void;
  onOpenCase: Props["onOpenCase"];
  bySuite: Map<number, SuiteLoad>;
  loadSuites: (planId: number) => Promise<void>;
  loadSuiteCases: (planId: number, suiteId: number) => Promise<void>;
};

function PlanRow({
  plan,
  expanded,
  onToggle,
  matches,
  expandedSuites,
  onToggleSuite,
  onOpenCase,
  bySuite,
}: PlanRowProps) {
  const data = bySuite.get(plan.id);
  return (
    <li>
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
      {expanded ? (
        <ul className="ml-3 border-l border-border/40 pl-1.5">
          {data?.loading ? (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">
              Loading suites…
            </li>
          ) : null}
          {data?.error ? (
            <li className="px-2 py-1 text-[11px] text-destructive">
              Failed to load suites
            </li>
          ) : null}
          {data?.suites
            .filter((s) => !matches || matches(s.name))
            .map((s) => (
              <SuiteRow
                key={s.id}
                planId={plan.id}
                suite={s}
                expanded={expandedSuites.has(s.id)}
                onToggle={() => onToggleSuite(s.id)}
                cases={data.cases.get(s.id)}
                loading={data.loadingCases.has(s.id)}
                matches={matches}
                onOpenCase={onOpenCase}
              />
            ))}
        </ul>
      ) : null}
    </li>
  );
}

type SuiteRowProps = {
  planId: number;
  suite: SuiteRef;
  expanded: boolean;
  onToggle: () => void;
  cases: TestCaseRef[] | undefined;
  loading: boolean;
  matches: ((s: string) => boolean) | null;
  onOpenCase: Props["onOpenCase"];
};

function SuiteRow({
  suite,
  expanded,
  onToggle,
  cases,
  loading,
  matches,
  onOpenCase,
}: SuiteRowProps) {
  return (
    <li>
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
      {expanded ? (
        <ul className="ml-3 border-l border-border/40 pl-1.5">
          {loading ? (
            <li className="px-2 py-1 text-[10.5px] text-muted-foreground">
              Loading cases…
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
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenCase({
                      caseId: c.id,
                      title: `#${c.id} · ${c.title}`,
                    })
                  }
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[11px] hover:bg-foreground/[0.05]",
                  )}
                >
                  <HugeiconsIcon
                    icon={TaskDone01Icon}
                    size={10}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    #{c.id}
                  </span>
                  <span className="truncate">{c.title}</span>
                </button>
              </li>
            ))}
        </ul>
      ) : null}
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
