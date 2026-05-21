import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GenerationMode,
  useGenerationSession,
} from "./store/useGenerationSession";
import { useTestPlans } from "@/modules/test-plans";
import { adoErrorMessage } from "@/modules/ado";
import { useSourceDirGitInfo } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  ArrowLeft02Icon,
  CheckmarkCircle02Icon,
  CodeIcon,
  ExternalLink,
  GitBranchIcon,
  Key01Icon,
  PlayIcon,
  PlugSocketIcon,
  RefreshIcon,
  RemoveCircleIcon,
  Settings01Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { AnalyzeActivityLog } from "./components/AnalyzeActivityLog";
import { AttachmentList } from "./components/AttachmentList";
import { TargetContextChip } from "./components/TargetContextChip";
import {
  ingestFile,
  synthesizeClipboardImageName,
} from "./lib/ingestAttachment";
import { Attachment01Icon } from "@hugeicons/core-free-icons";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";

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
  const allowCodeSearch = useGenerationSession((s) => s.allowCodeSearch);
  const attachments = useGenerationSession((s) => s.attachments);
  const overrideModelId = useGenerationSession((s) => s.overrideModelId);
  const setRequirements = useGenerationSession((s) => s.setRequirements);
  const setMode = useGenerationSession((s) => s.setMode);
  const setTarget = useGenerationSession((s) => s.setTarget);
  const setAllowCodeSearch = useGenerationSession((s) => s.setAllowCodeSearch);
  const setOverrideModelId = useGenerationSession((s) => s.setOverrideModelId);
  const addRichAttachment = useGenerationSession((s) => s.addRichAttachment);
  const removeAttachment = useGenerationSession((s) => s.removeAttachment);
  const analyze = useGenerationSession((s) => s.analyze);
  const defaultModelId = useChatStore((s) => s.selectedModelId);
  const activeModelId = overrideModelId ?? defaultModelId;
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const aiEngine = usePreferencesStore((s) => s.aiEngine);
  const showCodeSearchToggle =
    aiEngine === "claude-agent-sdk" && !!sourceRoot;
  const [isDragOver, setIsDragOver] = useState(false);
  const [ingestErrors, setIngestErrors] = useState<string[]>([]);
  const filePickerRef = useRef<HTMLInputElement | null>(null);

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const errors: string[] = [];
      for (const f of files) {
        const result = await ingestFile(f);
        if (result.ok) {
          addRichAttachment(result.attachment);
        } else {
          errors.push(result.error.message);
        }
      }
      setIngestErrors(errors);
    },
    [addRichAttachment],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.files ?? []) as File[];
      // The clipboard often carries both a text payload AND a file (e.g.
      // pasting from Excel). Files take precedence; if any files came along,
      // suppress the default text insert so the user doesn't get both a
      // chip AND raw base64 dumped into the textarea.
      if (items.length === 0) return;
      e.preventDefault();
      // Clipboard images arrive with empty filenames — synthesize one so the
      // chip and dedup-by-path logic have something stable to key on.
      const named = items.map((f) => {
        if (f.name) return f;
        const synthetic = synthesizeClipboardImageName(f.type || "image/png");
        return new File([f], synthetic, { type: f.type });
      });
      void ingestFiles(named);
    },
    [ingestFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const onFilePicker = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      void ingestFiles(files);
      // Reset the input so picking the same file twice still fires onChange.
      e.target.value = "";
    },
    [ingestFiles],
  );

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
          {planId !== null && suiteId !== null ? (
            <TargetContextChip
              planId={planId}
              suiteId={suiteId}
              className="mb-1.5"
            />
          ) : null}
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragOver={(e) => {
              // Required to make the drop zone accept the drop event.
              e.preventDefault();
              if (!isDragOver) setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              // Only fire when leaving the wrapper, not when crossing into a
              // child element. The relatedTarget check protects against the
              // textarea bubbling its own dragleave when focus moves.
              if (
                !e.currentTarget.contains(e.relatedTarget as Node | null)
              ) {
                setIsDragOver(false);
              }
            }}
            onDrop={onDrop}
            className={cn(
              "relative rounded-md border bg-input/40 transition-colors",
              isDragOver
                ? "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30"
                : "border-border/60",
            )}
          >
            <textarea
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              onPaste={onPaste}
              placeholder="Paste the Asana task / Jira ticket / spec wiki here. Drop files or paste images directly — the analyzer reads them along with the spec."
              rows={10}
              className="w-full resize-y bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
            />
            {isDragOver ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-primary/[0.08] text-[12px] font-medium text-primary">
                Drop to attach
              </div>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              ref={filePickerRef}
              type="file"
              multiple
              hidden
              onChange={onFilePicker}
              accept="text/*,image/*,.ts,.tsx,.js,.jsx,.json,.md,.yaml,.yml,.toml,.py,.rs,.go,.java,.cs,.c,.cpp,.html,.css,.sh,.sql,.log"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => filePickerRef.current?.click()}
                >
                  <HugeiconsIcon
                    icon={Attachment01Icon}
                    size={11}
                    strokeWidth={1.75}
                  />
                  Attach files
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Or drop them on the spec, or paste images with Ctrl+V.
              </TooltipContent>
            </Tooltip>
            <AttachmentList
              attachments={attachments}
              onRemove={removeAttachment}
            />
          </div>
          {ingestErrors.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] text-destructive">
              {ingestErrors.map((m, i) => (
                <li key={i} className="font-mono">
                  {m}
                </li>
              ))}
            </ul>
          ) : null}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Test plan">
            <SearchableSelect
              ariaLabel="Test plan"
              value={planId !== null ? String(planId) : null}
              onValueChange={(v) => setTarget(Number(v), null)}
              disabled={!configured || plans.length === 0}
              placeholder={
                !configured
                  ? "Connect ADO first"
                  : plansLoading && plans.length === 0
                    ? "Loading plans…"
                    : plans.length === 0
                      ? "No plans found"
                      : "Choose a plan"
              }
              emptyLabel={
                plansLoading ? "Loading plans…" : "No plans in this project."
              }
              noResultsLabel="No matching plans"
              options={plans.map((p) => ({
                value: String(p.id),
                label: p.name,
                hint: `#${p.id}`,
              }))}
            />
          </Field>
          <Field label="Suite">
            <SearchableSelect
              ariaLabel="Suite"
              value={suiteId !== null ? String(suiteId) : null}
              onValueChange={(v) => setTarget(planId, Number(v))}
              disabled={planId === null || suites.length === 0}
              placeholder={
                planId === null
                  ? "Pick a plan first"
                  : suites.length === 0
                    ? "Loading suites…"
                    : "Choose a suite"
              }
              emptyLabel={
                planId === null
                  ? "Pick a plan first"
                  : "No suites in this plan."
              }
              noResultsLabel="No matching suites"
              options={suites.map((s) => ({
                value: String(s.id),
                label: s.name,
                hint: `#${s.id}`,
              }))}
            />
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

        {showCodeSearchToggle ? (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors hover:bg-foreground/[0.03]",
              allowCodeSearch
                ? "border-primary/40 bg-primary/[0.04]"
                : "border-border/50",
            )}
          >
            <Switch
              checked={allowCodeSearch}
              onCheckedChange={setAllowCodeSearch}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] font-medium">
                  Let the analyzer read source code
                </span>
                <span className="rounded-sm bg-foreground/[0.06] px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground">
                  Claude Code
                </span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                Runs the agent at{" "}
                <span className="font-mono text-foreground/85">
                  {sourceRoot}
                </span>{" "}
                with Read / Glob / Grep so cases are grounded in actual
                code paths. Off = spec + attachments only (faster, no disk
                access).
              </p>
            </div>
          </label>
        ) : null}

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
            label="Model"
            value={
              <ModelPicker
                value={activeModelId}
                onChange={(id) =>
                  setOverrideModelId(id === defaultModelId ? null : id)
                }
                side="bottom"
                align="end"
                trigger={({ label, provider }) => (
                  <span className="inline-flex items-center gap-1.5 rounded-sm border border-border/60 bg-card/70 px-1.5 py-0.5 text-[10.5px] hover:border-primary/60">
                    <ProviderIcon provider={provider} size={10} />
                    <span className="max-w-[140px] truncate">{label}</span>
                    {overrideModelId ? (
                      <span className="rounded-sm bg-primary/15 px-1 py-px font-mono text-[9px] uppercase tracking-wide text-primary">
                        override
                      </span>
                    ) : null}
                  </span>
                )}
              />
            }
          />
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
          {showCodeSearchToggle ? (
            <PreviewRow
              label="Code search"
              value={
                <span
                  className={cn(
                    "font-mono text-[10.5px]",
                    allowCodeSearch ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {allowCodeSearch ? "enabled" : "off"}
                </span>
              }
            />
          ) : null}
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
  const activityLog = useGenerationSession((s) => s.activityLog);

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

      <div>
        <h2 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Activity
        </h2>
        <AnalyzeActivityLog entries={activityLog} />
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
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-[12px] font-medium leading-snug">
                        {b.title}
                      </p>
                      <SeverityBadge severity={b.severity} />
                    </div>
                    {(() => {
                      const idx = b.linkedDraftCaseIndex;
                      const parent =
                        idx != null && idx >= 0 && idx < cases.length
                          ? cases[idx]
                          : null;
                      if (!parent) return null;
                      return (
                        <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                          Reproduces in:{" "}
                          <span className="font-medium text-foreground/85">
                            {parent.title}
                          </span>
                        </p>
                      );
                    })()}
                    <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground/85">
                      {b.reproSteps}
                    </p>
                    {b.codeRefs && b.codeRefs.length > 0 ? (
                      <BugCodeRefChips refs={b.codeRefs} />
                    ) : null}
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

/** Color-coded severity chip — visually distinguishes critical and high
 *  from medium / low so reviewers triage at a glance. */
function SeverityBadge({ severity }: { severity: string }) {
  const tone = severity.startsWith("1")
    ? "border-destructive/40 bg-destructive/15 text-destructive"
    : severity.startsWith("2")
      ? "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300"
      : severity.startsWith("3")
        ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "border-border/60 bg-card/60 text-muted-foreground";
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-tight",
        tone,
      )}
    >
      {severity}
    </span>
  );
}

