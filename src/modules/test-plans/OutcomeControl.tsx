import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  adoErrorMessage,
  listSuitesForCase,
  listTestPoints,
  OUTCOMES,
  setTestPointOutcome,
  toAdoError,
  type CaseSuiteMembership,
  type ExecutionOutcome,
  type TestPointInfo,
} from "@/modules/ado";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";

type Props = {
  caseId: number;
  /** Plan + suite the case was opened from. Null when opened without suite
   *  context — the dropdown then lets the user pick a suite first. */
  planId: number | null;
  suiteId: number | null;
  /** Bumped by the pane when the case is refreshed, so the recorded outcome
   *  re-reads from ADO alongside the rest of the case. */
  refreshKey: number;
};

/**
 * Ultra-minimal execution control: a single dropdown in the test-case header,
 * next to Refresh / Open in ADO. The trigger shows the current outcome; the
 * menu switches it (Pass / Fail / Blocked / Not applicable / Reset). Outcomes
 * attach to the case's test point in a specific plan + suite — when the case
 * was opened without that context, the menu first offers the suites the case
 * belongs to.
 */
export function OutcomeControl({ caseId, planId, suiteId, refreshKey }: Props) {
  const [target, setTarget] = useState<{ planId: number; suiteId: number } | null>(
    planId != null && suiteId != null ? { planId, suiteId } : null,
  );
  useEffect(() => {
    if (planId != null && suiteId != null) setTarget({ planId, suiteId });
  }, [planId, suiteId]);

  const [points, setPoints] = useState<TestPointInfo[] | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [memberships, setMemberships] = useState<CaseSuiteMembership[] | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const loadPoints = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listTestPoints(target.planId, target.suiteId, caseId);
      setPoints(next);
      setSelectedPointId((prev) =>
        prev != null && next.some((p) => p.id === prev) ? prev : (next[0]?.id ?? null),
      );
    } catch (e) {
      setError(adoErrorMessage(toAdoError(e)) || "Couldn't load the outcome.");
      setPoints([]);
    } finally {
      setLoading(false);
    }
  }, [target, caseId]);

  // Reload when the target changes AND whenever the pane refreshes the case.
  useEffect(() => {
    void loadPoints();
  }, [loadPoints, refreshKey]);

  const selectedPoint = useMemo(
    () => points?.find((p) => p.id === selectedPointId) ?? null,
    [points, selectedPointId],
  );
  const current = outcomeMeta(selectedPoint?.outcome);

  const record = useCallback(
    async (outcome: ExecutionOutcome) => {
      if (!target || selectedPointId == null) return;
      setSaving(true);
      setError(null);
      try {
        const updated = await setTestPointOutcome({
          planId: target.planId,
          suiteId: target.suiteId,
          pointId: selectedPointId,
          caseId,
          outcome,
        });
        // The command returns the outcome we wrote (authoritative), so trust
        // it for the optimistic display rather than re-GETting — ADO's read
        // can lag a fresh write.
        setPoints((prev) =>
          prev
            ? prev.map((p) =>
                p.id === selectedPointId
                  ? {
                      ...p,
                      outcome: updated.outcome,
                      tester: updated.tester ?? p.tester,
                      lastUpdated: updated.lastUpdated ?? p.lastUpdated,
                    }
                  : p,
              )
            : prev,
        );
      } catch (e) {
        setError(adoErrorMessage(toAdoError(e)) || "Couldn't record the outcome.");
      } finally {
        setSaving(false);
      }
    },
    [target, selectedPointId, caseId],
  );

  const loadMemberships = useCallback(async () => {
    setMemberships(null);
    setMembershipError(null);
    try {
      setMemberships(await listSuitesForCase(caseId));
    } catch (e) {
      setMembershipError(adoErrorMessage(toAdoError(e)) || "Couldn't load suites.");
      setMemberships([]);
    }
  }, [caseId]);

  // Trigger label: outcome when known, else a quiet prompt.
  const triggerLabel = !target
    ? "Set run"
    : loading && points === null
      ? "Run…"
      : points && points.length === 0
        ? "No run"
        : current.label;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !target && memberships === null) void loadMemberships();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-transparent px-2 text-[11px] font-medium transition-colors hover:bg-foreground/[0.05]",
                current.key === "Unspecified" || !target
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {saving ? (
                <HugeiconsIcon icon={Loading03Icon} size={11} strokeWidth={2} className="animate-spin" />
              ) : (
                <span className={cn("size-2 rounded-full", current.dot)} />
              )}
              {triggerLabel}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={1.75}
                className="text-muted-foreground/70"
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
          Set this case&apos;s run outcome (Pass / Fail / Blocked) in Azure
          DevOps. Records against the suite it was opened from.
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-52">
        {!target ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">
              Record run in
            </DropdownMenuLabel>
            {memberships === null ? (
              <DropdownMenuItem disabled className="text-[11px]">
                Loading suites…
              </DropdownMenuItem>
            ) : membershipError ? (
              <DropdownMenuItem disabled className="text-[11px] text-destructive">
                {membershipError}
              </DropdownMenuItem>
            ) : memberships.length === 0 ? (
              <DropdownMenuItem disabled className="text-[11px]">
                Not assigned to a suite in any plan
              </DropdownMenuItem>
            ) : (
              memberships.map((m) => (
                <DropdownMenuItem
                  key={`${m.planId}:${m.suiteId}`}
                  className="text-[11px]"
                  onSelect={() => setTarget({ planId: m.planId, suiteId: m.suiteId })}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{m.suiteName ?? `Suite #${m.suiteId}`}</span>
                    <span className="truncate text-[9.5px] text-muted-foreground">
                      {m.planName ?? `Plan #${m.planId}`}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </>
        ) : error ? (
          <DropdownMenuItem disabled className="text-[11px] text-destructive">
            {error}
          </DropdownMenuItem>
        ) : loading && points === null ? (
          <DropdownMenuItem disabled className="text-[11px]">
            Loading…
          </DropdownMenuItem>
        ) : points && points.length === 0 ? (
          <DropdownMenuItem disabled className="text-[11px]">
            No test point in this suite
          </DropdownMenuItem>
        ) : (
          <>
            {points && points.length > 1 ? (
              <>
                <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">
                  Configuration
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={selectedPointId != null ? String(selectedPointId) : undefined}
                  onValueChange={(v) => setSelectedPointId(Number(v))}
                >
                  {points.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={String(p.id)} className="text-[11px]">
                      {p.configurationName ?? `Config ${p.configurationId ?? p.id}`}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}

            {OUTCOMES.map((o) => (
              <DropdownMenuItem
                key={o.value}
                className="text-[11px]"
                onSelect={() => void record(o.value)}
              >
                <span className={cn("size-2 rounded-full", o.dot)} />
                {o.label}
                {current.key === o.value ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={12}
                    strokeWidth={2}
                    className="ml-auto text-primary"
                  />
                ) : null}
              </DropdownMenuItem>
            ))}

            {current.key !== "Unspecified" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-[11px] text-muted-foreground"
                  onSelect={() => void record("Active")}
                >
                  Reset to not run
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type OutcomeKey = "Passed" | "Failed" | "Blocked" | "NotApplicable" | "Unspecified";

/** Normalize ADO's outcome string into a label + dot colour for the trigger. */
function outcomeMeta(outcome: string | null | undefined): {
  key: OutcomeKey;
  label: string;
  dot: string;
} {
  switch ((outcome ?? "").toLowerCase()) {
    case "passed":
      return { key: "Passed", label: "Passed", dot: "bg-emerald-500" };
    case "failed":
      return { key: "Failed", label: "Failed", dot: "bg-rose-500" };
    case "blocked":
      return { key: "Blocked", label: "Blocked", dot: "bg-amber-500" };
    case "notapplicable":
      return { key: "NotApplicable", label: "Not applicable", dot: "bg-muted-foreground/60" };
    default:
      return { key: "Unspecified", label: "Not run", dot: "bg-muted-foreground/40" };
  }
}
