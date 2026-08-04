import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  AttachButton,
  AttachmentDropZone,
  ingestFile,
  synthesizeClipboardImageName,
} from "@/components/chat/attachments";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ENTER_KEY, MOD_KEY } from "@/lib/platform";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  HelpCircleIcon,
  PlayIcon,
  ArrowTurnBackwardIcon,
  Cancel01Icon,
  Clock01Icon,
  AiBrain01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useGenerationSession,
  type SessionState,
} from "../store/useGenerationSession";
import { AnalyzeActivityLog } from "./AnalyzeActivityLog";
import { InlineNotice } from "./InlineNotice";
import { relativeTime, ResumeCard } from "@/modules/ai/components/ResumeCard";
import {
  canOfferResume,
  resumeUnavailableReason,
} from "@/modules/ai/lib/errorClass";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { getModel } from "@/modules/ai/config";
import { BestPracticeNotice } from "@/modules/ai/components/BestPracticeNotice";
import {
  ContextGuardNotice,
  ContextMeter,
  ContextOverflowDialog,
  useContextGuard,
} from "@/modules/ai/components/ContextMeter";
import { useContextBaseline } from "@/modules/ai/lib/useContextBaseline";
import { estimateTokens, formatTokens } from "@/modules/ai/lib/contextEstimate";
import {
  MentionDropdown,
  WorkItemChips,
  useWorkItemMention,
} from "@/modules/ado/components/WorkItemMention";
import { useBugContext } from "@/modules/ado/hooks/useBugContext";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Quick-fire preset instructions. The strings are intentionally written
 *  the way a tester would say them out loud — they read as natural prompts,
 *  not commands, so the analyst's tone stays human in the refined output. */
const PRESETS: ReadonlyArray<{ label: string; prompt: string; hint: string }> =
  [
    {
      label: "find-bugs",
      hint: "Look at the source and surface concrete defects",
      prompt:
        "Re-read the attached/searchable source and surface any concrete bugs that the current draft cases would not catch. Add new bug entries with codeRefs pointing at the exact lines.",
    },
    {
      label: "smoke-check",
      hint: "Verify each step against the code; flag broken ones",
      prompt:
        "Walk through each kept case step-by-step against the actual source. If a step's expected behaviour does NOT match what the code does, replace that case with a corrected one and add a bug entry explaining the divergence with codeRefs.",
    },
    {
      label: "edge-cases",
      hint: "Add boundary, negative, and concurrency cases",
      prompt:
        "Add additional edge-case and negative-path test cases that the current draft is missing: boundary values, concurrent / race conditions, malformed input, partial failures, and permission denials where they apply.",
    },
    {
      label: "tighten-steps",
      hint: "Make actions/expected results more precise",
      prompt:
        "Keep the same coverage but tighten the prose. Every step's Action should be one concrete thing the tester does; every Expected should be an observable, deterministic outcome. No vague verbs.",
    },
    {
      label: "re-ground",
      hint: "Re-anchor cases in the actual code paths",
      prompt:
        "Re-anchor every case in the actual code paths. Read the relevant files via Read/Glob/Grep, update sourceLinks on each case with the files it exercises, and fix any case whose steps don't match what the code actually does.",
    },
  ];

type Props = {
  /** When true, the composer renders the in-flight running strip with the
   *  activity log inline. Otherwise it renders the idle composer. */
  isRefining: boolean;
};

/** The resume card's fact line is one truncating row, so a long follow-up has
 *  to be clamped here rather than left to CSS — otherwise the instruction eats
 *  the step count and the timestamp that follow it. */