/** Compact row of clickable code references on a bug suggestion. Clicking
 *  fires the same window event the BugPane uses (see BugPane.tsx) so the
 *  CodeViewer scrolls to the right line and highlights the range. */
function BugCodeRefChips({
  refs,
}: {
  refs: ReadonlyArray<{
    file: string;
    startLine: number;
    endLine?: number | null;
    symbol?: string | null;
  }>;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {refs.map((r, i) => {
        const lineLabel =
          r.endLine && r.endLine !== r.startLine
            ? `${r.startLine}–${r.endLine}`
            : `${r.startLine}`;
        return (
          <button
            key={`${r.file}-${i}`}
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("devops-studio:open-code-viewer", {
                  detail: {
                    path: r.file,
                    startLine: r.startLine,
                    endLine: r.endLine ?? undefined,
                  },
                }),
              );
            }}
            className="inline-flex items-center gap-1 rounded border border-border/60 bg-card/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
            title={r.symbol ?? undefined}
          >
            <HugeiconsIcon icon={CodeIcon} size={9} strokeWidth={1.75} />
            <span className="truncate">
              {r.file}:{lineLabel}
            </span>
          </button>
        );
      })}
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

// --- Error phase ------------------------------------------------------------

type ErrorClass = {
  /** Short uppercase code rendered in the header — terminal-flavored
   *  classification. Reads as a `grep`-able tag, not as casual copy. */
  code: string;
  /** Sentence-case title summarizing the failure. */
  title: string;
  /** Glyph in the left rail. Should map to the failure domain (key, plug,
   *  wifi, brain) rather than a generic warning triangle. */
  icon: typeof AlertCircleIcon;
  /** Short paragraph explaining what likely happened. Two sentences max. */
  why: string;
  /** Concrete next steps, ordered. */
  steps: string[];
  /** Tone the surface should adopt. */
  tone: "auth" | "config" | "network" | "validation" | "unknown";
  /** Primary action (e.g. open the right settings tab). */
  primary?: { label: string; icon: typeof Settings01Icon; onClick: () => void };
};

