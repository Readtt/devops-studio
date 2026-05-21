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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef } from "react";
import {
  type GenerationMode,
  useGenerationSession,
} from "./store/useGenerationSession";
import { useTestPlans } from "@/modules/test-plans";
import { adoErrorMessage } from "@/modules/ado";
import { useSourceDirGitInfo } from "@/modules/git";
import {
  AlertCircleIcon,
  ArrowLeft02Icon,
  CheckmarkCircle02Icon,
  ExternalLink,
  GitBranchIcon,
  PlayIcon,
  RemoveCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const MODE_LABELS: Record<GenerationMode, string> = {
  happy: "Happy path only",
  thorough: "Happy + edge + negative",
  "bug-hunt": "Bug-hunt (suggests bugs)",
};

const STEPS = [
  { id: "input", label: "input" },
  { id: "analyzing", label: "analyze" },
  { id: "review", label: "review" },
  { id: "publishing", label: "publish" },
  { id: "done", label: "done" },
] as const;

type Props = {
  initialPlanId?: number | null;
  initialSuiteId?: number | null;
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

  useEffect(() => {
    if (planId === null && initialPlanId) {
      setTarget(initialPlanId, initialSuiteId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <ProgressStrip phase={phase} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-5 py-4">
          {phase === "input" && <InputPhase />}
          {phase === "analyzing" && <AnalyzingPhase />}
          {phase === "review" && <ReviewPhase onOpenCase={onOpenCase} />}
          {phase === "publishing" && <PublishingPhase />}
          {phase === "done" && <DonePhase />}
          {phase === "error" && <ErrorPhase />}
        </div>
      </div>
    </div>
  );
}

// --- Progress strip ---------------------------------------------------------

/**
 * Editor-style typed header: `testgen → input · ANALYZE · review · publish · done`
 * The active step renders in primary mint with inverse-video; completed steps
 * dim, future steps muted. Way more characterful than the 5-circles wizard
 * pattern and reclaims vertical space.
 */
function ProgressStrip({
  phase,
}: {
  phase: ReturnType<typeof useGenerationSession.getState>["phase"];
}) {
  const startNew = useGenerationSession((s) => s.startNew);
  const currentIdx = useMemo(() => {
    if (phase === "error") return 0;
    return STEPS.findIndex((s) => s.id === phase);
  }, [phase]);

  return (
    <header className="flex h-9 shrink-0 items-center justify-between gap-4 border-b border-border/60 bg-card/40 px-5">
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
        <span className="font-semibold tracking-tight text-foreground/85">
          testgen
        </span>
        <span className="text-muted-foreground/60">→</span>
        <ol className="flex items-center gap-0">
          {STEPS.map((step, i) => {
            const completed = i < currentIdx;
            const active = i === currentIdx;
            return (
              <li key={step.id} className="flex items-center">
                {i > 0 ? (
                  <span className="px-1.5 text-muted-foreground/30">·</span>
                ) : null}
                <span
                  className={cn(
                    "transition-colors duration-150",
                    active
                      ? "rounded-sm bg-primary/15 px-1.5 py-0.5 font-semibold text-primary"
                      : completed
                        ? "text-foreground/55 line-through decoration-foreground/30"
                        : "text-muted-foreground/45",
                  )}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {phase !== "input" && phase !== "analyzing" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              onClick={startNew}
              aria-label="New session"
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} size={11} strokeWidth={1.75} />
              New session
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Clear and start a fresh generation.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  );
}

// --- Input phase ------------------------------------------------------------

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
  const planName = plans.find((p) => p.id === planId)?.name ?? null;
  const suiteName = suites.find((s) => s.id === suiteId)?.name ?? null;
  const git = useSourceDirGitInfo();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
      <section className="flex min-w-0 flex-col gap-3">
        <Field label="Requirements / feature spec">
          <textarea
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="Paste the Asana task / Jira ticket / spec wiki here. Be specific — the analyzer only knows what you put here plus any source files you attach."
            rows={10}
            className="w-full rounded-md border border-border/60 bg-input/40 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Test plan">
            <Select
              value={planId !== null ? String(planId) : ""}
              onValueChange={(v) => setTarget(Number(v), null)}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    !configured
                      ? "Connect ADO first"
                      : plansLoading && plans.length === 0
                        ? "Loading…"
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
          </Field>
          <Field label="Suite">
            <Select
              value={suiteId !== null ? String(suiteId) : ""}
              onValueChange={(v) => setTarget(planId, Number(v))}
              disabled={planId === null}
            >
              <SelectTrigger className="w-full">
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
          </Field>
        </div>

        <Field label="Generation mode">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as GenerationMode)}
            className="flex flex-col gap-1"
          >
            {(["happy", "thorough", "bug-hunt"] as GenerationMode[]).map((m) => (
              <label
                key={m}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px] transition-colors hover:bg-foreground/[0.03]",
                  mode === m
                    ? "border-primary/40 bg-primary/[0.05]"
                    : "border-border/50",
                )}
              >
                <RadioGroupItem value={m} className="size-3.5" />
                <span>{MODE_LABELS[m]}</span>
                {m === "thorough" ? (
                  <span className="ml-auto rounded-sm bg-foreground/[0.06] px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted-foreground">
                    Recommended
                  </span>
                ) : null}
              </label>
            ))}
          </RadioGroup>
        </Field>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-3">
          <Button onClick={analyze} disabled={!canAnalyze}>
            <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={2} />
            Analyze
          </Button>
        </div>
      </section>

      {/* Preview pane — what the run will actually do. Surfaces the things
          the user usually forgets to set (branch, source root, model) before
          firing off a 30-second analysis. */}
      <aside className="flex flex-col gap-2 lg:sticky lg:top-0 lg:self-start">
        <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Run preview
        </h2>
        <ul className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/40 p-2.5 text-[11px]">
          <PreviewRow label="Plan" value={planName ?? "—"} />
          <PreviewRow label="Suite" value={suiteName ?? "—"} />
          <PreviewRow label="Mode" value={MODE_LABELS[mode]} />
          <PreviewRow
            label="Branch"
            value={
              git.isRepo && git.branch ? (
                <span className="inline-flex items-center gap-1">
                  <HugeiconsIcon
                    icon={GitBranchIcon}
                    size={10}
                    strokeWidth={1.75}
                  />
                  <span className="font-mono">{git.branch}</span>
                </span>
              ) : (
                "no source dir"
              )
            }
          />
        </ul>
        <p className="text-[10px] leading-relaxed text-muted-foreground/85">
          The analyzer will read the spec above + any source files you've
          attached, then propose cases for the chosen suite. Nothing is
          published until you review.
        </p>
      </aside>
    </div>
  );
}

// --- Analyzing phase --------------------------------------------------------

function AnalyzingPhase() {
  const stepLabel = useGenerationSession((s) => s.stepLabel);
  const cancel = useGenerationSession((s) => s.cancel);
  const requirements = useGenerationSession((s) => s.requirements);
  const mode = useGenerationSession((s) => s.mode);

  // Allow Esc to cancel from any focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Spinner className="size-4 text-primary" />
          <div>
            <p className="text-[12px] font-medium">Analyzing requirements…</p>
            <p className="text-[10.5px] text-muted-foreground">
              {stepLabel || "Routing to the model."}
            </p>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Press Esc to cancel.</TooltipContent>
        </Tooltip>
      </div>

      <Field label={`Requirements (${MODE_LABELS[mode]})`}>
        <pre className="whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 px-3 py-2 font-mono text-[11px] text-foreground/80">
          {requirements.trim()}
        </pre>
      </Field>

      <div>
        <h2 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Proposed cases
        </h2>
        <ul className="flex flex-col gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <li
              key={i}
              className="flex flex-col gap-1.5 rounded-md border border-border/40 bg-card/30 px-3 py-2"
            >
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- Review phase -----------------------------------------------------------

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

  // Keyboard nav: j/k step through cases, space toggles keep, p publishes.
  const focusedRef = useRef(0);
  useEffect(() => {
    if (cases.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = (document.activeElement as HTMLElement | null)?.tagName ?? "";
      if (t === "INPUT" || t === "TEXTAREA") return;
      if (e.key === "j") {
        focusedRef.current = Math.min(cases.length - 1, focusedRef.current + 1);
        document
          .querySelector<HTMLElement>(`[data-case-row="${focusedRef.current}"]`)
          ?.focus();
      } else if (e.key === "k") {
        focusedRef.current = Math.max(0, focusedRef.current - 1);
        document
          .querySelector<HTMLElement>(`[data-case-row="${focusedRef.current}"]`)
          ?.focus();
      } else if (e.key === " " && focusedRef.current < cases.length) {
        const c = cases[focusedRef.current];
        if (c) {
          e.preventDefault();
          setCaseDecision(c.uid, c.decision === "keep" ? "skip" : "keep");
        }
      } else if (e.key.toLowerCase() === "p") {
        if (kept > 0) {
          e.preventDefault();
          void publish();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cases, kept, setCaseDecision, publish]);

  if (cases.length === 0 && bugs.length === 0) {
    return (
      <div className="overflow-hidden rounded-md border border-border/60 bg-card/40">
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-foreground/[0.03] px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500/80" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            empty result
          </span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
            review/0
          </span>
        </div>
        <div className="flex flex-col gap-3 px-5 py-5">
          <p className="text-[12.5px] font-medium leading-snug">
            The analyzer returned nothing for this spec.
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Empty results usually mean one of two things:
          </p>
          <ol className="ml-3 flex flex-col gap-1.5 text-[11px] text-foreground/85">
            <li className="flex gap-2">
              <span className="font-mono text-muted-foreground/70">01</span>
              <span>
                The spec lacks an actor or an outcome — &ldquo;the API does X&rdquo; is
                often enough; &ldquo;users do A and see B&rdquo; is better.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-muted-foreground/70">02</span>
              <span>
                The model didn&rsquo;t have enough source context. Attach the
                relevant files so it can see the actual handlers / components.
              </span>
            </li>
          </ol>
          <div className="mt-2 flex items-center gap-2 border-t border-border/40 pt-3">
            <Button size="sm" onClick={startNew}>
              <HugeiconsIcon icon={ArrowLeft02Icon} size={11} strokeWidth={1.75} />
              Refine spec
            </Button>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              ↵ to retry · esc to dismiss
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{cases.length}</span>{" "}
          case{cases.length === 1 ? "" : "s"}
          {bugs.length > 0
            ? `, ${bugs.length} bug suggestion${bugs.length === 1 ? "" : "s"}`
            : ""}
          {durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}.
          <span className="ml-2 text-muted-foreground/70">
            j/k to nav · space to toggle · p to publish
          </span>
        </p>
        <Button onClick={() => void publish()} disabled={kept === 0}>
          Publish {kept} case{kept === 1 ? "" : "s"}
          {keptBugs > 0 ? ` + ${keptBugs} bug${keptBugs === 1 ? "" : "s"}` : ""}
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {cases.map((c, i) => (
          <li key={c.uid}>
            <div
              tabIndex={0}
              data-case-row={i}
              className={cn(
                "group relative flex flex-col gap-1.5 rounded-md border-l-2 border bg-card/40 px-3 py-2 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-ring/30",
                "focus-visible:before:absolute focus-visible:before:-left-3 focus-visible:before:top-1/2 focus-visible:before:-translate-y-1/2 focus-visible:before:text-primary focus-visible:before:content-['▸']",
                c.decision === "keep"
                  ? "border-l-primary/70 border-border/60"
                  : "border-l-transparent border-border/20 opacity-60",
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={c.decision === "keep" ? "Skip" : "Keep"}
                  onClick={() =>
                    setCaseDecision(c.uid, c.decision === "keep" ? "skip" : "keep")
                  }
                  className={cn(
                    "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-all duration-150",
                    c.decision === "keep"
                      ? "bg-primary/20 text-primary hover:bg-primary/30"
                      : "bg-foreground/[0.08] text-muted-foreground hover:bg-foreground/[0.12]",
                  )}
                >
                  <HugeiconsIcon
                    icon={c.decision === "keep" ? CheckmarkCircle02Icon : RemoveCircleIcon}
                    size={11}
                    strokeWidth={1.75}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-[12px] font-medium leading-snug",
                      c.decision === "skip" && "line-through decoration-foreground/40",
                    )}
                  >
                    {c.title}
                  </p>
                  {c.rationale ? (
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {c.rationale}
                    </p>
                  ) : null}
                </div>
                <span className="text-[10px] text-muted-foreground/70">
                  {c.steps.length} step{c.steps.length === 1 ? "" : "s"}
                </span>
              </div>

              {c.similarMatches.length > 0 ? (
                <div className="ml-6 flex flex-col gap-0.5">
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

              <details className="ml-6">
                <summary className="cursor-pointer list-none text-[10.5px] text-muted-foreground hover:text-foreground">
                  Show steps
                </summary>
                <ol className="mt-1 flex flex-col gap-0.5 border-l border-border/40 pl-3 text-[11px]">
                  {c.steps.map((s, idx) => (
                    <li key={idx} className="grid grid-cols-[1fr_1fr] gap-3 py-0.5">
                      <div className="text-foreground/85">
                        <span className="mr-1 font-mono text-muted-foreground">
                          {idx + 1}.
                        </span>
                        {s.action}
                      </div>
                      <div className="text-muted-foreground">→ {s.expected}</div>
                    </li>
                  ))}
                </ol>
              </details>

              {c.tags.length > 0 ? (
                <div className="ml-6 flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-sm bg-foreground/[0.06] px-1.5 py-px text-[9.5px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {bugs.length > 0 ? (
        <section className="mt-1">
          <h2 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Bug suggestions
          </h2>
          <ul className="flex flex-col gap-1.5">
            {bugs.map((b) => (
              <li
                key={b.uid}
                className={cn(
                  "rounded-md border bg-card/40 px-3 py-2",
                  b.decision === "keep" ? "border-border/60" : "border-border/20 opacity-55",
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    aria-label={b.decision === "keep" ? "Skip" : "Keep"}
                    onClick={() =>
                      setBugDecision(b.uid, b.decision === "keep" ? "skip" : "keep")
                    }
                    className={cn(
                      "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors",
                      b.decision === "keep"
                        ? "bg-rose-500/15 text-rose-700 hover:bg-rose-500/25 dark:text-rose-300"
                        : "bg-foreground/[0.08] text-muted-foreground hover:bg-foreground/[0.12]",
                    )}
                  >
                    <HugeiconsIcon
                      icon={b.decision === "keep" ? CheckmarkCircle02Icon : RemoveCircleIcon}
                      size={11}
                      strokeWidth={1.75}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium">{b.title}</p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      Severity: {b.severity}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground/85">
                      {b.reproSteps}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// --- Publishing / Done / Error ---------------------------------------------

function PublishingPhase() {
  const log = useGenerationSession((s) => s.publishLog);
  const pending = log.filter((e) => e.status === "pending").length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <Spinner className="size-4 text-primary" />
        <p className="text-[12px]">
          Publishing… <span className="text-muted-foreground">{log.length - pending}/{log.length}</span>
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <p className="text-[12px] font-medium">
          Published <span className="text-emerald-700 dark:text-emerald-300">{ok}</span>
          {failed > 0 ? (
            <>
              {" · "}
              <span className="text-destructive">{failed} failed</span>
            </>
          ) : null}
          .
        </p>
        <Button onClick={startNew}>Start another</Button>
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
    <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/40 bg-destructive/[0.06] px-6 py-8 text-center">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={18}
        strokeWidth={1.5}
        className="text-destructive"
      />
      <p className="text-[12px] font-medium">Something went wrong.</p>
      <p className="max-w-[460px] whitespace-pre-wrap text-[11px] text-muted-foreground">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={startNew}>
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
    <ul className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/60 bg-card/40">
      {log.map((e) => (
        <li
          key={e.uid}
          className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
        >
          <StatusDot status={e.status} />
          <span className="inline-flex shrink-0 items-center rounded-sm bg-foreground/[0.06] px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
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
                size={10}
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
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", cls)} />;
}

// --- helpers ----------------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function PreviewRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </li>
  );
}
