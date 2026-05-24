import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  type PublishLogEntry,
  type SessionState,
  useGenerationSession,
  useGenerationSessionStore,
} from "./store/useGenerationSession";
import { useTestPlans } from "@/modules/test-plans";
import { adoErrorMessage, getWorkItemTitles } from "@/modules/ado";
import { useSourceDirGitInfo } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  ArrowLeft02Icon,
  BubbleChatIcon,
  Cancel01Icon,
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
import { EditableText } from "./components/EditableText";
import { RefineComposer } from "./components/RefineComposer";
import { ReviewChat } from "./components/ReviewChat";
import { TargetContextChip } from "./components/TargetContextChip";
import { BugCaseLinkPicker } from "./components/BugCaseLinkPicker";
import { CopyableSectionHeader } from "@/components/CopyableSectionHeader";
import {
  ingestFile,
  synthesizeClipboardImageName,
} from "./lib/ingestAttachment";
import { Attachment01Icon } from "@hugeicons/core-free-icons";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { getModel } from "@/modules/ai/config";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";

/** Tab title trimmer — keeps the cap below the visible width budget so
 *  multiple generator tabs side by side don't squish each other. */
function ellipsizeForTab(s: string, max = 36): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Resolve missing plan + suite names against the shared useTestPlans
 *  cache, fetching when nothing's cached. Wired into GeneratorPane so a
 *  draft loaded with bare ids (older runs, ADO-unreachable analyses)
 *  picks up its label as soon as the plan list lands. */
function useTabTargetNameBackfill({
  planId,
  suiteId,
  planName,
  suiteName,
  onResolved,
}: {
  planId: number | null;
  suiteId: number | null;
  planName: string | null;
  suiteName: string | null;
  onResolved: (planName: string | null, suiteName: string | null) => void;
}) {
  const plans = useTestPlans((s) => s.plans);
  const bySuite = useTestPlans((s) => s.bySuite);
  const refreshConnection = useTestPlans((s) => s.refreshConnection);
  const refreshPlans = useTestPlans((s) => s.refreshPlans);
  const loadSuites = useTestPlans((s) => s.loadSuites);
  const initialized = useTestPlans((s) => s.initialized);
  const configured = useTestPlans((s) => s.configured);
  const plansLoading = useTestPlans((s) => s.plansLoading);

  // 1. Ensure the connection + plan list are hydrated so we have something
  //    to resolve against. Cheap when already loaded.
  useEffect(() => {
    if (!initialized) {
      void refreshConnection();
    } else if (configured && plans.length === 0 && !plansLoading) {
      void refreshPlans();
    }
  }, [initialized, configured, plans.length, plansLoading, refreshConnection, refreshPlans]);

  // 2. When the session has a planId but no planName, look it up. Trigger
  //    a suites load too so suiteName can be resolved next pass.
  useEffect(() => {
    if (planId === null) return;
    if (!planName) {
      const plan = plans.find((p) => p.id === planId);
      if (plan?.name) {
        // We resolved plan but might still be missing suite — emit what
        // we have now, the next effect run will fill the suite.
        const suite =
          suiteId != null
            ? bySuite.get(planId)?.suites.find((s) => s.id === suiteId)?.name ??
              suiteName
            : suiteName;
        onResolved(plan.name, suite ?? null);
      }
    }
    if (suiteId !== null && !suiteName) {
      const planLoad = bySuite.get(planId);
      if (!planLoad || (planLoad.suites.length === 0 && !planLoad.loading)) {
        void loadSuites(planId);
        return;
      }
      const suite = planLoad.suites.find((s) => s.id === suiteId);
      if (suite?.name) {
        // Hand back the latest known plan + the newly-resolved suite.
        const resolvedPlanName =
          planName ?? plans.find((p) => p.id === planId)?.name ?? null;
        onResolved(resolvedPlanName, suite.name);
      }
    }
  }, [planId, suiteId, planName, suiteName, plans, bySuite, loadSuites, onResolved]);
}

/** Derive a tab label from the session's target (plan + suite) so users
 *  can scan multiple generator tabs at a glance. Generator sessions are
 *  identified by *what they're generating against*, not by the contents
 *  of the draft — the first-case-title heuristic kept changing the label
 *  as the user edited.
 *
 *  Format: "<Suite>"  if only the suite is named,
 *          "<Plan> · <Suite>" if both are named,
 *          fallback to "#<id>" for ids without resolved names,
 *          last-resort: trimmed spec excerpt or "Generate cases". */
function deriveTabLabelFromTarget(input: {
  planName: string | null;
  planId: number | null;
  suiteName: string | null;
  suiteId: number | null;
  requirements: string;
}): string {
  const plan = input.planName?.trim() || "";
  const suite = input.suiteName?.trim() || "";
  // Both names known → "<plan> · <suite>". Suite without a plan name →
  // suite alone (plan picker may still be loading). Names missing →
  // fall back to a numeric stub so the tab isn't blank while names
  // resolve.
  if (plan && suite) return ellipsizeForTab(`${plan} · ${suite}`, 48);
  if (suite) return ellipsizeForTab(suite);
  if (plan) return ellipsizeForTab(plan);
  if (input.suiteId) return `Suite #${input.suiteId}`;
  if (input.planId) return `Plan #${input.planId}`;
  const firstLine = input.requirements.trim().split("\n")[0];
  if (firstLine) return ellipsizeForTab(firstLine);
  return "Generate cases";
}

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
  /** Tab id this pane is rendered for. Used to scope the rename + phase
   *  reporter callbacks so multi-tab updates don't collide. */
  tabId?: number;
  initialPlanId?: number | null;
  initialSuiteId?: number | null;
  onOpenCase?: (input: { caseId: number; title: string }) => void;
  /** Rename the owning tab. The pane calls this once the draft has a
   *  reasonable label (first case title once review lands, etc.). */
  onRenameTab?: (tabId: number, title: string) => void;
  /** Report this session's phase + isRefining + runId up to App.tsx so
   *  the status bar can lock the model picker when the active tab has a
   *  draft, and so the tab metadata stays in sync with the live session
   *  (which lets "Open in review" dedup against existing tabs). */
  onReportSession?: (
    tabId: number,
    next: {
      phase: SessionState["phase"];
      isRefining: boolean;
      runId: string | null;
    },
  ) => void;
};