/** Map an error message to a structured remediation. Pattern-matches on the
 *  string contents because the underlying APIs throw plain Errors with
 *  human-readable messages — we lift those into something the user can act on
 *  instead of just dumping the text. */
function classifyError(
  message: string,
  errorPhase: ReturnType<typeof useGenerationSession.getState>["errorPhase"],
): ErrorClass {
  const lower = message.toLowerCase();

  if (
    /no api key configured for (\w+)/.test(lower) ||
    /missing.*api.?key/.test(lower) ||
    /api key.*not.*set/.test(lower)
  ) {
    const provider = lower.match(/no api key configured for (\w+)/)?.[1];
    return {
      code: "AUTH/01 · MISSING-KEY",
      title: provider
        ? `No ${capitalize(provider)} API key on file`
        : "No API key on file for the selected model",
      icon: Key01Icon,
      tone: "auth",
      why: provider
        ? `The model you have selected uses ${capitalize(
            provider,
          )}, but no ${capitalize(
            provider,
          )} key is stored in the keychain. The Generator routes by the active model — if Claude Code is set as your engine, pick a Claude model so the run goes through the CLI instead.`
        : "The active model needs an API key, and the keychain doesn't have one stored for that provider.",
      steps: [
        "Open Models settings and either paste a key for that provider, or switch the active model to one your current engine can drive.",
        "If you connected Claude Code, switch the active model to Claude Sonnet/Opus/Haiku so it goes through the CLI instead of the API.",
      ],
      primary: {
        label: "Open AI / Models",
        icon: AiBrain01Icon,
        onClick: () => void openSettingsWindow("models"),
      },
    };
  }

  if (
    /claude.*not.*installed/.test(lower) ||
    /claude.*path/.test(lower) ||
    /claude.*spawn/.test(lower) ||
    /not-installed/.test(lower)
  ) {
    return {
      code: "AUTH/02 · CLAUDE-CLI",
      title: "Claude Code CLI didn't respond",
      icon: PlugSocketIcon,
      tone: "auth",
      why: "We tried to run the Claude CLI to drive the run, but the binary either wasn't found on PATH or it failed before producing any output.",
      steps: [
        "Install Claude Code from claude.ai/code if you haven't.",
        "In Models settings, re-detect the CLI and run setup-token if the auth status is empty.",
      ],
      primary: {
        label: "Open AI / Models",
        icon: AiBrain01Icon,
        onClick: () => void openSettingsWindow("models"),
      },
    };
  }

  if (
    /network|timeout|econnreset|enotfound|fetch failed|getaddrinfo/.test(lower)
  ) {
    return {
      code: "NET/01 · UNREACHABLE",
      title: "Couldn't reach the model provider",
      icon: WifiDisconnected01Icon,
      tone: "network",
      why: "The HTTP request to the model API failed before a response came back. Most often this is a corporate proxy, an off-VPN session, or transient DNS.",
      steps: [
        "Check if anything else on your machine can reach the internet right now.",
        "If you're on a VPN/proxy, confirm the provider's domain isn't blocked.",
        "Retry — the run is idempotent until you publish.",
      ],
    };
  }

  if (
    /401|unauthorized|invalid.*api.?key|bad.?pat|forbidden|sso/.test(lower)
  ) {
    return {
      code: "AUTH/03 · REJECTED",
      title: "The provider rejected your credentials",
      icon: Key01Icon,
      tone: "auth",
      why: "The provider returned a 401/403. Either the stored API key is wrong, the key has been revoked, or your PAT needs SSO authorization.",
      steps: [
        "Regenerate the API key (or PAT) in the provider's console.",
        "Paste the new value into the relevant settings tab and retry.",
      ],
      primary: {
        label: "Open AI / Models",
        icon: AiBrain01Icon,
        onClick: () => void openSettingsWindow("models"),
      },
    };
  }

  if (errorPhase === "validation") {
    return {
      code: "INPUT/01 · INCOMPLETE",
      title: "Missing input",
      icon: AlertCircleIcon,
      tone: "validation",
      why: message,
      steps: [
        "Fill in the highlighted field on the input form and retry.",
      ],
    };
  }

  if (errorPhase === "publish") {
    return {
      code: "PUBLISH/01 · BLOCKED",
      title: "Publish couldn't start",
      icon: AlertCircleIcon,
      tone: "config",
      why: message,
      steps: [
        "Re-check the target plan and suite on the input form.",
        "If ADO authentication has expired, reconnect from settings.",
      ],
      primary: {
        label: "Open Azure DevOps",
        icon: Settings01Icon,
        onClick: () => void openSettingsWindow("azure-devops"),
      },
    };
  }

  return {
    code: "GEN/00 · UNCLASSIFIED",
    title: "Something went wrong",
    icon: AlertCircleIcon,
    tone: "unknown",
    why: "The run failed before we could route it into a specific recovery path. The raw message from the underlying SDK is below — paste it into an issue if it keeps happening.",
    steps: ["Click Retry to bounce back to the input form with your spec preserved."],
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const TONE_THEME: Record<
  ErrorClass["tone"],
  {
    rail: string;
    iconBg: string;
    iconFg: string;
    codeText: string;
    dot: string;
  }
> = {
  auth: {
    rail: "border-amber-500/30 from-amber-500/[0.06]",
    iconBg: "bg-amber-500/10 ring-amber-500/30",
    iconFg: "text-amber-500 dark:text-amber-400",
    codeText: "text-amber-600 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  config: {
    rail: "border-sky-500/30 from-sky-500/[0.06]",
    iconBg: "bg-sky-500/10 ring-sky-500/30",
    iconFg: "text-sky-500 dark:text-sky-400",
    codeText: "text-sky-600 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  network: {
    rail: "border-orange-500/30 from-orange-500/[0.06]",
    iconBg: "bg-orange-500/10 ring-orange-500/30",
    iconFg: "text-orange-500 dark:text-orange-400",
    codeText: "text-orange-600 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  validation: {
    rail: "border-violet-500/30 from-violet-500/[0.06]",
    iconBg: "bg-violet-500/10 ring-violet-500/30",
    iconFg: "text-violet-500 dark:text-violet-400",
    codeText: "text-violet-600 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  unknown: {
    rail: "border-destructive/40 from-destructive/[0.06]",
    iconBg: "bg-destructive/10 ring-destructive/30",
    iconFg: "text-destructive",
    codeText: "text-destructive",
    dot: "bg-destructive",
  },
};

function ErrorPhase() {
  const error = useGenerationSession((s) => s.error);
  const errorPhase = useGenerationSession((s) => s.errorPhase);
  const tryAgain = useGenerationSession((s) => s.tryAgain);
  const startNew = useGenerationSession((s) => s.startNew);

  const message =
    typeof error === "string"
      ? error
      : error
        ? adoErrorMessage(error)
        : "Unknown error";

  const klass = useMemo(
    () => classifyError(message, errorPhase),
    [message, errorPhase],
  );
  const theme = TONE_THEME[klass.tone];

  return (
    <div className="flex flex-col gap-3">
      {/* Header band — terminal-flavored classification badge. Matches the
          rest of the app's editor density: a dotted status indicator + a
          monospace code + the human-readable title. */}
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-gradient-to-br to-transparent",
          theme.rail,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-background/40 px-3 py-1.5 backdrop-blur-sm">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_6px_-1px]",
              theme.dot,
            )}
          />
          <span
            className={cn(
              "font-mono text-[10px] font-medium tracking-wider uppercase",
              theme.codeText,
            )}
          >
            {klass.code}
          </span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
            {errorPhase ? `phase: ${errorPhase}` : "phase: —"}
          </span>
        </div>

        <div className="flex items-start gap-3 px-4 py-4">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md ring-1",
              theme.iconBg,
            )}
          >
            <HugeiconsIcon
              icon={klass.icon}
              size={18}
              strokeWidth={1.5}
              className={theme.iconFg}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight">
              {klass.title}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {klass.why}
            </p>
          </div>
        </div>
      </div>

      {/* Steps — numbered, terminal-style list. Looks like a debug protocol,
          which is what it is. */}
      {klass.steps.length > 0 ? (
        <div className="rounded-md border border-border/60 bg-card/40">
          <div className="flex items-center gap-1.5 border-b border-border/40 bg-foreground/[0.02] px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              next steps
            </span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              {klass.steps.length.toString().padStart(2, "0")} action
              {klass.steps.length === 1 ? "" : "s"}
            </span>
          </div>
          <ol className="flex flex-col">
            {klass.steps.map((step, i) => (
              <li
                key={i}
                className={cn(
                  "grid grid-cols-[auto_1fr] items-start gap-2.5 px-3 py-2",
                  i < klass.steps.length - 1 && "border-b border-border/30",
                )}
              >
                <span className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
                <span className="text-[11.5px] leading-relaxed text-foreground/85">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* Raw error excerpt — collapsed by default so the recovery panel
          stays the focal point. Power users can still copy the original. */}
      <details className="rounded-md border border-border/60 bg-card/40">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-foreground">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={10}
            strokeWidth={1.75}
          />
          show raw error
        </summary>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-border/30 bg-background/40 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          {message}
        </pre>
      </details>

      {/* Action row — primary remediation on the left (when there is one)
          and the two recovery actions on the right. Retry preserves the
          form; Start over is the explicit "I'm done with this spec" path. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <div className="flex items-center gap-2">
          {klass.primary ? (
            <Button size="sm" onClick={klass.primary.onClick}>
              <HugeiconsIcon
                icon={klass.primary.icon}
                size={11}
                strokeWidth={1.75}
              />
              {klass.primary.label}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={tryAgain}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={11}
                  strokeWidth={1.75}
                />
                Retry
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Bounce back to the input form. Your spec, target plan, and
              attachments are kept intact.
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={startNew}>
                <HugeiconsIcon
                  icon={ArrowLeft02Icon}
                  size={11}
                  strokeWidth={1.75}
                />
                Start over
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Clear the form and start a fresh session.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
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