function clampInstruction(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Stdin-style follow-up composer pinned to the bottom of the review pane.
 *  Reads like a REPL prompt continuing the same session — the user types a
 *  natural-language instruction (or picks a preset) and the model refines
 *  the draft in place. While the call is in flight, the surface morphs into
 *  a live status strip with the streaming activity log so the user sees
 *  exactly what the analyst is doing, identical to the analyze phase. */
export function RefineComposer({ isRefining }: Props) {
  const refine = useGenerationSession((s) => s.refine);
  const cases = useGenerationSession((s) => s.cases);
  const bugs = useGenerationSession((s) => s.bugs);
  const codeSearchEnabled = usePreferencesStore((s) => s.codeSearchEnabled);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const activityLog = useGenerationSession((s) => s.activityLog);
  const stepLabel = useGenerationSession((s) => s.stepLabel);
  const refineUndoSnapshot = useGenerationSession(
    (s) => s.refineUndoSnapshot,
  );
  const undoRefine = useGenerationSession((s) => s.undoRefine);
  const refineError = useGenerationSession((s) => s.refineError);
  const dismissRefineError = useGenerationSession(
    (s) => s.dismissRefineError,
  );
  const refineHistory = useGenerationSession((s) => s.refineHistory);
  const refineRounds = useGenerationSession((s) => s.refineRounds);
  const cancelRefine = useGenerationSession((s) => s.cancelRefine);
  const refineResumable = useGenerationSession((s) => s.refineResumable);
  const resumeRefine = useGenerationSession((s) => s.resumeRefine);
  const discardRefineCheckpoint = useGenerationSession(
    (s) => s.discardRefineCheckpoint,
  );
  const probeRefineCheckpoint = useGenerationSession(
    (s) => s.probeRefineCheckpoint,
  );
  const runId = useGenerationSession((s) => s.runId);
  const attachments = useGenerationSession((s) => s.attachments);
  const addRichAttachment = useGenerationSession((s) => s.addRichAttachment);
  const removeAttachment = useGenerationSession((s) => s.removeAttachment);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attErrors, setAttErrors] = useState<{ id: string; message: string }[]>(
    [],
  );

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const errs: { id: string; message: string }[] = [];
      for (const f of files) {
        const result = await ingestFile(f);
        if (result.ok) addRichAttachment(result.attachment);
        else
          errs.push({
            id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            message: result.error.message,
          });
      }
      if (errs.length) setAttErrors((p) => [...p, ...errs]);
    },
    [addRichAttachment],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? []) as File[];
      if (items.length === 0) return;
      e.preventDefault();
      const named = items.map((f) =>
        f.name
          ? f
          : new File([f], synthesizeClipboardImageName(f.type || "image/png"), {
              type: f.type,
            }),
      );
      void ingestFiles(named);
    },
    [ingestFiles],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      void ingestFiles(Array.from(e.dataTransfer?.files ?? []));
    },
    [ingestFiles],
  );

  const onFilePicker = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      void ingestFiles(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [ingestFiles],
  );

  const [text, setText] = useState("");
  // Inline `#id` work-item mention — same affordance as the Ask chat, so a
  // refine instruction can attach a bug / work item as grounding context.
  const bugCtx = useBugContext();
  const mention = useWorkItemMention({
    value: text,
    onValueChange: setText,
    onAdd: bugCtx.add,
    selectedIds: bugCtx.selected.map((b) => b.id),
  });
  const [showHelp, setShowHelp] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-focus once the run finishes so a follow-up follow-up is one keystroke
  // away. Skipped when the user is reading the log or hovering elsewhere.
  useEffect(() => {
    if (!isRefining && document.activeElement?.tagName !== "TEXTAREA") {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [isRefining]);

  // A follow-up interrupted by an app quit (or a tab closed mid-round) lives
  // only on disk: the draft comes back from its history row, but nothing in
  // that row knows a round was in flight. Probe once per draft so the spend
  // resurfaces as a Resume instead of being silently lost. The action
  // self-guards — it bails when a round is live or an affordance already shows.
  useEffect(() => {
    if (!runId) return;
    void probeRefineCheckpoint();
  }, [runId, probeRefineCheckpoint]);

  // ESC during a refine kills the running claude subprocess and returns
  // the user to the composer with their draft untouched. The handler lives
  // at the window level so the user can press ESC without first clicking
  // back into the pane — the running view doesn't keep focus on anything.
  useEffect(() => {
    if (!isRefining) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't fight a modal — if the rounds dialog is open, Radix already
      // owns ESC for itself.
      if (roundsOpen) return;
      e.preventDefault();
      cancelRefine();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isRefining, roundsOpen, cancelRefine]);

  const keptCases = useMemo(
    () => cases.filter((c) => c.decision === "keep").length,
    [cases],
  );
  const keptBugs = useMemo(
    () => bugs.filter((b) => b.decision === "keep").length,
    [bugs],
  );

  const codeSearchOn = codeSearchEnabled && !!sourceRoot;

  // Same gate every other Resume affordance uses: a round that answered badly,
  // or died of a context overflow, would only re-fail.
  const offerRefineResume =
    !!refineResumable &&
    canOfferResume(
      refineResumable.outcome,
      refineResumable.outcome?.message ?? refineError,
      refineResumable,
    );

  // Context guardrail for the follow-up. A refine re-sends the current draft
  // plus the instruction plus attachments plus the always-injected baseline, so
  // the meter measures all of that against the session's active model.
  const overrideModelId = useGenerationSession((s) => s.overrideModelId);
  const defaultModelId = useChatStore((s) => s.selectedModelId);
  const activeModelId = overrideModelId ?? defaultModelId;
  const activeModel = getModel(activeModelId);
  const compatContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );
  const baseline = useContextBaseline();
  const attachTextTokens = attachments
    .filter((a) => a.kind !== "image")
    .reduce((n, a) => n + estimateTokens(a.content), 0);
  const imageCount = attachments.filter((a) => a.kind === "image").length;
  const draftTokens =
    estimateTokens(JSON.stringify(cases.filter((c) => c.decision === "keep"))) +
    estimateTokens(JSON.stringify(bugs.filter((b) => b.decision === "keep")));
  const guard = useContextGuard({
    modelId: activeModelId,
    compatOverride: compatContextLimit,
    imagesCount: imageCount,
    segments: [
      { label: "Your follow-up", tokens: estimateTokens(text) },
      ...(draftTokens > 0
        ? [{ label: "Current draft", tokens: draftTokens }]
        : []),
      ...(attachTextTokens > 0
        ? [{ label: "Attachments", tokens: attachTextTokens }]
        : []),
      ...(bugCtx.selected.length > 0
        ? [
            {
              label: `Work items (${bugCtx.selected.length})`,
              tokens: bugCtx.selected.length * 300,
            },
          ]
        : []),
      ...baseline.segments,
    ],
  });

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || isRefining) return;
    void refine(
      value,
      bugCtx.selected.map((b) => b.id),
    );
    setText("");
    bugCtx.clear();
    mention.dismiss();
  }, [text, isRefining, refine, bugCtx, mention]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Let the mention dropdown consume arrows/enter/escape first.
      if (mention.onKeyDown(e)) return;
      const submitCombo =
        (e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key === "Return");
      if (submitCombo) {
        e.preventDefault();
        guard.attempt(submit);
      }
    },
    [guard, submit, mention],
  );

  const applyPreset = (prompt: string) => {
    setText((curr) => {
      const trimmed = curr.trim();
      if (trimmed.length === 0) return prompt;
      // Append-with-spacer so a user who's already typed something can stack
      // multiple presets together before sending.
      return `${trimmed}\n\n${prompt}`;
    });
    // Push focus back so the cursor sits after the inserted text.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
    });
  };

  // --- Running state -------------------------------------------------------
  // While the refine is in flight we hide the textarea and show the same
  // streaming-log surface the analyze phase uses, so the user gets the same
  // grounded "I can see what it's doing" feedback for follow-ups.
  if (isRefining) {
    return (
      <section className="relative">
        <DockHeader running />
        <div className="rounded-md border border-primary/40 bg-primary/[0.04] p-2.5">
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Spinner className="size-3.5 shrink-0 text-primary" />
            {/* The live step label is a tool call (e.g. read_file: <long
                path>) — clamp it to one line so a long path can't push the
                row past the bordered container, mirroring AnalyzingPhase. */}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-primary/90">
              {stepLabel || "Reading current draft…"}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={cancelRefine}
                    className="h-5 gap-1 px-1.5 font-mono text-[10px] uppercase tracking-wider text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={10}
                      strokeWidth={2}
                    />
                    cancel
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[260px] text-[11px]"
                >
                  Stops this follow-up and leaves your draft as it is.
                  Progress is checkpointed — you can resume it from here
                  afterwards.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <AnalyzeActivityLog entries={activityLog} running />
        </div>
      </section>
    );
  }

  // --- Idle composer -------------------------------------------------------
  // Thinking & history live as tiny chips in the dock header's right slot —
  // always visible, always one click away, never eating composer real estate.
  // They render only when there's something to read so a fresh draft doesn't
  // get empty stubs.
  const headerExtras =
    refineRounds.length > 0 || refineHistory.length > 0 ? (
      <>
        {refineRounds.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setRoundsOpen(true)}
                aria-label={`View ${refineRounds.length} past refine round${refineRounds.length === 1 ? "" : "s"} with thinking`}
                className={cn(
                  "group inline-flex h-5 items-center gap-1 rounded-sm border border-border/50 bg-card/70 pl-1 pr-1.5 font-mono text-[10px] text-muted-foreground transition-colors",
                  "hover:border-primary/50 hover:bg-primary/[0.08] hover:text-primary",
                )}
              >
                <HugeiconsIcon
                  icon={AiBrain01Icon}
                  size={11}
                  strokeWidth={1.75}
                  className="text-muted-foreground/70 transition-colors group-hover:text-primary"
                />
                <span className="uppercase tracking-wider">thinking</span>
                <span className="rounded-sm bg-foreground/[0.08] px-1 text-[9.5px] tabular-nums text-foreground/85 transition-colors group-hover:bg-primary/15 group-hover:text-primary">
                  {refineRounds.length}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] text-[11px]">
              See every past round — your follow-up, the tool calls the model
              made, and how the draft changed.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {refineHistory.length > 0 ? (
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Recall one of ${refineHistory.length} recent follow-up${refineHistory.length === 1 ? "" : "s"}`}
                    className={cn(
                      "group inline-flex h-5 items-center gap-1 rounded-sm border border-border/50 bg-card/70 pl-1 pr-1.5 font-mono text-[10px] text-muted-foreground transition-colors",
                      "hover:border-primary/50 hover:bg-primary/[0.08] hover:text-primary",
                    )}
                  >
                    <HugeiconsIcon
                      icon={Clock01Icon}
                      size={11}
                      strokeWidth={1.75}
                      className="text-muted-foreground/70 transition-colors group-hover:text-primary"
                    />
                    <span className="uppercase tracking-wider">history</span>
                    <span className="rounded-sm bg-foreground/[0.08] px-1 text-[9.5px] tabular-nums text-foreground/85 transition-colors group-hover:bg-primary/15 group-hover:text-primary">
                      {refineHistory.length}
                    </span>
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Recall a recent follow-up
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              align="end"
              side="bottom"
              sideOffset={6}
              className="w-[360px]"
            >
              <p className="px-2 pb-1 pt-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                Recent follow-ups
              </p>
              <ul className="flex max-h-[260px] flex-col gap-px overflow-y-auto">
                {refineHistory.map((prompt, i) => (
                  <li key={`${i}-${prompt.slice(0, 20)}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setText(prompt);
                        setHistoryOpen(false);
                        requestAnimationFrame(() => {
                          const el = textareaRef.current;
                          if (!el) return;
                          el.focus();
                          el.setSelectionRange(
                            el.value.length,
                            el.value.length,
                          );
                        });
                      }}
                      className="block w-full rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-foreground/[0.05]"
                    >
                      <span className="mr-1.5 font-mono text-[9.5px] text-muted-foreground/55 tabular-nums">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="line-clamp-2 text-foreground/85">
                        {prompt}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
      </>
    ) : null;

  return (
    <section className="relative">
      <DockHeader rightSlot={headerExtras} />

      {/* One affordance at a time. A failure that's worth continuing puts
          Resume inside the error box (the RunErrorPanel pattern) rather than
          stacking a second banner; a round that stopped WITHOUT an error —
          you pressed ESC, or the app quit mid-round — has no error to show,
          so it gets the standalone card. Dismissing the error falls through
          to that card, which is why Resume survives the ×. */}
      {refineError ? (
        <InlineNotice
          tone="error"
          label="refine failed"
          className="mb-2"
          onDismiss={dismissRefineError}
          dismissLabel="Dismiss refine error"
          hint={
            !offerRefineResume
              ? "Your draft is unchanged — fix the underlying issue and try again."
              : (refineResumable?.stepsUsed ?? 0) > 0
                ? "Your draft is unchanged. Resuming picks up from what the model already read — the steps you paid for aren't re-run — and re-sends the draft as it was when you asked."
                : "Your draft is unchanged. Nothing was read before it failed, so resuming re-runs the follow-up against the draft as it was when you asked."
          }
          action={
            offerRefineResume ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="xs" onClick={() => void resumeRefine()}>
                      <HugeiconsIcon
                        icon={PlayIcon}
                        size={10}
                        strokeWidth={2}
                      />
                      resume follow-up
                    </Button>
                  </TooltipTrigger>
                  {/* Deliberately short — the hint line right above already
                      spells out what gets re-sent and what isn't re-run. */}
                  <TooltipContent
                    side="top"
                    className="max-w-[240px] text-[11px]"
                  >
                    Continues where it stopped, on the model it started with.
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={discardRefineCheckpoint}
                    >
                      discard
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-[260px] text-[11px]"
                  >
                    Deletes the saved progress for this follow-up. You can
                    still re-send it from scratch.
                  </TooltipContent>
                </Tooltip>
              </>
            ) : refineResumable ? (
              /* Not continuable, but the round still wrote a checkpoint —
                 and discard used to hang off the resume affordance only. */
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={discardRefineCheckpoint}
                  >
                    discard
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[260px] text-[11px]"
                >
                  {resumeUnavailableReason(
                    refineResumable.outcome,
                    refineResumable,
                  )}{" "}
                  This deletes the saved progress for that attempt.
                </TooltipContent>
              </Tooltip>
            ) : undefined
          }
        >
          {refineError}
        </InlineNotice>
      ) : refineResumable ? (
        <ResumeCard
          className="mb-2"
          title={
            refineResumable.outcome?.kind === "cancelled"
              ? "You stopped this follow-up"
              : "Your follow-up didn't finish"
          }
          detail={[
            `“${clampInstruction(refineResumable.instruction)}”`,
            refineResumable.stepsUsed > 0
              ? `${refineResumable.stepsUsed} step${
                  refineResumable.stepsUsed === 1 ? "" : "s"
                } in`
              : null,
            // What the interrupted round already bought, in the unit the run is
            // rationed by — same clause the analyze and review cards carry.
            refineResumable.totalTokens
              ? `~${formatTokens(refineResumable.totalTokens)} tokens spent`
              : null,
            relativeTime(refineResumable.updatedAt),
          ]
            .filter(Boolean)
            .join(" · ")}
          onResume={offerRefineResume ? () => void resumeRefine() : undefined}
          unresumableReason={
            offerRefineResume
              ? undefined
              : resumeUnavailableReason(
                  refineResumable.outcome,
                  refineResumable,
                )
          }
          onDiscard={discardRefineCheckpoint}
        />
      ) : null}

      {refineUndoSnapshot ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5">
          <p className="font-mono text-[10.5px] text-amber-700 dark:text-amber-300">
            <span className="opacity-60">›</span> refined just now —{" "}
            <span className="opacity-80">
              prior batch ({refineUndoSnapshot.cases.length} case
              {refineUndoSnapshot.cases.length === 1 ? "" : "s"},{" "}
              {refineUndoSnapshot.bugs.length} bug
              {refineUndoSnapshot.bugs.length === 1 ? "" : "s"}) is recoverable
            </span>
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={undoRefine}
            className="text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
          >
            <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={10} strokeWidth={1.75} />
            undo refine
          </Button>
        </div>
      ) : null}

      {/* Preset chips. Editor-flavored mono shorthand to match the rest of
          the app's voice — these read like dot-commands in a REPL, not like
          chatbot quick replies. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        <span className="select-none font-mono text-[10px] text-muted-foreground/60">
          presets:
        </span>
        {PRESETS.map((p) => (
          <Tooltip key={p.label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => applyPreset(p.prompt)}
                className={cn(
                  "group inline-flex h-5 items-center gap-1 rounded-sm border border-border/50 bg-card px-1.5 font-mono text-[10px] text-muted-foreground transition-colors",
                  "hover:border-primary/40 hover:bg-primary/[0.08] hover:text-primary",
                )}
              >
                <span className="text-muted-foreground/50 group-hover:text-primary/70">
                  /
                </span>
                {p.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] text-[11px]">
              {p.hint}
            </TooltipContent>
          </Tooltip>
        ))}
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          aria-label="What can I ask?"
          className="ml-1 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <HugeiconsIcon icon={HelpCircleIcon} size={11} strokeWidth={1.75} />
        </button>
      </div>

      {showHelp ? (
        <div className="mb-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-mono text-foreground/80">refine</span> sends
            a follow-up against the cases &amp; bugs you can see right now.
            Tell the analyst what to change — &ldquo;step 3 doesn&rsquo;t
            match the code in <span className="font-mono">login.ts</span>,
            fix it&rdquo;, or &ldquo;there&rsquo;s a race when two requests
            land simultaneously, add a case&rdquo;. The full draft is
            re-emitted; skipped items stay skipped.
          </p>
        </div>
      ) : null}

      <RefineRoundsDialog
        open={roundsOpen}
        onOpenChange={setRoundsOpen}
        rounds={refineRounds}
      />

      <AttachmentDropZone
        attachments={attachments}
        errors={attErrors}
        remove={removeAttachment}
        dismissError={(id) =>
          setAttErrors((p) => p.filter((e) => e.id !== id))
        }
        className="mb-2"
      />

      {bugCtx.selected.length > 0 ? (
        <div className="mb-1.5">
          <WorkItemChips items={bugCtx.selected} onRemove={bugCtx.remove} />
        </div>
      ) : null}

      <BestPracticeNotice className="mb-2" />

      <ContextGuardNotice
        usage={guard.usage}
        guardEnabled={guard.guardEnabled}
        modelLabel={activeModel.label}
        className="mb-2"
      />

      <ContextOverflowDialog guard={guard} modelLabel={activeModel.label} />

      {/* Relative (non-clipping) wrapper so the `#`-mention dropdown, which
          floats above the composer, isn't cut off by the composer's
          overflow-hidden rounded frame. */}
      <div className="relative">
        {mention.active ? <MentionDropdown mention={mention} /> : null}

        {/* The composer itself — wrapped to look like a fenced code block so
            it visually belongs to the "this app is your editor" voice. */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            "group relative overflow-hidden rounded-md border border-border/60 bg-card/40 transition-colors",
            "focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30",
          )}
        >
          {/* Left rail — mint glyph signals "this is the prompt line". */}
        <div className="absolute inset-y-0 left-0 flex w-7 select-none flex-col items-center justify-start pt-2 font-mono text-[11px] text-primary/80">
          <span aria-hidden>▍</span>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            mention.noteInput(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            );
          }}
          onSelect={(e) =>
            mention.noteCaret(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? e.currentTarget.value.length,
            )
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={4}
          placeholder="ask a follow-up — e.g. &quot;step 3 in case #2 doesn't match auth.ts, fix it&quot; · #id to attach a work item"
          className="block min-h-[96px] w-full resize-y bg-transparent py-2.5 pl-7 pr-3 font-mono text-[11.5px] leading-relaxed outline-none placeholder:text-muted-foreground/55"
        />

        {/* Context strip at the bottom of the composer — tells the user what
            the model will actually see. Keeps the affordance honest: "I'm
            sending the current draft along with your question." */}
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-foreground/[0.025] px-3 py-1">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/75">
            <span>ctx:</span>
            <span className="text-foreground/75">
              {keptCases} case{keptCases === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-foreground/75">
              {keptBugs} bug{keptBugs === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span
              className={cn(
                codeSearchOn ? "text-primary/80" : "text-muted-foreground/60",
              )}
            >
              code-search: {codeSearchOn ? "on" : "off"}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <ContextMeter usage={guard.usage} />
          </div>
          <div className="flex items-center gap-2">
            <AttachButton onFilePicker={onFilePicker} />
            {text.trim().length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Clear composer"
                    onClick={() => setText("")}
                    className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={10}
                      strokeWidth={2}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  Clear
                </TooltipContent>
              </Tooltip>
            ) : null}
            <KbdGroup className="hidden sm:inline-flex">
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>{ENTER_KEY}</Kbd>
            </KbdGroup>
            <Button
              size="sm"
              onClick={() => guard.attempt(submit)}
              disabled={text.trim().length === 0}
            >
              <HugeiconsIcon icon={PlayIcon} size={10} strokeWidth={2} />
              refine
            </Button>
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}

/** Modal listing every refine round on this draft: prompt, activity log,
 *  before/after counts, outcome. The whole thinking process is here so the
 *  user can re-trace why a draft is in its current shape. */
function RefineRoundsDialog({
  open,
  onOpenChange,
  rounds,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rounds: SessionState["refineRounds"];
}) {
  // Render most-recent-first: the user almost always wants to see what the
  // latest round did, and scrolling up to find it inside a 12-round history
  // is hostile. Round numbers still count chronologically (#01 = first
  // round) so the labels stay stable across refines.
  const displayRounds = rounds.map((r, i) => ({ round: r, ordinal: i + 1 })).reverse();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Constrain grid items to the container so expanding "thinking & tool
          calls" — which can contain long file paths and JSON output — never
          pushes the dialog wider than its `max-w`. CSS grid items default to
          `min-width: auto`, which lets a single non-breaking token blow out
          the dialog; `[&>*]:min-w-0` opts every child back into shrinking. */}
      <DialogContent className="sm:max-w-2xl overflow-hidden [&>*]:min-w-0">
        <DialogHeader className="min-w-0">
          <DialogTitle>Refine thinking history</DialogTitle>
          <DialogDescription>
            Every follow-up sent on this draft, newest first. The activity log
            shows the tool calls and thinking the model emitted on each round.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] min-h-0 w-full min-w-0 pr-2">
          <ol className="flex w-full min-w-0 flex-col gap-3">
            {displayRounds.map(({ round: r, ordinal }) => (
              <li
                key={`${r.timestamp}-${ordinal}`}
                className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-card/40 p-3"
              >
                <header className="flex items-center justify-between gap-2 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9.5px] text-muted-foreground/70 tabular-nums">
                      #{String(ordinal).padStart(2, "0")}
                    </span>
                    <OutcomeBadge outcome={r.outcome} />
                    <span className="font-mono text-[10px] text-muted-foreground/70">
                      {formatRoundTimestamp(r.timestamp)}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {r.beforeCases} → {r.afterCases} cases ·{" "}
                    {r.beforeBugs} → {r.afterBugs} bugs
                  </span>
                </header>
                <div className="rounded-sm border border-border/40 bg-foreground/[0.025] p-2">
                  <p className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                    follow-up
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-foreground/90">
                    {r.instruction}
                  </p>
                </div>
                {r.error ? (
                  <p className="mt-2 rounded-sm border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10.5px] text-destructive">
                    {r.error}
                  </p>
                ) : null}
                {r.activityLog.length > 0 ? (
                  <details className="mt-2 group/log min-w-0">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
                      <span className="font-mono text-muted-foreground/70 group-open/log:rotate-90 transition-transform">
                        ›
                      </span>
                      thinking &amp; tool calls
                      <span className="ml-1 font-mono normal-case text-[9.5px] text-muted-foreground/55">
                        ({r.activityLog.length})
                      </span>
                    </summary>
                    <div className="mt-1.5 w-full min-w-0">
                      <AnalyzeActivityLog
                        entries={r.activityLog}
                        className="w-full"
                        // Wrap mode in the dialog: long file paths and
                        // grep patterns break onto multiple lines instead
                        // of relying on per-cell horizontal scroll, which
                        // gets eaten by the dialog's own ScrollArea
                        // intercepting wheel events.
                        wrap
                      />
                    </div>
                  </details>
                ) : (
                  <p className="mt-2 text-[10px] italic text-muted-foreground/70">
                    No activity captured.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function OutcomeBadge({
  outcome,
}: {
  outcome: SessionState["refineRounds"][number]["outcome"];
}) {
  if (outcome === "ok") {
    return (
      <span className="rounded-sm bg-primary/15 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-primary">
        ok
      </span>
    );
  }
  if (outcome === "empty") {
    return (
      <span className="rounded-sm bg-amber-500/15 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
        empty
      </span>
    );
  }
  return (
    <span className="rounded-sm bg-destructive/15 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-destructive">
      failed
    </span>
  );
}

function formatRoundTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Section header — lowercase mono in the project's "editor voice", with an
 *  optional running-state pulse so the user spots state changes at a glance.
 *  When `rightSlot` is passed it replaces the static "no regenerate" tagline
 *  — used by the idle composer to anchor the thinking / history chips. */
function DockHeader({
  running,
  rightSlot,
}: {
  running?: boolean;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 rounded-full",
          running
            ? "animate-pulse bg-primary"
            : "bg-foreground/40 dark:bg-foreground/30",
        )}
      />
      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
        ask follow-up
      </span>
      {running ? (
        <span className="font-mono text-[10px] text-primary/85">
          · running
        </span>
      ) : null}
      {rightSlot ? (
        <div className="ml-auto flex items-center gap-1">{rightSlot}</div>
      ) : (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/55">
          no regenerate · keeps current decisions
        </span>
      )}
    </div>
  );
}
