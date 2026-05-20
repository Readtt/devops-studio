import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo } from "react";
import {
  type GenerationMode,
  useGenerationSession,
} from "./store/useGenerationSession";
import { useTestPlans } from "@/modules/test-plans";
import { adoErrorMessage } from "@/modules/ado";
import {
  AlertCircleIcon,
  ArrowLeft02Icon,
  CheckmarkCircle02Icon,
  ExternalLink,
  RemoveCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const MODE_LABELS: Record<GenerationMode, string> = {
  happy: "Happy path only",
  thorough: "Happy + edge + negative (recommended)",
  "bug-hunt": "Bug-hunt (suggests Bug work items)",
};

type Props = {
  /** Optional preselected plan/suite from the launching context. */
  initialPlanId?: number | null;
  initialSuiteId?: number | null;
  /** Open an existing case in a workspace tab (used by duplicate hints). */
  onOpenCase?: (input: { caseId: number; title: string }) => void;
};

export function GeneratorPane({
  initialPlanId,
  initialSuiteId,
  onOpenCase,
}: Props) {
  const phase = useGenerationSession((s) => s.phase);
  const setTarget = useGenerationSession((s) => s.setTarget);
  const planId = useGenerationSession((s) => s.planId);

  // Hydrate target from launching context once.
  useEffect(() => {
    if (planId === null && initialPlanId) {
      setTarget(initialPlanId, initialSuiteId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <Header />
      <div className="mx-auto w-full max-w-3xl px-6 py-5">
        {phase === "input" && <InputPhase />}
        {phase === "analyzing" && <AnalyzingPhase />}
        {phase === "review" && <ReviewPhase onOpenCase={onOpenCase} />}
        {phase === "publishing" && <PublishingPhase />}
        {phase === "done" && <DonePhase />}
        {phase === "error" && <ErrorPhase />}
      </div>
    </div>
  );
}

function Header() {
  const phase = useGenerationSession((s) => s.phase);
  const startNew = useGenerationSession((s) => s.startNew);
  const phaseLabel: Record<typeof phase, string> = {
    input: "1 · Input",
    analyzing: "2 · Analyzing",
    review: "3 · Review",
    publishing: "4 · Publishing",
    done: "5 · Done",
    error: "Error",
  };
  return (
    <header className="flex items-center justify-between border-b border-border/60 bg-card/40 px-6 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-[14px] font-semibold tracking-tight">
          Test Case Generator
        </h1>
        <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          {phaseLabel[phase]}
        </span>
      </div>
      {phase !== "input" && phase !== "analyzing" ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={startNew}
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            size={12}
            strokeWidth={1.75}
          />
          New session
        </Button>
      ) : null}
    </header>
  );
}

function InputPhase() {
  const requirements = useGenerationSession((s) => s.requirements);
  const mode = useGenerationSession((s) => s.mode);
  const planId = useGenerationSession((s) => s.planId);
  const suiteId = useGenerationSession((s) => s.suiteId);
  const setRequirements = useGenerationSession((s) => s.setRequirements);
  const setMode = useGenerationSession((s) => s.setMode);
  const setTarget = useGenerationSession((s) => s.setTarget);
  const analyze = useGenerationSession((s) => s.analyze);

  const {
    plans,
    bySuite,
    plansLoading,
    initialized,
    configured,
    refreshConnection,
    refreshPlans,
    loadSuites,
  } = useTestPlans();
  useEffect(() => {
    if (!initialized) void refreshConnection();
    else if (configured && plans.length === 0 && !plansLoading) {
      void refreshPlans();
    }
  }, [initialized, configured, plans.length, plansLoading, refreshConnection, refreshPlans]);
  useEffect(() => {
    if (planId !== null) void loadSuites(planId);
  }, [planId, loadSuites]);

  const suites = planId !== null ? bySuite.get(planId)?.suites ?? [] : [];

  const canAnalyze =
    requirements.trim().length > 0 && planId !== null && suiteId !== null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gen-reqs">Requirements / feature spec</Label>
        <textarea
          id="gen-reqs"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          placeholder="Paste the Asana task / Jira ticket / spec wiki here. Be specific — the analyzer will only know what you put here (plus any source files you attach)."
          rows={10}
          className="rounded-md border border-border/60 bg-background/70 px-3 py-2 font-mono text-[12px] outline-none focus:border-primary/60"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Test Plan</Label>
          <Select
            value={planId !== null ? String(planId) : ""}
            onValueChange={(v) => setTarget(Number(v), null)}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  !configured
                    ? "Connect in Settings first"
                    : plans.length === 0
                      ? "No plans found"
                      : "Choose a plan"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {plans.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Suite</Label>
          <Select
            value={suiteId !== null ? String(suiteId) : ""}
            onValueChange={(v) => setTarget(planId, Number(v))}
            disabled={planId === null}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  planId === null
                    ? "Pick a plan first"
                    : suites.length === 0
                      ? "Loading…"
                      : "Choose a suite"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {suites.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Generation mode</Label>
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as GenerationMode)}
          className="gap-1"
        >
          {(["happy", "thorough", "bug-hunt"] as GenerationMode[]).map((m) => (
            <label
              key={m}
              htmlFor={`gen-mode-${m}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[11.5px] transition-colors hover:bg-foreground/[0.03]",
                mode === m
                  ? "border-primary/40 bg-primary/[0.04]"
                  : "border-border/40",
              )}
            >
              <RadioGroupItem id={`gen-mode-${m}`} value={m} />
              {MODE_LABELS[m]}
            </label>
          ))}
        </RadioGroup>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/40 pt-3">
        <Button onClick={analyze} disabled={!canAnalyze}>
          Analyze
        </Button>
      </div>
    </div>
  );
}

function AnalyzingPhase() {
  const stepLabel = useGenerationSession((s) => s.stepLabel);
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <Spinner className="size-7 text-primary" />
      <div>
        <p className="text-[13px] font-medium">Analyzing requirements…</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{stepLabel}</p>
      </div>
    </div>
  );
}

function ReviewPhase({
  onOpenCase,
}: {
  onOpenCase?: (input: { caseId: number; title: string }) => void;
}) {
  const cases = useGenerationSession((s) => s.cases);
  const bugs = useGenerationSession((s) => s.bugs);
  const setCaseDecision = useGenerationSession((s) => s.setCaseDecision);
  const setBugDecision = useGenerationSession((s) => s.setBugDecision);
  const publish = useGenerationSession((s) => s.publish);
  const startNew = useGenerationSession((s) => s.startNew);
  const durationMs = useGenerationSession((s) => s.durationMs);

  const kept = useMemo(
    () => cases.filter((c) => c.decision === "keep").length,
    [cases],
  );
  const keptBugs = useMemo(
    () => bugs.filter((b) => b.decision === "keep").length,
    [bugs],
  );

  if (cases.length === 0 && bugs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={20}
          strokeWidth={1.5}
          className="text-muted-foreground"
        />
        <p className="text-[12px] font-medium">No test cases proposed.</p>
        <p className="max-w-[400px] text-[11px] text-muted-foreground">
          The analyzer didn't return anything. Try adding more detail to the
          requirements, or attach source files for context.
        </p>
        <Button size="sm" variant="outline" onClick={startNew} className="mt-2">
          Back to input
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <p className="text-[11.5px] text-muted-foreground">
          {cases.length} case{cases.length === 1 ? "" : "s"} proposed
          {bugs.length > 0
            ? `, ${bugs.length} bug suggestion${bugs.length === 1 ? "" : "s"}`
            : ""}
          {durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}.
        </p>
        <Button onClick={() => void publish()} disabled={kept === 0}>
          Publish {kept} case{kept === 1 ? "" : "s"}
          {keptBugs > 0 ? ` + ${keptBugs} bug${keptBugs === 1 ? "" : "s"}` : ""}
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {cases.map((c) => (
          <li
            key={c.uid}
            className={cn(
              "rounded-md border bg-card/40 transition-colors",
              c.decision === "keep"
                ? "border-border/60"
                : "border-border/20 opacity-50",
            )}
          >
            <div className="flex items-start justify-between gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium">{c.title}</p>
                {c.rationale ? (
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {c.rationale}
                  </p>
                ) : null}
                {c.similarMatches.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {c.similarMatches.map((m) => (
                      <div
                        key={m.caseId}
                        className="flex items-center gap-1.5 text-[10.5px] text-amber-700 dark:text-amber-300"
                      >
                        <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide">
                          {(m.score * 100).toFixed(0)}%
                        </span>
                        <span className="truncate">
                          Similar to{" "}
                          <button
                            type="button"
                            onClick={() =>
                              onOpenCase?.({
                                caseId: m.caseId,
                                title: `#${m.caseId} · ${m.title}`,
                              })
                            }
                            className="font-mono underline-offset-2 hover:underline"
                          >
                            #{m.caseId}
                          </button>{" "}
                          · {m.title}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Skip"
                  onClick={() =>
                    setCaseDecision(
                      c.uid,
                      c.decision === "keep" ? "skip" : "keep",
                    )
                  }
                >
                  <HugeiconsIcon
                    icon={
                      c.decision === "keep"
                        ? RemoveCircleIcon
                        : CheckmarkCircle02Icon
                    }
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            </div>
            <ol className="border-t border-border/30 px-3 py-2 text-[11px]">
              {c.steps.map((s, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[1fr_1fr] gap-3 py-1 first:pt-0 last:pb-0"
                >
                  <div className="text-foreground/85">
                    <span className="mr-1 font-mono text-muted-foreground">
                      {i + 1}.
                    </span>
                    {s.action}
                  </div>
                  <div className="text-muted-foreground">→ {s.expected}</div>
                </li>
              ))}
            </ol>
            {c.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1 border-t border-border/30 px-3 py-1.5">
                {c.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-foreground/[0.06] px-1.5 py-px text-[9.5px] text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {bugs.length > 0 ? (
        <section>
          <h2 className="mb-1.5 mt-3 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Bug suggestions
          </h2>
          <ul className="flex flex-col gap-2">
            {bugs.map((b) => (
              <li
                key={b.uid}
                className={cn(
                  "rounded-md border bg-card/40 px-3 py-2",
                  b.decision === "keep"
                    ? "border-border/60"
                    : "border-border/20 opacity-50",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[12.5px] font-medium">{b.title}</p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      Severity: {b.severity}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    aria-label="Skip"
                    onClick={() =>
                      setBugDecision(
                        b.uid,
                        b.decision === "keep" ? "skip" : "keep",
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={
                        b.decision === "keep"
                          ? RemoveCircleIcon
                          : CheckmarkCircle02Icon
                      }
                      size={12}
                      strokeWidth={1.75}
                    />
                  </Button>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[11px] text-foreground/85">
                  {b.reproSteps}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PublishingPhase() {
  const log = useGenerationSession((s) => s.publishLog);
  const pending = log.filter((e) => e.status === "pending").length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Spinner className="size-4 text-primary" />
        <p className="text-[12.5px]">
          Publishing… {log.length - pending}/{log.length}
        </p>
      </div>
      <PublishLogList log={log} />
    </div>
  );
}

function DonePhase() {
  const log = useGenerationSession((s) => s.publishLog);
  const startNew = useGenerationSession((s) => s.startNew);
  const ok = log.filter((e) => e.status === "ok").length;
  const failed = log.filter((e) => e.status === "failed").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium">
          Published {ok}{failed > 0 ? ` · ${failed} failed` : ""}.
        </p>
        <Button onClick={startNew}>Start another session</Button>
      </div>
      <PublishLogList log={log} />
    </div>
  );
}

function ErrorPhase() {
  const error = useGenerationSession((s) => s.error);
  const startNew = useGenerationSession((s) => s.startNew);
  const message =
    typeof error === "string"
      ? error
      : error
        ? adoErrorMessage(error)
        : "Unknown error";
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={20}
        strokeWidth={1.5}
        className="text-destructive"
      />
      <p className="text-[13px] font-medium">Something went wrong.</p>
      <p className="max-w-[420px] whitespace-pre-wrap text-[11px] text-muted-foreground">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={startNew} className="mt-2">
        Back to input
      </Button>
    </div>
  );
}

function PublishLogList({
  log,
}: {
  log: ReturnType<typeof useGenerationSession.getState>["publishLog"];
}) {
  return (
    <ul className="divide-y divide-border/40 rounded-md border border-border/60 bg-card/40">
      {log.map((e) => (
        <li
          key={e.uid}
          className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
        >
          <StatusDot status={e.status} />
          <span className="rounded-sm bg-foreground/[0.06] px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
            {e.kind}
          </span>
          <span className="min-w-0 flex-1 truncate">{e.title}</span>
          {e.result ? (
            <button
              type="button"
              onClick={() => void openUrl(e.result!.webUrl)}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon
                icon={ExternalLink}
                size={11}
                strokeWidth={1.75}
              />
              #{e.result.id}
            </button>
          ) : null}
          {e.error ? (
            <span className="text-[10px] text-destructive">{e.error}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function StatusDot({ status }: { status: "pending" | "ok" | "failed" }) {
  const cls =
    status === "ok"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : "bg-amber-400 animate-pulse";
  return <span className={cn("h-2 w-2 rounded-full", cls)} />;
}