export function GeneratorPane({
  tabId,
  initialPlanId,
  initialSuiteId,
  onOpenCase,
  onRenameTab,
  onReportSession,
}: Props) {
  const phase = useGenerationSession((s) => s.phase);
  const setTarget = useGenerationSession((s) => s.setTarget);
  const setPlanSuiteNames = useGenerationSession((s) => s.setPlanSuiteNames);
  const planId = useGenerationSession((s) => s.planId);
  const suiteId = useGenerationSession((s) => s.suiteId);
  const planName = useGenerationSession((s) => s.planName);
  const suiteName = useGenerationSession((s) => s.suiteName);
  const isRefining = useGenerationSession((s) => s.isRefining);
  const requirements = useGenerationSession((s) => s.requirements);
  const sessionRunId = useGenerationSession((s) => s.runId);

  useEffect(() => {
    if (planId === null && initialPlanId) {
      setTarget(initialPlanId, initialSuiteId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report phase + isRefining + runId up so the App-level status bar can
  // lock the model picker when the active tab is mid-draft, and so the
  // tab metadata stays in sync once a fresh session lands its runId.
  // Cheap effect; the reducer in App.tsx no-ops when nothing changed.
  useEffect(() => {
    if (tabId === undefined || !onReportSession) return;
    onReportSession(tabId, { phase, isRefining, runId: sessionRunId });
  }, [tabId, onReportSession, phase, isRefining, sessionRunId]);

  // Rename the owning tab using the plan/suite identity — that's the
  // stable label the user actually thinks of the session by, and it
  // doesn't churn when they tweak case titles in review. Falls back to
  // a spec-excerpt for sessions that haven't picked a target yet.
  useEffect(() => {
    if (tabId === undefined || !onRenameTab) return;
    const label = deriveTabLabelFromTarget({
      planName,
      planId,
      suiteName,
      suiteId,
      requirements,
    });
    onRenameTab(tabId, label);
  }, [tabId, onRenameTab, planName, planId, suiteName, suiteId, requirements]);

  // Backfill plan + suite display names when a loaded draft has only ids
  // (sessions saved before names were captured, or ones where ADO was
  // unreachable at analyze time). Looks the names up via the shared
  // useTestPlans cache; `setPlanSuiteNames` persists them via the
  // draft autosave so the next reopen renders directly without lookup.
  useTabTargetNameBackfill({
    planId,
    suiteId,
    planName,
    suiteName,
    onResolved: setPlanSuiteNames,
  });

  // Ask panel visibility. Lives here (not inside ReviewChat) so the toggle
  // in the ProgressStrip can flip layout from a single scroll column to
  // a [content | ask] flex row — the chat sits *beside* the review content
  // rather than floating over it. Defaults closed; the user's first sight
  // of review should be the draft, not a chat empty state.
  const [chatOpen, setChatOpen] = useState(false);

  return (
    // @container marks this as the responsive root — Tailwind v4 container
    // queries (@sm, @md, @lg below) react to the pane width instead of the
    // viewport width, so splitting the workspace narrow no longer collapses
    // the layout: it adapts to its actual room. Mirrors the pattern card.tsx
    // already uses.
    <div className="@container flex h-full flex-col bg-background">
      <ProgressStrip
        phase={phase}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* px-3 on narrow panes, px-5 once we have the room — the
              old px-5 was eating chrome inside a 320 px column. */}
          <div className="mx-auto w-full max-w-4xl px-3 py-4 @md:px-5">
            {phase === "input" && <InputPhase />}
            {phase === "analyzing" && <AnalyzingPhase />}
            {phase === "review" && <ReviewPhase onOpenCase={onOpenCase} />}
            {phase === "publishing" && <PublishingPhase />}
            {phase === "done" && <DonePhase />}
            {phase === "error" && <ErrorPhase />}
          </div>
        </div>
        {phase === "review" && chatOpen ? (
          <ReviewChat onClose={() => setChatOpen(false)} />
        ) : null}
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
  chatOpen,
  onToggleChat,
}: {
  phase: SessionState["phase"];
  /** Whether the Ask side panel is currently visible. The toggle lives in
   *  this header (no more floating right-edge tab) so the user can see at
   *  a glance whether the chat would consume their pane width on toggle. */
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  const startNew = useGenerationSession((s) => s.startNew);
  const goToInput = useGenerationSession((s) => s.goToInput);
  const goToReview = useGenerationSession((s) => s.goToReview);
  const goToDone = useGenerationSession((s) => s.goToDone);
  const cases = useGenerationSession((s) => s.cases);
  const bugs = useGenerationSession((s) => s.bugs);
  const publishLog = useGenerationSession((s) => s.publishLog);
  const currentIdx = useMemo(() => {
    if (phase === "error") return 0;
    return STEPS.findIndex((s) => s.id === phase);
  }, [phase]);
  // Whether each step has *actually* happened in this run, independent of
  // where the user is right now. A breadcrumb-back to input shouldn't make
  // analyze look "future" — it already ran for this draft. Same for publish
  // once the publish log has entries.
  const hasDraft = cases.length > 0 || bugs.length > 0;
  const hasPublished = publishLog.length > 0;

  // Decide which breadcrumb steps the user can actually jump to. We never
  // permit jumping INTO analyze / publishing — those are in-flight phases
  // and bouncing into them mid-run would corrupt state. Review, input, and
  // done are safe targets as long as the prerequisite data exists.
  const canReachInput = phase !== "analyzing" && phase !== "publishing";
  const canReachReview =
    hasDraft && phase !== "analyzing" && phase !== "publishing";
  // Done is reachable once publish has actually run — without a publish log
  // there's nothing to show on the success screen.
  const canReachDone =
    publishLog.length > 0 && phase !== "analyzing" && phase !== "publishing";
  const navigators: Partial<
    Record<(typeof STEPS)[number]["id"], { onClick: () => void; hint: string }>
  > = {};
  if (canReachInput) {
    navigators.input = {
      onClick: goToInput,
      hint: "Back to the spec / target form (your draft stays put)",
    };
  }
  if (canReachReview) {
    navigators.review = {
      onClick: goToReview,
      hint: "Return to the review pane",
    };
  }
  if (canReachDone) {
    navigators.done = {
      onClick: goToDone,
      hint: "Return to the publish summary",
    };
  }

  return (
    <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-card/40 px-3 @md:gap-4 @md:px-5">
      {/* Breadcrumb: full chain on @md+, collapsed to just the active step
          on narrow panes. The intermediate steps don't communicate enough
          to justify the line wrap they'd cause below ~440 px. */}
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
        <span className="hidden font-semibold tracking-tight text-foreground/85 @md:inline">
          testgen
        </span>
        <span className="hidden text-muted-foreground/60 @md:inline">→</span>
        <ol className="hidden items-center gap-0 @md:flex">
          {STEPS.map((step, i) => {
            // Two paths to "completed":
            //  1. The current phase is past this step in the canonical order.
            //  2. The user has navigated *back* (input/review breadcrumbs)
            //     to a phase that's behind this step, but the work for this
            //     step has already happened in this run — analyze produced
            //     cases, or publish wrote at least one ADO row. Without
            //     this second clause, jumping back to input made analyze
            //     render as a "future" step even though there's a draft
            //     on screen, which the user (correctly) read as a bug.
            const completedByOrder = i < currentIdx;
            const completedByEvidence =
              (step.id === "analyzing" && hasDraft) ||
              (step.id === "publishing" && hasPublished);
            const completed = completedByOrder || completedByEvidence;
            const active = i === currentIdx;
            const nav = active ? undefined : navigators[step.id];
            const label = (
              <span
                className={cn(
                  "transition-colors duration-150",
                  active
                    ? "rounded-sm bg-primary/15 px-1.5 py-0.5 font-semibold text-primary"
                    : completed
                      ? "text-foreground/55 line-through decoration-foreground/30"
                      : "text-muted-foreground/45",
                  // Dotted underline announces clickability without competing
                  // with the strike-through on completed steps — the cursor +
                  // hover bg confirm it on pointer movement.
                  nav &&
                    "cursor-pointer rounded-sm px-1 py-0.5 underline decoration-dotted underline-offset-4 decoration-foreground/30 hover:bg-foreground/[0.06] hover:text-foreground hover:decoration-primary/70 hover:no-underline-strike",
                )}
              >
                {step.label}
              </span>
            );
            return (
              <li key={step.id} className="flex items-center">
                {i > 0 ? (
                  <span className="px-1.5 text-muted-foreground/30">·</span>
                ) : null}
                {nav ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={nav.onClick}
                        aria-label={`Jump to ${step.label} phase`}
                        className="font-mono"
                      >
                        {label}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {nav.hint}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  label
                )}
              </li>
            );
          })}
        </ol>
        {/* Narrow-pane fallback: just the active step in primary mint —
            same chip styling as the expanded breadcrumb's active state so
            the visual rhythm stays consistent. */}
        <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 font-semibold text-primary @md:hidden">
          {STEPS[Math.max(0, currentIdx)]?.label ?? phase}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {/* Ask toggle. Only shows in review — that's where the panel
            actually mounts. Putting it next to "New session" gives the
            user a clear control surface for both "do another thing"
            and "stop chatting" without forcing them to find a floating
            edge-tab on the right. */}
        {phase === "review" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant={chatOpen ? "secondary" : "ghost"}
                onClick={onToggleChat}
                aria-label={chatOpen ? "Hide Ask panel" : "Show Ask panel"}
                aria-pressed={chatOpen}
              >
                <HugeiconsIcon
                  icon={BubbleChatIcon}
                  size={11}
                  strokeWidth={1.75}
                />
                Ask
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
              {chatOpen
                ? "Close the chat — you'll get the full pane back for review."
                : "Open a read-only Q&A panel beside this draft. Useful for “do these cover X?” — use Refine to actually change cases."}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* The error phase has its own Retry / Start over pair — surfacing
            another "New session" affordance at the top of the same screen was
            a foot-gun: a quick click here looks like "go back to retry" but
            actually wipes the spec. Limit the header button to review / done
            phases where it unambiguously means "throw this away". */}
        {phase === "review" || phase === "done" ? (
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
      </div>
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
  // Cases/bugs survive a breadcrumb-back to input. A second analyze would
  // silently discard that draft once the model returns — so we gate the
  // button behind a confirm dialog when a draft is present. Empty state
  // (fresh session) bypasses the dialog so the common case stays one click.
  const draftCases = useGenerationSession((s) => s.cases);
  const draftBugs = useGenerationSession((s) => s.bugs);
  const hasDraft = draftCases.length > 0 || draftBugs.length > 0;
  const [reAnalyzeOpen, setReAnalyzeOpen] = useState(false);
  const sessionStore = useGenerationSessionStore();
  const defaultModelId = useChatStore((s) => s.selectedModelId);
  const activeModelId = overrideModelId ?? defaultModelId;
  const activeModel = getModel(activeModelId);
  const defaultModel = getModel(defaultModelId);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const aiEngine = usePreferencesStore((s) => s.aiEngine);
  const availability = useModelAvailability();
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
    // Container-query-driven layout: stack vertically on narrow panes, side-
    // by-side only once we have real room. @3xl (≈ 48rem ≈ 768px container)
    // is the right breakpoint here — the previous @xl (576px) would split
    // into two columns the moment the pane crossed half-width on a typical
    // monitor, which left both columns visibly congested (the spec textarea
    // shrank to ~280px and the Run preview pushed against it). Now the
    // user has to genuinely have room for the two-column layout before it
    // appears; otherwise the form stacks above the preview, both with the
    // full pane width.
    <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[1fr_280px]">
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
              placeholder={
                "Paste the Asana task / Jira ticket / spec wiki here. Drop files or paste images directly — the analyzer reads them along with the spec.\n\nIf you have changeset notes (commit messages, PR description, diff, ADO changeset URL), paste them at the bottom — the analyzer uses them to narrow scope."
              }
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
            <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1.5">
              <ul className="flex min-w-0 flex-1 flex-col gap-0.5 text-[10.5px] text-destructive">
                {ingestErrors.map((m, i) => (
                  <li key={i} className="font-mono">
                    {m}
                  </li>
                ))}
              </ul>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setIngestErrors([])}
                    aria-label="Dismiss attachment errors"
                    className="shrink-0 rounded p-0.5 text-destructive/70 hover:bg-destructive/15 hover:text-destructive"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[11px]">
                  Dismiss
                </TooltipContent>
              </Tooltip>
            </div>
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
          {/* Per-run model picker. Picks up the current default from the
              status bar / settings, but lets the user swap for just this
              generation. Hidden providers (no key, wrong engine) drop out
              automatically so the dropdown only ever shows usable choices. */}
          <ModelPicker
            value={activeModelId}
            onChange={(id) =>
              setOverrideModelId(id === defaultModelId ? null : id)
            }
            filter={availability.isAvailable}
            side="top"
            align="start"
            emptyMessage={
              aiEngine === "claude-agent-sdk" ? (
                <>
                  Claude Code drives Anthropic models only. Switch engines in
                  Settings → Models for BYOK access.
                </>
              ) : (
                <>No providers connected. Add one in Settings → Models.</>
              )
            }
            trigger={({ provider }) => (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      // Two visual states, both with their own scope tag so
                      // there's no ambiguity about whether this run inherits
                      // the persisted default or carries a per-run swap.
                      // Override gets the primary accent; the default-state
                      // chip stays understated so the picker reads as a hint,
                      // not a CTA.
                      "inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border bg-card px-2.5 text-[11.5px] transition-colors hover:border-primary/60",
                      overrideModelId
                        ? "border-primary/50 bg-primary/[0.06]"
                        : "border-border/60",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1 py-px font-mono text-[9.5px] uppercase tracking-wide",
                        overrideModelId
                          ? "bg-primary/15 text-primary"
                          : "bg-foreground/[0.06] text-muted-foreground",
                      )}
                    >
                      {overrideModelId ? "run-only" : "default"}
                    </span>
                    <ProviderIcon provider={provider} size={12} />
                    <span className="min-w-0 max-w-[180px] truncate font-medium">
                      {activeModel.label}
                    </span>
                    {/* Hint text is purely informational ("fast", "balanced",
                        etc.) — drop it on narrow panes so the model label
                        gets the room to breathe instead of competing for it. */}
                    <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/85 @md:inline">
                      · {activeModel.hint.toLowerCase()}
                    </span>
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={10}
                      strokeWidth={2}
                      className="shrink-0 opacity-60"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  variant="panel"
                  className="max-w-[300px] px-3 py-2 text-[11px] leading-relaxed"
                >
                  {overrideModelId ? (
                    <p>
                      <span className="font-medium">Run-only override.</span>{" "}
                      This generation uses{" "}
                      <span className="font-mono">{activeModel.label}</span>{" "}
                      instead of the default{" "}
                      <span className="font-mono">{defaultModel.label}</span>.
                      The choice resets when you start a new session.
                    </p>
                  ) : (
                    <p>
                      <span className="font-medium">Default model.</span> Pick
                      a different one here to swap models for just this run —
                      it won't change the persisted default in the status bar
                      / settings.
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          />
          {overrideModelId ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setOverrideModelId(null)}
                  aria-label="Use default model"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    size={10}
                    strokeWidth={1.75}
                  />
                  Use default
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                variant="panel"
                className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
              >
                Drop the per-run override and use the persisted default (
                <span className="font-mono">{defaultModel.label}</span>).
              </TooltipContent>
            </Tooltip>
          ) : null}
          <span className="flex-1" />
          {hasDraft ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => void sessionStore.getState().goToReview()}
                  aria-label="Back to current draft"
                >
                  <HugeiconsIcon icon={ArrowLeft02Icon} size={11} strokeWidth={2} />
                  Back to draft
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[260px] text-[11px]">
                You have {draftCases.length} case
                {draftCases.length === 1 ? "" : "s"} in review. Pick up where
                you left off instead of re-running the analyzer.
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Button
            onClick={() => {
              if (hasDraft) setReAnalyzeOpen(true);
              else void analyze();
            }}
            disabled={!canAnalyze}
          >
            <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={2} />
            {hasDraft ? "Re-analyze" : "Analyze"}
          </Button>
        </div>

        {/* Re-analyze confirm. Discarding a hand-edited draft because of a
            stray click is the kind of silent loss the user explicitly
            asked us to prevent — surface it once with a clear cost. */}
        <AlertDialog open={reAnalyzeOpen} onOpenChange={setReAnalyzeOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Discard the current draft and re-analyze?
              </AlertDialogTitle>
              <AlertDialogDescription>
                You have {draftCases.length} case
                {draftCases.length === 1 ? "" : "s"}
                {draftBugs.length > 0
                  ? ` and ${draftBugs.length} bug suggestion${draftBugs.length === 1 ? "" : "s"}`
                  : ""}{" "}
                in review, including any manual edits. Re-analyzing replaces
                that draft with whatever the model returns next — there's no
                undo for this step.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the draft</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setReAnalyzeOpen(false);
                  void analyze();
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Discard &amp; re-analyze
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>

      {/* Preview pane — what the run will actually do. Surfaces the things
          the user usually forgets to set (branch, source root, model) before
          firing off a 30-second analysis. Sticky binding matches the
          two-column breakpoint (@3xl) — the sticky behavior only applies
          when the aside is actually a side column, never when it's stacked
          below the form. */}
      <aside className="flex flex-col gap-2 @3xl:sticky @3xl:top-0 @3xl:self-start">
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
              overrideModelId ? (
                <span className="inline-flex flex-col items-end gap-0.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="rounded-sm bg-primary/15 px-1 py-px font-mono text-[9px] text-primary">
                      run
                    </span>
                    <ProviderIcon provider={activeModel.provider} size={10} />
                    <span className="max-w-[140px] truncate font-mono text-[10.5px] text-primary/90">
                      {activeModel.label}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
                    <span className="rounded-sm bg-foreground/[0.06] px-1 py-px font-mono text-[9px]">
                      default
                    </span>
                    <span className="max-w-[140px] truncate font-mono text-[10px] line-through decoration-muted-foreground/30">
                      {defaultModel.label}
                    </span>
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="rounded-sm bg-foreground/[0.06] px-1 py-px font-mono text-[9px] text-muted-foreground">
                    default
                  </span>
                  <ProviderIcon provider={activeModel.provider} size={10} />
                  <span className="max-w-[140px] truncate font-mono text-[10.5px]">
                    {activeModel.label}
                  </span>
                </span>
              )
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
  const attachments = useGenerationSession((s) => s.attachments);
  // Long specs dominate the analyzing view — collapse anything past ~12
  // lines / 800 chars by default so the focus stays on the streaming log.
  const isLongSpec =
    requirements.length > 800 || requirements.split("\n").length > 12;
  const [specOpen, setSpecOpen] = useState(!isLongSpec);

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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Spinner className="size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-[12px] font-medium">Analyzing requirements…</p>
            <p className="truncate text-[10.5px] text-muted-foreground">
              {stepLabel || "Routing to the model."}
            </p>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={cancel} className="shrink-0">
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

      {/* Collapsible spec — defaults to closed for long pastes so the user
          can keep eyes on the streaming activity log without scrolling
          past hundreds of lines of requirements. */}
      <section>
        <button
          type="button"
          onClick={() => setSpecOpen((v) => !v)}
          className="mb-1.5 flex w-full items-center gap-1.5 rounded-sm px-1 text-left text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <HugeiconsIcon
            icon={specOpen ? ArrowDown01Icon : ArrowRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
          <span>Requirements ({MODE_LABELS[mode]})</span>
          <span className="ml-1 font-mono normal-case text-[9.5px] text-muted-foreground/55">
            {requirements.length.toLocaleString()} chars
          </span>
        </button>
        {specOpen ? (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 px-3 py-2 font-mono text-[11px] text-foreground/80">
            {requirements.trim()}
          </pre>
        ) : (
          <p className="line-clamp-2 rounded-md border border-dashed border-border/40 bg-muted/15 px-3 py-2 font-mono text-[11px] italic text-muted-foreground/85">
            {requirements.trim().slice(0, 280)}
            {requirements.length > 280 ? "…" : ""}
          </p>
        )}
      </section>

      {/* Attachments the analyst is actually seeing. Read-only here — the
          analyzing phase is no place to remove inputs mid-run. */}
      {attachments.length > 0 ? (
        <section>
          <h2 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Attachments ({attachments.length})
          </h2>
          <AttachmentList attachments={attachments} />
        </section>
      ) : null}

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
  const setCaseTitle = useGenerationSession((s) => s.setCaseTitle);
  const setCaseRationale = useGenerationSession((s) => s.setCaseRationale);
  const setCaseStep = useGenerationSession((s) => s.setCaseStep);
  const addCaseStep = useGenerationSession((s) => s.addCaseStep);
  const removeCaseStep = useGenerationSession((s) => s.removeCaseStep);
  const setBugTitle = useGenerationSession((s) => s.setBugTitle);
  const setBugReproSteps = useGenerationSession((s) => s.setBugReproSteps);
  const publish = useGenerationSession((s) => s.publish);
  const startNew = useGenerationSession((s) => s.startNew);
  const durationMs = useGenerationSession((s) => s.durationMs);
  const isRefining = useGenerationSession((s) => s.isRefining);
  const publishLog = useGenerationSession((s) => s.publishLog);

  const kept = useMemo(
    () => cases.filter((c) => c.decision === "keep").length,
    [cases],
  );
  const keptBugs = useMemo(
    () => bugs.filter((b) => b.decision === "keep").length,
    [bugs],
  );
  // Map of uid → publish result so individual rows can render a "Published"
  // chip and the Publish button can show count-of-unpublished. Populated
  // when the user navigates Done → Review (the publishLog persists across
  // the phase swap) so we know which draft items already exist in ADO.
  const publishedByUid = useMemo(() => {
    const map = new Map<string, PublishLogEntry>();
    for (const l of publishLog) {
      if (l.status === "ok") map.set(l.uid, l);
    }
    return map;
  }, [publishLog]);
  const keptCasesUnpublished = useMemo(
    () =>
      cases.filter((c) => c.decision === "keep" && !publishedByUid.has(c.uid))
        .length,
    [cases, publishedByUid],
  );
  const keptBugsUnpublished = useMemo(
    () =>
      bugs.filter((b) => b.decision === "keep" && !publishedByUid.has(b.uid))
        .length,
    [bugs, publishedByUid],
  );
  const hasAnyPublished = publishedByUid.size > 0;

  // Keyboard nav: j/k step through the full list (cases first, then bugs).
  // Indices in [0, cases.length) target cases via [data-case-row=…]; indices
  // in [cases.length, cases.length + bugs.length) target bugs via
  // [data-bug-row=…] with the bug-local index. Space toggles keep on whichever
  // row is focused; p publishes when at least one case is kept.
  const focusedRef = useRef(0);
  useEffect(() => {
    const total = cases.length + bugs.length;
    if (total === 0) return;
    const focusIndex = (n: number) => {
      const clamped = Math.max(0, Math.min(total - 1, n));
      focusedRef.current = clamped;
      const el =
        clamped < cases.length
          ? document.querySelector<HTMLElement>(
              `[data-case-row="${clamped}"]`,
            )
          : document.querySelector<HTMLElement>(
              `[data-bug-row="${clamped - cases.length}"]`,
            );
      el?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const t = active?.tagName ?? "";
      // Don't hijack typing inside form controls — including the EditableText
      // editors that swap in <input> / <textarea> when the user clicks a title.
      if (t === "INPUT" || t === "TEXTAREA") return;
      if (e.key === "j") {
        focusIndex(focusedRef.current + 1);
      } else if (e.key === "k") {
        focusIndex(focusedRef.current - 1);
      } else if (e.key === " ") {
        // Resolve the toggle target from the actually-focused row, NOT from
        // focusedRef. The ref is only updated by j/k — if the user clicked a
        // row to focus it, the ref is stale and space would toggle the wrong
        // item (which is exactly the "space doesn't disable bugs when I click
        // them" bug). data-case-row / data-bug-row are the canonical row ids.
        const caseAttr = active?.dataset.caseRow;
        const bugAttr = active?.dataset.bugRow;
        if (caseAttr !== undefined) {
          const c = cases[Number(caseAttr)];
          if (c) {
            e.preventDefault();
            setCaseDecision(c.uid, c.decision === "keep" ? "skip" : "keep");
            // Re-sync the j/k cursor to the row we just acted on so the next
            // j/k press continues from where the user is, not from wherever
            // they last keyboard-navigated.
            focusedRef.current = Number(caseAttr);
          }
        } else if (bugAttr !== undefined) {
          const b = bugs[Number(bugAttr)];
          if (b) {
            e.preventDefault();
            setBugDecision(b.uid, b.decision === "keep" ? "skip" : "keep");
            focusedRef.current = cases.length + Number(bugAttr);
          }
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
  }, [cases, bugs, kept, setCaseDecision, setBugDecision, publish]);

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

  const publishCount =
    keptCasesUnpublished +
    (keptBugsUnpublished > 0 ? keptBugsUnpublished : 0);

  return (
    <div className="flex flex-col gap-3">
      {hasAnyPublished ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          <p className="leading-relaxed">
            {publishedByUid.size} item{publishedByUid.size === 1 ? "" : "s"}{" "}
            already published. Edits here only change the draft —{" "}
            <span className="font-medium">use the test case / bug pane</span>{" "}
            to sync title changes back to ADO. Clicking Publish skips
            already-published rows so duplicates aren&apos;t created.
          </p>
        </div>
      ) : null}
      {/* Header row — flex-wraps on narrow panes so the Publish button
          drops onto its own line instead of squeezing the counts text
          to a single-character ellipsis. The keyboard-shortcut tail is
          hidden on small widths since it's a power-user hint that just
          clutters a cramped header. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <p className="min-w-0 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{cases.length}</span>{" "}
          case{cases.length === 1 ? "" : "s"}
          {bugs.length > 0
            ? `, ${bugs.length} bug suggestion${bugs.length === 1 ? "" : "s"}`
            : ""}
          {durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}.
          <span className="ml-2 hidden text-muted-foreground/70 @md:inline">
            j/k to nav cases &amp; bugs · space to toggle · p to publish
          </span>
        </p>
        <Button
          onClick={() => void publish()}
          disabled={publishCount === 0}
          className="shrink-0"
        >
          {hasAnyPublished
            ? publishCount === 0
              ? "All kept items published"
              : `Publish ${publishCount} new`
            : `Publish ${kept} case${kept === 1 ? "" : "s"}${
                keptBugs > 0
                  ? ` + ${keptBugs} bug${keptBugs === 1 ? "" : "s"}`
                  : ""
              }`}
        </Button>
      </div>

      <CopyableSectionHeader
        label="Cases"
        kind="Test Case"
        items={cases
          .filter((c) => c.decision === "keep")
          .map((c) => ({ id: null, title: c.title }))}
        count={cases.length}
      />

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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={c.decision === "keep" ? "Skip" : "Keep"}
                      onClick={() =>
                        setCaseDecision(
                          c.uid,
                          c.decision === "keep" ? "skip" : "keep",
                        )
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
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-[11px]">
                    {c.decision === "keep"
                      ? "Skip this case (won't be published)"
                      : "Keep this case (will be published on Publish)"}
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <EditableText
                    value={c.title}
                    onCommit={(next) => setCaseTitle(c.uid, next)}
                    placeholder="(no title — click to edit)"
                    variant="singleline"
                    ariaLabel="Case title"
                    className={cn(
                      "block text-[12px] font-medium leading-snug",
                      c.decision === "skip" &&
                        "line-through decoration-foreground/40",
                    )}
                  />
                  <div className="mt-0.5">
                    <EditableText
                      value={c.rationale}
                      onCommit={(next) => setCaseRationale(c.uid, next)}
                      placeholder="(add a one-line rationale)"
                      variant="multiline"
                      ariaLabel="Case rationale"
                      className="block text-[10.5px] text-muted-foreground"
                    />
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help text-[10px] text-muted-foreground/70">
                      {c.steps.length} step{c.steps.length === 1 ? "" : "s"}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-[11px]">
                    Expand &ldquo;Show steps&rdquo; below to read or edit them
                  </TooltipContent>
                </Tooltip>
              </div>

              {c.similarMatches.length > 0 ? (
                <div className="ml-6 flex flex-col gap-0.5">
                  {c.similarMatches.map((m) => (
                    <div
                      key={m.caseId}
                      className="flex items-center gap-1.5 text-[10.5px] text-amber-700 dark:text-amber-300"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help rounded-sm bg-amber-500/15 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide">
                            {(m.score * 100).toFixed(0)}%
                          </span>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          variant="panel"
                          className="max-w-[260px] px-3 py-2 text-[11px] leading-relaxed"
                        >
                          Title similarity to an existing case in this suite.
                          You can publish the new case anyway, but ≥85% usually
                          means the existing case already covers it.
                        </TooltipContent>
                      </Tooltip>
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

              <details className="ml-6 group/steps">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground hover:text-foreground">
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    size={9}
                    strokeWidth={1.75}
                    className="transition-transform group-open/steps:rotate-90"
                  />
                  <span>Show steps</span>
                  <span className="font-mono text-[9.5px] text-muted-foreground/55">
                    · click any field to edit
                  </span>
                </summary>
                <ol className="mt-1.5 flex flex-col gap-1 border-l border-border/40 pl-3 text-[11px]">
                  {c.steps.map((s, idx) => (
                    // Narrow panes (default): stack action over expected
                    // under one row number — the inline 5-col grid below
                    // squeezed everything to a single-char ellipsis once
                    // the pane dropped below ~480px. Wider panes (@md+)
                    // get the original action → expected → remove inline
                    // layout back. The remove button sits with the row
                    // number on the stacked view so it stays accessible
                    // without inflating the row.
                    <li
                      key={idx}
                      className="group/step grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5 py-0.5 @md:grid-cols-[auto_1fr_auto_1fr_auto]"
                    >
                      <div className="flex items-center gap-1 @md:contents">
                        <span className="mt-px font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        {/* Narrow-only remove — wider panes use the
                            inline button on the row's right edge. */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Remove step ${idx + 1}`}
                              disabled={c.steps.length <= 1}
                              onClick={() => removeCaseStep(c.uid, idx)}
                              className={cn(
                                "inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/40 hover:bg-destructive/15 hover:text-destructive @md:hidden",
                                c.steps.length <= 1 && "cursor-not-allowed",
                              )}
                            >
                              <HugeiconsIcon
                                icon={Cancel01Icon}
                                size={9}
                                strokeWidth={2}
                              />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="text-[11px]">
                            {c.steps.length <= 1
                              ? "Cases must have at least one step"
                              : "Remove this step"}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <EditableText
                        value={s.action}
                        onCommit={(next) =>
                          setCaseStep(c.uid, idx, { action: next })
                        }
                        placeholder="(action)"
                        variant="multiline"
                        ariaLabel={`Step ${idx + 1} action`}
                        className="block text-foreground/85"
                      />
                      <span className="mt-px hidden shrink-0 text-muted-foreground/60 @md:inline">
                        →
                      </span>
                      <EditableText
                        value={s.expected}
                        onCommit={(next) =>
                          setCaseStep(c.uid, idx, { expected: next })
                        }
                        placeholder="(expected)"
                        variant="multiline"
                        ariaLabel={`Step ${idx + 1} expected`}
                        className="col-start-2 block text-muted-foreground @md:col-auto"
                      />
                      {/* Inline remove button (wider panes only) — keeps
                          the original hover-reveal affordance for users
                          who have the room. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Remove step ${idx + 1}`}
                            disabled={c.steps.length <= 1}
                            onClick={() => removeCaseStep(c.uid, idx)}
                            className={cn(
                              "mt-px hidden size-4 items-center justify-center rounded-sm text-muted-foreground/40 opacity-0 transition-all group-hover/step:opacity-100 hover:bg-destructive/15 hover:text-destructive @md:inline-flex",
                              c.steps.length <= 1 && "cursor-not-allowed",
                            )}
                          >
                            <HugeiconsIcon
                              icon={Cancel01Icon}
                              size={9}
                              strokeWidth={2}
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-[11px]">
                          {c.steps.length <= 1
                            ? "Cases must have at least one step"
                            : "Remove this step"}
                        </TooltipContent>
                      </Tooltip>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  onClick={() => addCaseStep(c.uid)}
                  className="ml-3 mt-1.5 inline-flex items-center gap-1 rounded-sm border border-dashed border-border/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
                >
                  + add step
                </button>
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
          {/* Bug section heading is intentionally identical to the cases-list
              header — visual rhythm matters more than verbose nesting. */}
          <CopyableSectionHeader
            label="Bugs"
            kind="Bug"
            items={bugs
              .filter((b) => b.decision === "keep")
              .map((b) => ({ id: null, title: b.title }))}
            count={bugs.length}
          />
          <ul className="flex flex-col gap-1.5">
            {bugs.map((b, i) => (
              <li key={b.uid}>
                <div
                  tabIndex={0}
                  data-bug-row={i}
                  className={cn(
                    "group relative rounded-md border bg-card/40 px-3 py-2 transition-all focus:outline-none focus:ring-2 focus:ring-ring/30",
                    "focus-visible:before:absolute focus-visible:before:-left-3 focus-visible:before:top-1/2 focus-visible:before:-translate-y-1/2 focus-visible:before:text-rose-500 focus-visible:before:content-['▸']",
                    b.decision === "keep"
                      ? "border-border/60"
                      : "border-border/20 opacity-55",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={b.decision === "keep" ? "Skip" : "Keep"}
                          onClick={() =>
                            setBugDecision(
                              b.uid,
                              b.decision === "keep" ? "skip" : "keep",
                            )
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
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-[11px]">
                        {b.decision === "keep"
                          ? "Skip this bug (won't be filed)"
                          : "Keep this bug (will be filed as a child of its parent case)"}
                      </TooltipContent>
                    </Tooltip>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <EditableText
                          value={b.title}
                          onCommit={(next) => setBugTitle(b.uid, next)}
                          placeholder="(no title — click to edit)"
                          variant="singleline"
                          ariaLabel="Bug title"
                          className="block min-w-0 flex-1 text-[12px] font-medium leading-snug"
                        />
                        <SeverityBadge severity={b.severity} />
                      </div>
                      <BugParentRow bug={b} />

                      <div className="mt-1">
                        <EditableText
                          value={b.reproSteps}
                          onCommit={(next) => setBugReproSteps(b.uid, next)}
                          placeholder="(add repro steps — click to edit)"
                          variant="multiline"
                          ariaLabel="Bug repro steps"
                          className="block whitespace-pre-wrap text-[11px] text-foreground/85"
                        />
                      </div>
                      {b.codeRefs && b.codeRefs.length > 0 ? (
                        <BugCodeRefChips refs={b.codeRefs} />
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Follow-up composer — sits at the bottom of the review pane so the
          user can iterate on the draft without leaving review. Renders its
          own running-state strip with the streaming log while a refine is
          in flight (mirrors the analyze phase). */}
      <div className="mt-3 border-t border-dashed border-border/40 pt-3">
        <RefineComposer isRefining={isRefining} />
      </div>
      {/* ReviewChat (Ask) now docks as a right-side drawer rendered at the
          GeneratorPane root — see GeneratorPane.tsx. */}
    </div>
  );
}

/** Inline row that shows a bug's parent test case + a re-link picker. When
 *  the parent has been skipped, surfaces a warning so the user knows why
 *  the bug auto-skipped and offers to re-link to a kept case. */
function BugParentRow({
  bug,
}: {
  bug: import("./lib/draftBatchSchema").ReviewedBug;
}) {
  const cases = useGenerationSession((s) => s.cases);
  const setBugParent = useGenerationSession((s) => s.setBugParent);
  const idx = bug.linkedDraftCaseIndex;
  const parent =
    idx != null && idx >= 0 && idx < cases.length ? cases[idx] : null;
  const parentSkipped = parent && parent.decision !== "keep";

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
      <span className="font-mono text-muted-foreground/70">repro-in:</span>
      {parent ? (
        <span
          className={cn(
            "font-medium",
            parentSkipped
              ? "text-muted-foreground/60 line-through"
              : "text-foreground/85",
          )}
        >
          {parent.title}
        </span>
      ) : (
        <span className="italic text-muted-foreground/60">no parent case</span>
      )}
      {parentSkipped ? (
        <span className="rounded-sm border border-amber-500/40 bg-amber-500/[0.08] px-1.5 py-px font-mono text-[9.5px] text-amber-700 dark:text-amber-300">
          parent-skipped
        </span>
      ) : null}
      <BugCaseLinkPicker
        cases={cases}
        selectedCaseUid={parent?.uid ?? null}
        onPick={(caseUid) => setBugParent(bug.uid, caseUid)}
        triggerLabel={
          parent ? "re-link parent" : "pick a parent case"
        }
      />
    </div>
  );
}

/** Severity indicator in the project's editor-native voice: a vertical
 *  accent bar in the severity color (sharper than a soft pastel pill),
 *  with the severity rendered as a monospace shorthand (1·crit / 2·high /
 *  3·med / 4·low) so the badges line up vertically across the bug list. */
function SeverityBadge({ severity }: { severity: string }) {
  const grade = severity.startsWith("1")
    ? { code: "1·crit", text: "text-destructive", bar: "bg-destructive" }
    : severity.startsWith("2")
      ? {
          code: "2·high",
          text: "text-rose-600 dark:text-rose-300",
          bar: "bg-rose-500",
        }
      : severity.startsWith("3")
        ? {
            code: "3·med",
            text: "text-amber-700 dark:text-amber-300",
            bar: "bg-amber-500",
          }
        : {
            code: "4·low",
            text: "text-muted-foreground",
            bar: "bg-muted-foreground/60",
          };
  return (
    <span
      title={severity}
      className={cn(
        "inline-flex shrink-0 items-stretch overflow-hidden rounded-sm border border-border/60 bg-card/60",
      )}
    >
      <span className={cn("w-[3px] shrink-0", grade.bar)} />
      <span
        className={cn(
          "px-1.5 py-0.5 font-mono text-[10px] tracking-tight",
          grade.text,
        )}
      >
        {grade.code}
      </span>
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
            // file:line in mono with the line range colored as a mint
            // accent — keeps the path scannable while the actionable bit
            // (jump target) reads at a glance.
            className="group inline-flex items-center gap-1 rounded-sm border border-border/60 bg-card/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            title={r.symbol ?? undefined}
          >
            <HugeiconsIcon
              icon={CodeIcon}
              size={9}
              strokeWidth={1.75}
              className="text-muted-foreground/60 group-hover:text-primary/80"
            />
            <span className="truncate text-foreground/80">{r.file}</span>
            <span className="text-muted-foreground/50">:</span>
            <span className="text-primary/85 tabular-nums">{lineLabel}</span>
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
  const setPublishLogTitle = useGenerationSession((s) => s.setPublishLogTitle);
  const startNew = useGenerationSession((s) => s.startNew);
  const ok = log.filter((e) => e.status === "ok").length;
  const failed = log.filter((e) => e.status === "failed").length;

  // When the window regains focus, re-fetch titles for the published items
  // so renames made directly in the ADO web UI show up on the success
  // screen. We only patch entries whose title actually changed to avoid
  // pointless re-renders + draft autosave churn.
  useEffect(() => {
    const onFocus = async () => {
      const published = log.filter((e) => e.status === "ok" && e.result);
      if (published.length === 0) return;
      const ids = published.map((e) => e.result!.id);
      try {
        const rows = await getWorkItemTitles(ids);
        const byId = new Map(rows.map((r) => [r.id, r.title]));
        for (const entry of published) {
          const fresh = byId.get(entry.result!.id);
          if (fresh && fresh !== entry.title) {
            setPublishLogTitle(entry.uid, fresh);
          }
        }
      } catch {
        // Best-effort — the user can always hit Refresh on the detail
        // pane if the focus path didn't catch their edit.
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [log, setPublishLogTitle]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border/60 bg-card/40 px-3 py-2">
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
        <Button onClick={startNew} className="shrink-0">Start another</Button>
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
  errorPhase: SessionState["errorPhase"],
): ErrorClass {
  const lower = message.toLowerCase();

  if (
    /configure an api key/.test(lower) ||
    /no api key configured/.test(lower) ||
    /missing.*api.?key/.test(lower) ||
    /api key.*not.*set/.test(lower)
  ) {
    // Pull the provider's display label out of the message body. The
    // new error format reads "...needs Anthropic access — add a key…"
    // so we look for the brand label between "needs " and " access".
    // Falls back to the legacy "no api key configured for X" form for
    // any caller that hasn't been migrated to the new phrasing yet.
    const newFormat = message.match(/needs\s+([\w-]+)\s+access/i)?.[1];
    const legacyFormat = lower.match(/no api key configured for (\w+)/)?.[1];
    const providerLabel = newFormat ?? (legacyFormat ? capitalize(legacyFormat) : null);
    return {
      code: "AUTH/01 · MISSING-KEY",
      title: providerLabel
        ? `No ${providerLabel} API key on file`
        : "No API key on file for the selected model",
      icon: Key01Icon,
      tone: "auth",
      why: providerLabel
        ? `The model you have selected uses ${providerLabel}, but no ${providerLabel} key is stored in the keychain. You can either add the key, or switch to a model from a provider you've already configured — DevOps Studio works with any of them.`
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
    /claude exited with code/.test(lower) ||
    /could not spawn claude/.test(lower) ||
    /non-zero-exit/.test(lower)
  ) {
    // The CLI ran but exited non-zero — the tail of stderr is appended to
    // the message by claudeErrorMessage. Surface that as the "why" so the
    // user sees the actual reason (bad model, missing key, etc.) instead
    // of a generic "Something went wrong".
    return {
      code: "CLAUDE/01 · NON-ZERO-EXIT",
      title: "Claude Code CLI failed mid-run",
      icon: PlugSocketIcon,
      tone: "auth",
      why: message,
      steps: [
        "Open Settings → Models and re-detect the CLI — re-run setup-token if Authenticated isn't green.",
        "If the engine is set to Claude Code, make sure the active model is an Anthropic one (Opus / Sonnet / Haiku).",
        "If you're on the Anthropic API-key auth mode, verify the key under Providers → Anthropic.",
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
  log: SessionState["publishLog"];
}) {
  const cases = log.filter((e) => e.kind === "case");
  const bugs = log.filter((e) => e.kind === "bug");
  return (
    <div className="flex flex-col gap-3">
      {cases.length > 0 ? (
        <PublishLogSection
          label="Cases"
          kind="Test Case"
          entries={cases}
          openInApp={(id, title) =>
            window.dispatchEvent(
              new CustomEvent("devops-studio:open-test-case", {
                detail: { caseId: id, title: `#${id} · ${title}` },
              }),
            )
          }
        />
      ) : null}
      {bugs.length > 0 ? (
        <PublishLogSection
          label="Bugs"
          kind="Bug"
          entries={bugs}
          openInApp={(id, title) =>
            window.dispatchEvent(
              new CustomEvent("devops-studio:open-bug", {
                detail: { bugId: id, title: `Bug #${id} · ${title}` },
              }),
            )
          }
        />
      ) : null}
    </div>
  );
}

/** Per-kind group inside the publish log. Has a copy-on-hover header so the
 *  user can grab all cases (or all bugs) as a `<Kind> <id>: <title>` list
 *  for pasting into Asana / Notion — pre-formatted so the id auto-links via
 *  the HTML clipboard payload. */
function PublishLogSection({
  label,
  kind,
  entries,
  openInApp,
}: {
  label: string;
  kind: string;
  entries: SessionState["publishLog"];
  openInApp: (id: number, title: string) => void;
}) {
  const copyItems = entries
    .filter((e) => e.status === "ok" && e.result)
    .map((e) => ({
      id: e.result!.id,
      title: e.title,
      webUrl: e.result!.webUrl,
    }));
  return (
    <section>
      <CopyableSectionHeader
        label={label}
        kind={kind}
        items={copyItems}
        count={entries.length}
      />
      <ul className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/60 bg-card/40">
        {entries.map((e) => (
          <li
            key={e.uid}
            className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          >
            <StatusDot status={e.status} />
            <span className="min-w-0 flex-1 truncate">{e.title}</span>
            {/* Source-link indexing on cases is best-effort — when it fails
                the case itself is still published, but the staleness scanner
                won't auto-detect drift. Treat as a warning, not a failure. */}
            {e.error && e.status === "ok" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-px text-[9.5px] font-medium text-amber-700 dark:text-amber-300">
                    <HugeiconsIcon
                      icon={AlertCircleIcon}
                      size={9}
                      strokeWidth={1.75}
                    />
                    no drift tracking
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  variant="panel"
                  className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
                >
                  Published, but the staleness index couldn't be updated — this
                  case won't auto-flag when its source files change. Detail:{" "}
                  <span className="font-mono text-[10px]">{e.error}</span>
                </TooltipContent>
              </Tooltip>
            ) : null}
            {e.error && e.status === "failed" ? (
              <span className="truncate text-[10px] text-destructive">
                {e.error}
              </span>
            ) : null}
            {e.result ? (
              <>
                <button
                  type="button"
                  onClick={() => openInApp(e.result!.id, e.title)}
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.08] hover:text-primary"
                  title="Open in this app"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => void openUrl(e.result!.webUrl)}
                  className="inline-flex h-5 shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
                  title="Open in Azure DevOps web"
                >
                  <HugeiconsIcon
                    icon={ExternalLink}
                    size={10}
                    strokeWidth={1.75}
                  />
                  #{e.result.id}
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
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
