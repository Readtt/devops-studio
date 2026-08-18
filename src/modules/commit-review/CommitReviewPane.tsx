import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  GitBranchIcon,
  Loading03Icon,
  PencilEdit01Icon,
  RefreshIcon,
  PlayIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  MODELS,
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import { formatTokens } from "@/modules/ai/lib/contextEstimate";
import { budgetSpentPhrase } from "@/modules/ai/lib/runBudget";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import {
  canOfferResume,
  resumeUnavailableReason,
} from "@/modules/ai/lib/errorClass";
import {
  classifyProviderError,
  RunErrorPanel,
  unclassifiedError,
  type ErrorClass,
} from "@/modules/ai/components/RunErrorPanel";
import { relativeTime, ResumeCard } from "@/modules/ai/components/ResumeCard";
import { StallHint } from "@/modules/ai/components/StallHint";
import { BestPracticeNotice } from "@/modules/ai/components/BestPracticeNotice";
import {
  ContextGuardNotice,
  ContextMeter,
  ContextOverflowDialog,
  useContextGuard,
} from "@/modules/ai/components/ContextMeter";
import { useContextBaseline } from "@/modules/ai/lib/useContextBaseline";
import {
  estimateTokens,
  estimateTokensFromBytes,
  showsContextAdvisory,
} from "@/modules/ai/lib/contextEstimate";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setCodeSearchEnabled, type WorkspaceRepo } from "@/modules/settings/store";
import { onSourceGitChanged } from "@/modules/git";
import { RepoScopeChips } from "@/components/RepoScopeChips";
import { AnalyzeActivityLog } from "@/modules/generator/components/AnalyzeActivityLog";
import {
  AttachmentList,
  ingestFile,
  synthesizeClipboardImageName,
} from "@/components/chat/attachments";
import {
  MentionDropdown,
  WorkItemChips,
  MentionHint,
  useWorkItemMention,
} from "@/modules/ado/components/WorkItemMention";
import { scopedRepos } from "@/modules/ai/lib/repoScope";
import {
  useCommitReview,
  selectedDiffs,
  allDiffsLoaded,
  type CommitReviewSlice,
} from "./useCommitReview";
import {
  combinedPatchBytes,
  COMBINED_DIFF_WARN_BYTES,
  unverifiedFindings,
} from "./runCommitReview";
import { CommitDiffPanel } from "./CommitDiffView";
import { FindingCard } from "./FindingCard";
import {
  commitKey,
  isLocalKey,
  LOCAL_CHANGES_SHA,
  type RepoCommitMeta,
} from "./gitCommitApi";
import type { CandidateFinding, Finding } from "./schema";
import type { AppliedPatchRecord, AppliedPatchesMap } from "./patchSchema";
import type { WorkItemRef } from "@/modules/ado";
import type { Attachment } from "@/components/chat/attachments";

type Props = {
  tabId: number;
  modelId?: ModelId | null;
  rehydrateRunId?: string | null;
};

export function CommitReviewPane({ tabId, modelId, rehydrateRunId }: Props) {
  const slice = useCommitReview((s) => s.byTab.get(tabId));
  const ensure = useCommitReview((s) => s.ensure);
  const toggleCommit = useCommitReview((s) => s.toggleCommit);
  const toggleLocalChanges = useCommitReview((s) => s.toggleLocalChanges);
  const toggleRepo = useCommitReview((s) => s.toggleRepo);
  const refreshSource = useCommitReview((s) => s.refreshSource);
  const clearCommits = useCommitReview((s) => s.clearCommits);
  const setContext = useCommitReview((s) => s.setContext);
  const addAttachment = useCommitReview((s) => s.addAttachment);
  const removeAttachment = useCommitReview((s) => s.removeAttachment);
  const addWorkItem = useCommitReview((s) => s.addWorkItem);
  const removeWorkItem = useCommitReview((s) => s.removeWorkItem);
  const setModel = useCommitReview((s) => s.setModel);
  const run = useCommitReview((s) => s.run);
  const resume = useCommitReview((s) => s.resume);
  const discardCheckpoint = useCommitReview((s) => s.discardCheckpoint);
  const stop = useCommitReview((s) => s.stop);
  const applyFix = useCommitReview((s) => s.applyFix);

  const codeSearchEnabled = usePreferencesStore((s) => s.codeSearchEnabled);
  const defaultModelId = usePreferencesStore((s) => s.defaultModelId);
  const configuredRepos = usePreferencesStore((s) => s.repos);
  const availability = useModelAvailability();
  // The repos this review covers. Derived from the LIVE registry (not read off
  // the store imperatively) so adding one in Settings widens an open tab; a
  // rehydrated saved run keeps the pinned set it ran against.
  const repos = scopedRepos(configuredRepos, slice?.repoIds ?? null);

  // Whether the commit's diff is expanded below. Toggled from the stats chip
  // in the header; persists across commit switches within this tab session.
  const [showDiff, setShowDiff] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void ensure(tabId, rehydrateRunId ?? null, modelId ?? null);
  }, [tabId, rehydrateRunId, modelId, ensure]);

  // Keep an open tab in sync with its repos' git state: when a branch switch /
  // pull / stash op fires `source-git-changed` (the same event the status-bar
  // readers listen to), re-read the commit lists, dirty-state, and any cached
  // "Local changes" diff so the picker never shows the previous branch. Via
  // `onSourceGitChanged`, never a raw listener — the event travels on both the
  // DOM and Tauri buses, and only the helper collapses the echo.
  useEffect(() => {
    return onSourceGitChanged((root) => void refreshSource(tabId, root));
  }, [tabId, refreshSource]);

  // A repo added or removed in Settings changes what this review covers. The
  // chips re-render from `repos` on their own; the commit list is a cache, so
  // it has to be re-read.
  const repoSignature = repos.map((r) => `${r.id}:${r.root}`).join("|");
  const loadCommits = useCommitReview((s) => s.loadCommits);
  const seenRepoSignature = useRef<string | null>(null);
  // `hasSlice`, not `slice`: the slice's identity changes on every keystroke in
  // the context box, and this only needs to know whether one exists yet.
  const hasSlice = !!slice;
  useEffect(() => {
    if (!hasSlice) return;
    if (seenRepoSignature.current === null) {
      seenRepoSignature.current = repoSignature;
      return;
    }
    if (seenRepoSignature.current === repoSignature) return;
    seenRepoSignature.current = repoSignature;
    void loadCommits(tabId);
  }, [tabId, repoSignature, loadCommits, hasSlice]);

  // The toggle lives in the fixed header but the diff renders at the top of the
  // scroll body — bring it into view when revealed so a scrolled-down reader
  // doesn't toggle it on and see nothing change.
  useEffect(() => {
    if (showDiff) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [showDiff]);

  // Context guardrail. The selected diff usually dominates the payload here, and
  // it's already loaded on the frontend — so meter it alongside the pasted spec,
  // attachments, work items, and the Settings baseline against the active model.
  // Computed before the early returns (reading `slice` defensively) so the hook
  // order stays stable whether or not a slice exists yet.
  const guardCompatOverride = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );
  const guardBaseline = useContextBaseline();
  const guardDiffs = slice ? selectedDiffs(slice) : [];
  // combinedPatchBytes TextEncodes every selected patch — expensive on a large
  // multi-commit selection. The "Added context" field is store-backed, so every
  // keystroke re-renders this parent; memoize on the stable selection signature
  // + load state so we don't re-encode megabytes per character.
  const guardDiffSig = (slice?.selectedShas ?? []).join("|");
  const guardDiffsReady = slice ? allDiffsLoaded(slice) : false;
  const guardDiffTokens = useMemo(
    () => estimateTokensFromBytes(combinedPatchBytes(guardDiffs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guardDiffSig, guardDiffsReady],
  );
  const guardAttachments = slice?.attachments ?? [];
  const guardAttachTextTokens = guardAttachments
    .filter((a) => a.kind !== "image")
    .reduce((n, a) => n + estimateTokens(a.content), 0);
  const guardImageCount = guardAttachments.filter(
    (a) => a.kind === "image",
  ).length;
  const guardWorkItems = slice?.workItems ?? [];
  const guardModelId = slice?.modelId ?? defaultModelId;
  const guardModelLabel = MODELS.find((m) => m.id === guardModelId)?.label;
  const guard = useContextGuard({
    modelId: guardModelId,
    compatOverride: guardCompatOverride,
    imagesCount: guardImageCount,
    segments: [
      ...(guardDiffTokens > 0
        ? [
            {
              label: `Diff${guardDiffs.length > 1 ? ` (${guardDiffs.length} changes)` : ""}`,
              tokens: guardDiffTokens,
            },
          ]
        : []),
      ...((slice?.context ?? "").trim().length > 0
        ? [{ label: "Added context", tokens: estimateTokens(slice?.context) }]
        : []),
      ...(guardAttachTextTokens > 0
        ? [{ label: "Attachments", tokens: guardAttachTextTokens }]
        : []),
      ...(guardWorkItems.length > 0
        ? [
            {
              label: `Work items (${guardWorkItems.length})`,
              tokens: guardWorkItems.length * 300,
            },
          ]
        : []),
      ...guardBaseline.segments,
    ],
  });

  if (!slice) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // Nothing readable anywhere — no repos configured, or every one of them
  // failed. A partial failure keeps the pane and shows a banner instead.
  //
  // A SAVED run is exempt, on the same grounds `openCommitReviewTab` lets it
  // open at all: its findings are already on disk, so an empty (or since
  // emptied) workspace must not be allowed to short-circuit past them and make
  // the review unreachable.
  if (
    !rehydrateRunId &&
    (repos.length === 0 || (slice.commitsError && slice.commits.length === 0))
  ) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-border/60 bg-card/40 p-5 text-center">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={20}
            strokeWidth={1.75}
            className="mx-auto text-amber-500"
          />
          <p className="mt-2 text-[12.5px] font-medium text-foreground">
            {repos.length === 0 ? "No source repos yet" : "Can't read commits"}
          </p>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            {repos.length === 0
              ? "Commit Review reads the git history of your source repos."
              : `${slice.commitsError}.`}{" "}
            <button
              type="button"
              onClick={() => void openSettingsWindow("general")}
              className="text-primary underline-offset-2 hover:underline"
            >
              {repos.length === 0 ? "Add a repo" : "Check your repos"}
            </button>{" "}
            in Settings, then reopen Commit Review.
          </p>
        </div>
      </div>
    );
  }

  const effectiveModelId = slice.modelId ?? defaultModelId;
  const diffs = selectedDiffs(slice);
  const selectionCount = diffs.length;
  const totalAdds = diffs.reduce(
    (sum, d) => sum + d.files.reduce((a, f) => a + f.additions, 0),
    0,
  );
  const totalDels = diffs.reduce(
    (sum, d) => sum + d.files.reduce((a, f) => a + f.deletions, 0),
    0,
  );
  // Repo-qualified: the same relative path in two repos is two files.
  const distinctFiles = new Set(
    diffs.flatMap((d) => d.files.map((f) => `${d.repoId}/${f.path}`)),
  ).size;
  const localSelectedCount = slice.selectedShas.filter(isLocalKey).length;
  const localSelected = localSelectedCount > 0;
  const commitSelectedCount = slice.selectedShas.length - localSelectedCount;
  const movedCommits = diffs.filter(
    (d) =>
      // The live working-tree diff is always against the current HEAD, so it
      // never "moved on" — only committed diffs can.
      !d.isLocal &&
      !!d.headSha &&
      !!d.shortSha &&
      d.shortSha.slice(0, 7) !== d.headSha.slice(0, 7),
  );
  const headMoved = movedCommits.length > 0;
  const combinedDiffBytes = combinedPatchBytes(diffs);
  const combinedDiffTooLarge =
    selectionCount > 1 && combinedDiffBytes > COMBINED_DIFF_WARN_BYTES;

  // "Local changes" picked on its own, but every one of its diffs came back
  // empty (clean tree, or everything got committed since) — nothing to review.
  // Only blocks the run when local is the ONLY thing selected; alongside
  // commits it's harmless, and one clean repo among several dirty ones is too.
  const localDiffs = diffs.filter((d) => d.isLocal);
  const localOnlyEmpty =
    localSelected &&
    commitSelectedCount === 0 &&
    localDiffs.length > 0 &&
    localDiffs.every((d) => d.files.length === 0);
  const canRun = allDiffsLoaded(slice) && !slice.diffLoading && !localOnlyEmpty;
  const hasRun = slice.status !== "idle" && slice.status !== "running";
  // Gate for every Resume affordance below: judges whether the checkpoint left
  // behind can plausibly continue, not just whether one exists (a local const,
  // not a property access, so TS can narrow `resumable` in the branches below).
  const resumable = slice.resumable;
  const offerResume =
    resumable != null &&
    canOfferResume(resumable.outcome, slice.error, resumable);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: commit picker + stats + model + run/stop */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/45 px-3 py-2">
        <CommitPicker
          commits={slice.commits}
          repos={repos}
          selected={slice.selectedShas}
          loading={slice.commitsLoading}
          disabled={slice.busy}
          dirtyRepoIds={slice.dirtyRepoIds}
          onToggleLocal={(repoId) => void toggleLocalChanges(tabId, repoId)}
          onToggle={(key) => void toggleCommit(tabId, key)}
          onClear={() => clearCommits(tabId)}
          onRefresh={() => void loadCommits(tabId)}
        />
        {selectionCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowDiff((v) => !v)}
                aria-pressed={showDiff}
                aria-label={showDiff ? "Hide diff" : "Show diff"}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-px font-mono text-[10.5px] transition-colors",
                  showDiff
                    ? "bg-primary/12 text-foreground"
                    : "bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground/90",
                )}
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={11}
                  strokeWidth={2}
                  className={cn("transition-transform", showDiff && "rotate-90")}
                />
                {selectionCount > 1 ? `${selectionCount} changes · ` : ""}
                {distinctFiles} file{distinctFiles === 1 ? "" : "s"}
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{totalAdds}
                </span>
                <span className="text-rose-600 dark:text-rose-400">
                  −{totalDels}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {showDiff ? "Hide the diff." : "Show the diff."}
              {selectionCount > 1
                ? ` These ${selectionCount} changes review together as one.`
                : ""}
            </TooltipContent>
          </Tooltip>
        ) : slice.diffLoading ? (
          <Skeleton className="h-4 w-20" />
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <ModelPicker
            value={effectiveModelId}
            onChange={(id) => setModel(tabId, id)}
            align="end"
            side="bottom"
            // Only models the user can actually run right now (provider key in
            // the keychain, or a configured local model) — same gate as every
            // other model dropdown.
            filter={availability.isAvailable}
            emptyMessage={
              <span>
                No models are ready.{" "}
                <button
                  type="button"
                  onClick={() => void openSettingsWindow("models")}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Connect a provider key
                </button>{" "}
                in Settings.
              </span>
            }
            footer={
              slice.modelId ? (
                <button
                  type="button"
                  onClick={() => setModel(tabId, null)}
                  className="w-full rounded-sm px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  Unpin — use the global default
                </button>
              ) : null
            }
            trigger={({ label, provider }) => (
              <span
                title={
                  // A pin only "counts" while it differs from the current global
                  // default; otherwise this review already uses that model.
                  slice.modelId != null && slice.modelId !== defaultModelId
                    ? "Pinned for this review — scoped to this tab. Click to change or unpin."
                    : "Inherits the global default. Click to pin a model for this tab only."
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/50 bg-card/60 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/[0.05]"
              >
                <ProviderIcon provider={provider} size={12} />
                <span className="max-w-[150px] truncate">{label}</span>
                {slice.modelId != null && slice.modelId !== defaultModelId ? (
                  <span className="rounded-sm bg-primary/15 px-1 text-[9px] font-medium uppercase tracking-wide text-primary">
                    pinned
                  </span>
                ) : null}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={10}
                  strokeWidth={2}
                  className="text-muted-foreground/70"
                />
              </span>
            )}
          />
          <ContextMeter usage={guard.usage} className="mr-0.5" />
          {slice.busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => stop(tabId)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.05]"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
                  Stop
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Cancel this review. Progress is checkpointed — you can resume
                it later.
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => guard.attempt(() => void run(tabId))}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-medium transition-colors",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                    !canRun && "cursor-not-allowed opacity-50",
                  )}
                >
                  <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
                  {hasRun
                    ? "Re-run"
                    : localSelected && commitSelectedCount === 0
                      ? "Review local changes"
                      : !localSelected && commitSelectedCount === 1
                        ? "Review commit"
                        : "Review changes"}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
                {!canRun
                  ? localOnlyEmpty
                    ? "Your working tree is clean — nothing uncommitted to review."
                    : "Select something to review and wait for its diff to load."
                  : hasRun
                    ? "Re-analyze from scratch."
                    : localSelected && commitSelectedCount === 0
                      ? "Analyze your uncommitted changes for bugs and regressions before you commit."
                      : localSelected && commitSelectedCount > 0
                        ? `Analyze your local changes and ${commitSelectedCount} commit${commitSelectedCount === 1 ? "" : "s"} together.`
                        : commitSelectedCount > 1
                          ? `Analyze these ${commitSelectedCount} commits together for bugs and regressions.`
                          : "Analyze this commit's change for bugs and regressions."}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Banners */}
      {!codeSearchEnabled ? (
        <Banner tone="warn">
          <span>
            Code search is off — the reviewer can only see this commit's diff,
            not its blast radius across your codebase.
          </span>
          <button
            type="button"
            onClick={() => void setCodeSearchEnabled(true)}
            className="shrink-0 rounded-sm border border-amber-500/40 px-1.5 py-px text-[10.5px] font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
          >
            Enable
          </button>
        </Banner>
      ) : null}
      {headMoved ? (
        <Banner tone="info">
          {movedCommits.length > 1 ? "Some selected commits aren't" : "This commit isn't"}{" "}
          the latest in{" "}
          {/* Named per repo: at more than one there is no single working tree,
              so one shared head sha would be wrong for every other repo. */}
          {[...new Set(movedCommits.map((d) => d.repoName))].join(", ")}{" "}
          {movedCommits.length === 1 && movedCommits[0].headSha ? (
            <>
              (working tree at{" "}
              <span className="font-mono">{movedCommits[0].headSha}</span>){" "}
            </>
          ) : null}
          — surrounding code is read from the current tree, which may differ from{" "}
          {movedCommits.length > 1 ? "those commits'" : "this commit's"} state.
        </Banner>
      ) : null}
      {/* A repo that couldn't be read drops out of the picker with nothing to
          show it did. In the single-repo era one failure emptied `commits` and
          always produced the full-pane error above; now the review quietly
          covers less of the workspace than the user thinks it does. */}
      {slice.commitsError && slice.commits.length > 0 ? (
        <Banner tone="warn">
          {slice.commitsError} — this review covers the repos that did answer.
        </Banner>
      ) : null}
      {slice.diffError ? (
        <Banner tone="warn">{slice.diffError}</Banner>
      ) : null}
      {localOnlyEmpty ? (
        <Banner tone="info">
          No uncommitted changes to review — your working tree is clean. Make
          some edits, or pick a commit instead.
        </Banner>
      ) : null}
      {localSelected && slice.findings.length > 0 ? (
        <Banner tone="info">
          These findings cover your local changes as they were when the review
          ran. Edit or switch branches since? Re-run to check the current tree.
        </Banner>
      ) : null}
      {combinedDiffTooLarge ? (
        <Banner tone="warn">
          These {selectionCount} changes add up to a large combined diff (~
          {Math.round(combinedDiffBytes / 1024)} KB). They're reviewed as one
          change, so a selection this big can exhaust the model's context or step
          budget and yield thinner findings — consider reviewing fewer at a time.
        </Banner>
      ) : null}
      <BestPracticeNotice className="mx-3 my-1.5" />
      {showsContextAdvisory(guard.usage, guard.guardEnabled) ? (
        <div className="px-3 py-1.5">
          <ContextGuardNotice
            usage={guard.usage}
            guardEnabled={guard.guardEnabled}
            modelLabel={guardModelLabel}
          />
        </div>
      ) : null}
      <ContextOverflowDialog guard={guard} modelLabel={guardModelLabel} />
      {!slice.busy && (slice.status === "interrupted" || slice.status === "cancelled") ? (
        resumable ? (
          <div className="border-b border-border/45 px-3 py-2">
            {/* The card renders either way. Discard lives inside it, so gating
                the whole thing on `offerResume` is what made an unresumable
                checkpoint undeletable as well as unreachable. */}
            <ResumeCard
              title={
                slice.status === "cancelled"
                  ? "You stopped this review"
                  : "This review didn't finish"
              }
              detail={[
                `Stopped during ${stageWord(resumable.stage)}`,
                resumable.stepsUsed > 0
                  ? `${resumable.stepsUsed} step${resumable.stepsUsed === 1 ? "" : "s"} in`
                  : null,
                // What the interrupted attempt already bought, in the unit the
                // run is rationed by — resuming replays it rather than paying
                // for it twice.
                resumable.totalTokens
                  ? `~${formatTokens(resumable.totalTokens)} tokens spent`
                  : null,
                relativeTime(resumable.updatedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
              onResume={
                offerResume
                  ? () => guard.attempt(() => void resume(tabId))
                  : undefined
              }
              unresumableReason={
                offerResume
                  ? undefined
                  : resumeUnavailableReason(resumable.outcome, resumable)
              }
              onDiscard={() => discardCheckpoint(tabId)}
            />
          </div>
        ) : (
          <Banner tone="warn">
            This review was {slice.status === "interrupted" ? "interrupted" : "cancelled"} before it finished. Re-run to complete it.
          </Banner>
        )
      ) : null}

      {/* Which repos the reviewer may READ. Deliberately not a filter on the
          commit list: a commit in one repo often can't be judged without
          reading a different one that has no commit in the selection at all.
          Only worth a control once there's a choice to make, and only when
          anything reads source at all. */}
      {codeSearchEnabled && repos.length > 1 ? (
        <div className="border-b border-border/45 px-3 py-2">
          <RepoScopeChips
            repos={repos}
            scope={slice.repoScope}
            onToggle={(repoId) => toggleRepo(tabId, repoId)}
            label="Repos the reviewer can read"
            hint={
              scopedRepos(repos, slice.repoScope).length === 0
                ? "Nothing selected — the reviewer sees the diff and nothing else."
                : "Which repos it may open files in while tracing this change. Separate from which commits you picked above."
            }
          />
        </div>
      ) : null}

      {/* Add context (collapsed) */}
      <div className="border-b border-border/45 px-3 py-2">
        <ContextSection
          tabId={tabId}
          context={slice.context}
          workItems={slice.workItems}
          attachments={slice.attachments}
          onContext={(t) => setContext(tabId, t)}
          onAddWorkItem={(it) => addWorkItem(tabId, it)}
          onRemoveWorkItem={(id) => removeWorkItem(tabId, id)}
          onAddAttachment={(a) => addAttachment(tabId, a)}
          onRemoveAttachment={(id) => removeAttachment(tabId, id)}
        />
      </div>

      {/* Body */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <Body
          slice={slice}
          tabId={tabId}
          repos={repos}
          applyFix={applyFix}
          onRun={() => guard.attempt(() => void run(tabId))}
          onResume={() => guard.attempt(() => void resume(tabId))}
          onDiscard={() => discardCheckpoint(tabId)}
          showDiff={showDiff}
        />
      </div>
    </div>
  );
}

/** Human phrasing for a checkpoint's stage — "investigate"/"verify" are the
 *  wire enum, not what a QA tester reads in a banner. */
function stageWord(stage: "investigate" | "verify"): string {
  return stage === "verify" ? "verification" : "investigation";
}

function Banner({
  tone,
  children,
}: {
  tone: "warn" | "info";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-[11px] leading-snug",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300"
          : "border-border/40 bg-foreground/[0.02] text-muted-foreground",
      )}
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function Body({
  slice,
  tabId,
  repos,
  applyFix,
  onRun,
  onResume,
  onDiscard,
  showDiff,
}: {
  slice: CommitReviewSlice;
  tabId: number;
  /** The review's repos — what a finding's `<repo>/<path>` resolves against. */
  repos: WorkspaceRepo[];
  applyFix: (tabId: number, findingId: string, record: AppliedPatchRecord) => void;
  onRun: () => void;
  onResume: () => void;
  onDiscard: () => void;
  showDiff: boolean;
}) {
  const diffs = selectedDiffs(slice);
  // Stage 1's output, rendered wherever the run didn't get as far as merged
  // findings — mid-verify, stopped, crashed, or errored. One insertion point
  // rather than a copy in each of BodyContent's branches, so the partial
  // results can't quietly go missing from whichever branch nobody updated.
  const partial =
    slice.status !== "done" &&
    slice.findings.length === 0 &&
    slice.stage1Candidates &&
    slice.stage1Candidates.length > 0
      ? slice.stage1Candidates
      : null;
  return (
    <div className="flex flex-col gap-3">
      {showDiff && diffs.length > 0 ? <CommitDiffPanel diffs={diffs} /> : null}
      {partial ? (
        <PartialFindings
          candidates={partial}
          verifying={slice.busy}
          repos={repos}
          appliedPatches={slice.appliedPatches}
          onApply={(findingId, record) => applyFix(tabId, findingId, record)}
        />
      ) : null}
      <BodyContent
        slice={slice}
        tabId={tabId}
        repos={repos}
        applyFix={applyFix}
        onRun={onRun}
        onResume={onResume}
        onDiscard={onDiscard}
      />
    </div>
  );
}

/** Stage 1's findings when stage 2 never delivered a verdict on them.
 *
 *  They are real, already-paid-for results — the investigate pass is the
 *  expensive one — and before this they existed only inside the checkpoint blob.
 *  A review the user stopped (or that died) during verification rendered an
 *  activity log and nothing else, so the whole spend read as lost. Framed
 *  honestly as UNVERIFIED: the pass that kills false positives didn't run, so
 *  these carry the first pass's own confidence and nothing more. */
function PartialFindings({
  candidates,
  verifying,
  repos,
  appliedPatches,
  onApply,
}: {
  candidates: CandidateFinding[];
  /** The verify pass is still running — this is a live preview, not a remnant. */
  verifying: boolean;
  repos: WorkspaceRepo[];
  appliedPatches: AppliedPatchesMap;
  onApply: (findingId: string, record: AppliedPatchRecord) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/[0.04]">
      <div className="flex items-center gap-1.5 border-b border-amber-500/25 px-3 py-1.5">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={11}
          strokeWidth={1.75}
          className="shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
          unverified · first pass
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {candidates.length.toString().padStart(2, "0")}
        </span>
      </div>
      <p className="px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        {verifying
          ? "The investigation found these. The verification pass is still trying to refute each one, so some may disappear."
          : "The investigation found these and the verification pass never ran, so nothing has tried to refute them yet — expect some false positives. Resume to verify them without paying for the investigation again."}
      </p>
      <div className="px-3 pb-3 pt-2">
        <FindingsList
          findings={unverifiedFindings(candidates)}
          repos={repos}
          appliedPatches={appliedPatches}
          durationMs={null}
          onApply={onApply}
        />
      </div>
    </div>
  );
}

/** Commit-review-specific error classification. The parse outcomes are keyed
 *  on the STRUCTURAL errorReason (never sentence matching); everything thrown
 *  by the provider routes through the shared classifier so this surface and
 *  the Generator render identical remediation for the same failure. */
function classifyReviewError(slice: CommitReviewSlice): ErrorClass {
  if (slice.errorReason === "step_cap") {
    const spent = budgetSpentPhrase(
      slice.errorLimit ?? undefined,
      {
        tokens: SURFACE_TOKEN_BUDGETS.commitReviewInvestigate,
        steps: SURFACE_STEP_CAPS.commitReviewInvestigate,
      },
      formatTokens,
    );
    return {
      code: "REV/03 · BUDGET",
      title: "Ran out of budget before writing findings",
      icon: AiBrain01Icon,
      tone: "config",
      why: `The reviewer spent ${spent} investigating the change — reading files, tracing callers — and never reached the point of writing its findings. A review is rationed by the tokens it reads, not by how many turns it takes, because one turn can read a whole file.`,
      steps: [
        `Resume adds ~${formatTokens(RESUME_TOPUP_TOKENS)} more tokens and tells the model to finish with what it already read — usually enough to land the findings. Nothing it investigated is thrown away.`,
        "If it runs out again, review fewer commits at once, or turn off code search so there's less to read.",
      ],
    };
  }
  if (slice.errorReason === "empty") {
    return {
      code: "REV/02 · EMPTY-RESULT",
      title: "The model returned nothing usable",
      icon: AiBrain01Icon,
      tone: "config",
      why: "The run completed but the model wrote no findings output at all. OpenAI-compatible or custom endpoints often need JSON mode (structured output) turned on before they return a usable answer.",
      steps: [
        "Re-run — transient truncation happens.",
        "If it repeats, switch to a more capable model for this review.",
      ],
    };
  }
  if (slice.errorReason === "schema_violation") {
    return {
      code: "REV/01 · BAD-FORMAT",
      title: "The model didn't return findings in the expected format",
      icon: AiBrain01Icon,
      tone: "config",
      why: "The model answered, but its output couldn't be read as the structured findings this review expects. Common with models that don't reliably produce structured JSON.",
      steps: [
        "Open the raw output below to see exactly what it sent back.",
        "Re-run, or switch to a more capable model for this review.",
      ],
    };
  }
  return classifyProviderError(slice.error ?? "") ?? unclassifiedError();
}

function BodyContent({
  slice,
  tabId,
  repos,
  applyFix,
  onRun,
  onResume,
  onDiscard,
}: {
  slice: CommitReviewSlice;
  tabId: number;
  repos: WorkspaceRepo[];
  applyFix: (tabId: number, findingId: string, record: AppliedPatchRecord) => void;
  onRun: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  if (slice.busy) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11.5px] text-foreground/80">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={12}
            strokeWidth={2}
            className="animate-spin text-primary"
          />
          {slice.stage === "verify"
            ? "Verifying findings — trying to refute each one to kill false positives…"
            : "Investigating the change and its blast radius…"}
        </div>
        <StallHint signature={`${slice.activity.length}:${slice.stage}`} />
        <AnalyzeActivityLog entries={slice.activity} running maxHeightClass="max-h-[60vh]" />
      </div>
    );
  }

  // A stopped run's frozen activity log — the where-it-was context under the
  // resume card, so a reopened interrupted review shows what it had been
  // doing instead of an empty "press Review" state.
  if (
    (slice.status === "interrupted" || slice.status === "cancelled") &&
    slice.activity.length > 0
  ) {
    return (
      <AnalyzeActivityLog entries={slice.activity} maxHeightClass="max-h-[60vh]" />
    );
  }

  if (slice.status === "error") {
    const resumable = slice.resumable;
    const offerResume =
      resumable != null &&
      canOfferResume(resumable.outcome, slice.error, resumable);
    const klass = classifyReviewError(slice);
    return (
      <RunErrorPanel
        klass={klass}
        // See GeneratorPane: the provider's finish reason is the one thing that
        // separates "the model wandered" from "it ran out of output tokens".
        metaLabel={
          resumable?.outcome?.finishReason
            ? `finish: ${resumable.outcome.finishReason}`
            : undefined
        }
        raw={slice.schemaViolationRaw ?? slice.error}
        rawLabel={
          slice.schemaViolationRaw
            ? "show the model's raw output"
            : "show raw error"
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          {resumable && offerResume ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onResume}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-medium bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
                  Resume
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
                Continues where it stopped with the original model — finished
                steps aren't re-run.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {klass.primary ? (
            <button
              type="button"
              onClick={klass.primary.onClick}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2.5 text-[11.5px] font-medium hover:bg-foreground/[0.05]"
            >
              <HugeiconsIcon icon={klass.primary.icon} size={12} strokeWidth={2} />
              {klass.primary.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRun}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2.5 text-[11.5px] font-medium hover:bg-foreground/[0.05]"
          >
            <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
            Re-run
          </button>
          {/* A checkpoint we can't continue is still a checkpoint on disk.
              Discard used to ride inside the Resume affordance, so hiding
              Resume hid the only way to delete it. */}
          {resumable && !offerResume ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onDiscard}
                  className="ml-auto h-7 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  Discard saved progress
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
                {resumeUnavailableReason(resumable.outcome, resumable)}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </RunErrorPanel>
    );
  }

  if (slice.findings.length > 0) {
    return (
      <FindingsList
        findings={slice.findings}
        repos={repos}
        appliedPatches={slice.appliedPatches}
        durationMs={slice.durationMs}
        onApply={(findingId, record) => applyFix(tabId, findingId, record)}
      />
    );
  }

  if (slice.status === "done") {
    const doneDiffs = selectedDiffs(slice);
    const doneLocal = doneDiffs.length === 1 && doneDiffs[0].isLocal;
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-8 text-center">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          size={22}
          strokeWidth={1.75}
          className="text-emerald-600 dark:text-emerald-400"
        />
        <p className="text-[12.5px] font-medium text-foreground">
          {doneLocal
            ? "No issues found in your local changes."
            : doneDiffs.length > 1
              ? `No issues found across these ${doneDiffs.length} commits.`
              : "No issues found in this commit's changes."}
        </p>
        <p className="max-w-sm text-[11.5px] leading-snug text-muted-foreground">
          {doneLocal ? (
            "Your uncommitted changes look clean. "
          ) : doneDiffs.length === 1 ? (
            <>
              <span className="font-mono">{doneDiffs[0].shortSha}</span> —{" "}
              {doneDiffs[0].subject}.{" "}
            </>
          ) : null}
          Add context (the ticket you're fixing) and re-run if you want the
          change checked against intent.
        </p>
      </div>
    );
  }

  // Idle — no run yet.
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 rounded-md border border-border/55 bg-card/30 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={SparklesIcon}
        size={20}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      <div className="flex flex-col gap-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Review your changes for bugs
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Pick what to review, then press{" "}
          <span className="font-medium text-foreground">Review</span>. It reads
          the diff, traces its blast radius across your code, and flags bugs by
          severity with one-click fixes.
        </p>
      </div>
      <div className="flex w-full flex-col gap-1.5 text-left">
        <SourceHint
          icon={PencilEdit01Icon}
          title="Local changes"
          desc="Everything uncommitted — review it before you commit."
        />
        <SourceHint
          icon={GitBranchIcon}
          title="Commits"
          desc="One, or several together — and your local changes alongside them."
        />
      </div>
    </div>
  );
}

/** Compact source-option row for the idle empty state. */
function SourceHint({
  icon,
  title,
  desc,
}: {
  icon: typeof SparklesIcon;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/45 bg-background/40 px-2.5 py-2">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-muted-foreground">
        <HugeiconsIcon icon={icon} size={11} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-[11.5px] font-medium text-foreground">{title}</span>
        <span className="text-[10.5px] leading-snug text-muted-foreground">
          {desc}
        </span>
      </div>
    </div>
  );
}

function FindingsList({
  findings,
  repos,
  appliedPatches,
  durationMs,
  onApply,
}: {
  findings: Finding[];
  repos: WorkspaceRepo[];
  appliedPatches: AppliedPatchesMap;
  durationMs: number | null;
  onApply: (findingId: string, record: AppliedPatchRecord) => void;
}) {
  const primary = findings.filter((f) => f.confidence !== "low");
  const low = findings.filter((f) => f.confidence === "low");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{findings.length}</span>{" "}
        finding{findings.length === 1 ? "" : "s"}
        {durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}
        {low.length > 0 ? ` · ${low.length} low-confidence hidden below` : ""}
      </p>
      <ul className="flex flex-col gap-1.5">
        {primary.map((f) => (
          <li key={f.id}>
            <FindingCard
              finding={f}
              repos={repos}
              applied={appliedPatches[f.id] ?? null}
              onApplied={(record) => onApply(f.id, record)}
            />
          </li>
        ))}
      </ul>
      {primary.length === 0 ? (
        <p className="rounded-md border border-border/50 bg-card/30 px-3 py-2 text-[11.5px] text-muted-foreground">
          Only low-confidence findings this run — expand them below, or re-run.
        </p>
      ) : null}
      {low.length > 0 ? (
        <details className="group/low">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={1.75}
              className="transition-transform group-open/low:rotate-90"
            />
            {low.length} lower-confidence finding{low.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {low.map((f) => (
              <li key={f.id}>
                <FindingCard
                  finding={f}
                  repos={repos}
                  applied={appliedPatches[f.id] ?? null}
                  onApplied={(record) => onApply(f.id, record)}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit picker
// ---------------------------------------------------------------------------

function CommitPicker({
  commits,
  repos,
  selected,
  loading,
  disabled,
  dirtyRepoIds,
  onToggleLocal,
  onToggle,
  onClear,
  onRefresh,
}: {
  /** Every repo's commits, already merged newest-first. */
  commits: RepoCommitMeta[];
  repos: WorkspaceRepo[];
  /** `${repoId}:${sha}` keys. */
  selected: string[];
  loading: boolean;
  /** Locked while a review is running so the reviewed set can't change mid-run. */
  disabled?: boolean;
  /** Repos with uncommitted changes — one "Local changes" row each. */
  dirtyRepoIds: string[];
  onToggleLocal: (repoId: string) => void;
  onToggle: (key: string) => void;
  onClear: () => void;
  /** Re-read every repo's `git log` + dirty state. */
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const multiRepo = repos.length > 1;
  // Newest commit PER REPO. A single `commits[0]` was right when the list was
  // one repo's history; once repos interleave it badges whichever repo happens
  // to have committed most recently and nothing else.
  const headByRepo = new Map<string, string>();
  for (const c of commits) {
    if (!headByRepo.has(c.repoId)) headByRepo.set(c.repoId, c.sha);
  }
  const localSelectedRepos = repos.filter((r) =>
    selectedSet.has(commitKey(r.id, LOCAL_CHANGES_SHA)),
  );
  const localSelected = localSelectedRepos.length > 0;
  const commitSelectedCount = selected.filter((s) => !isLocalKey(s)).length;
  // When exactly one commit (and nothing else) is selected, show it inline.
  const onlyCommit =
    !localSelected && selected.length === 1
      ? commits.find((c) => commitKey(c.repoId, c.sha) === selected[0]) ?? null
      : null;

  // Manual, order-preserving filter. cmdk's built-in fuzzy sort reorders rows
  // by match score (and the order doesn't fully restore after you clear the
  // box), so we disable it and keep commits in chronological order always.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? commits.filter(
        (c) =>
          c.repoName.toLowerCase().includes(q) ||
          c.shortSha.toLowerCase().includes(q) ||
          c.subject.toLowerCase().includes(q) ||
          c.sha.toLowerCase().includes(q),
      )
    : commits;
  // A repo's "Local changes" row matches an empty box, its own name, or any of
  // the shared keywords.
  const localRows = repos.filter(
    (r) =>
      dirtyRepoIds.includes(r.id) &&
      (!q ||
        r.name.toLowerCase().includes(q) ||
        "local changes uncommitted working tree".includes(q)),
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select commits to review"
          disabled={disabled || (loading && commits.length === 0)}
          className={cn(
            "inline-flex h-7 min-w-0 max-w-[420px] items-center gap-1.5 rounded-md border border-border/50 bg-card/60 px-2 text-[11.5px] transition-colors hover:bg-foreground/[0.05]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <HugeiconsIcon
            icon={
              loading
                ? Loading03Icon
                : localSelected
                  ? PencilEdit01Icon
                  : GitBranchIcon
            }
            size={12}
            strokeWidth={1.75}
            className={cn("shrink-0 text-muted-foreground", loading && "animate-spin")}
          />
          {localSelected ? (
            <span className="min-w-0 truncate font-medium text-foreground/85">
              Local changes
              {multiRepo && localSelectedRepos.length === 1
                ? ` · ${localSelectedRepos[0].name}`
                : localSelectedRepos.length > 1
                  ? ` · ${localSelectedRepos.length} repos`
                  : ""}
              {commitSelectedCount > 0
                ? ` + ${commitSelectedCount} commit${commitSelectedCount === 1 ? "" : "s"}`
                : ""}
            </span>
          ) : onlyCommit ? (
            <>
              {multiRepo ? (
                <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 text-[9.5px] uppercase tracking-wide text-muted-foreground">
                  {onlyCommit.repoName}
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-foreground/85">
                {onlyCommit.shortSha}
              </span>
              <span className="min-w-0 truncate text-foreground/75">
                {onlyCommit.subject}
              </span>
            </>
          ) : selected.length > 1 ? (
            <span className="shrink-0 text-foreground/85">
              {selected.length} commits selected
            </span>
          ) : (
            <span className="text-muted-foreground">
              {loading ? "Loading commits…" : "Select commits…"}
            </span>
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/70"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={4} className="w-[460px] p-0">
        {/* shouldFilter={false}: we filter ourselves (above) so row order is
            stable. Toggling keeps the popover open for multi-select. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={
              multiRepo
                ? "Search commits by repo, message or sha…"
                : "Search commits by message or sha…"
            }
          />
          <CommandList className="max-h-[340px]">
            {localRows.length > 0 ? (
              <CommandGroup heading="Working tree">
                {localRows.map((repo) => {
                  const key = commitKey(repo.id, LOCAL_CHANGES_SHA);
                  const isSel = selectedSet.has(key);
                  return (
                    <CommandItem
                      key={key}
                      value={key}
                      data-checked={isSel}
                      // Toggles in place — can be reviewed alone or with commits.
                      onSelect={() => onToggleLocal(repo.id)}
                      className="items-center gap-2"
                    >
                      <Checkbox on={isSel} />
                      <HugeiconsIcon
                        icon={PencilEdit01Icon}
                        size={12}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground"
                      />
                      {multiRepo ? <RepoChip name={repo.name} /> : null}
                      <span className="min-w-0 flex-1 truncate text-[12px]">
                        Local changes
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        uncommitted
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {filtered.length === 0 ? (
              localRows.length > 0 ? null : (
                <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                  No commits match.
                </div>
              )
            ) : (
            <CommandGroup heading="Commits">
              {filtered.map((c) => {
                const key = commitKey(c.repoId, c.sha);
                const isSel = selectedSet.has(key);
                return (
                <CommandItem
                  key={key}
                  value={key}
                  data-checked={isSel}
                  // Don't close — multi-select toggles in place.
                  onSelect={() => onToggle(key)}
                  className="items-center gap-2"
                >
                  <Checkbox on={isSel} />
                  {multiRepo ? <RepoChip name={c.repoName} /> : null}
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {c.shortSha}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {c.subject}
                  </span>
                  {headByRepo.get(c.repoId) === c.sha ? (
                    <span
                      title={
                        multiRepo
                          ? `The latest commit on ${c.repoName}'s current branch (HEAD). That repo's working tree matches this commit.`
                          : "The latest commit on this branch (HEAD). Surrounding code in your working tree matches this commit."
                      }
                      className="shrink-0 rounded-sm bg-primary/12 px-1 text-[9px] font-medium uppercase tracking-wide text-primary"
                    >
                      head
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {c.relativeDate}
                  </span>
                </CommandItem>
                );
              })}
            </CommandGroup>
            )}
          </CommandList>
          {/* Always rendered, because Refresh lives here: the list is a cache
              of `git log`, and a commit made in an external terminal only
              appears on the 30 s poll, on window focus, or on a branch switch.
              Waiting for one of those to review work you just committed is the
              gap this closes. */}
          <div className="flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
            <span className="min-w-0 truncate">
              {selected.length > 0
                ? `${[
                    localSelectedRepos.length > 1
                      ? `Local changes in ${localSelectedRepos.length} repos`
                      : localSelected
                        ? "Local changes"
                        : null,
                    commitSelectedCount > 0
                      ? `${commitSelectedCount} commit${commitSelectedCount === 1 ? "" : "s"}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" + ")} selected`
                : multiRepo
                  ? `${commits.length} commits across ${repos.length} repos`
                  : `${commits.length} commits`}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {selected.length > 0 ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="shrink-0 rounded-sm px-1.5 py-px font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  Clear
                </button>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-px font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <HugeiconsIcon
                      icon={RefreshIcon}
                      size={11}
                      strokeWidth={1.75}
                      className={cn(loading && "animate-spin")}
                    />
                    Refresh
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[280px] text-[11px]">
                  Re-read every repo&rsquo;s recent commits and uncommitted
                  state — for work you just committed outside the app. Your
                  selection is kept.
                </TooltipContent>
              </Tooltip>
            </span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The picker's multi-select tick. Extracted only because the local-changes
 *  rows and the commit rows now both render N of them. */
function Checkbox({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border/70",
      )}
    >
      {on ? <HugeiconsIcon icon={Tick02Icon} size={9} strokeWidth={3} /> : null}
    </span>
  );
}

/** Which repo a picker row belongs to. Shown only above one repo — at one it
 *  would label every row with the same word. */
function RepoChip({ name }: { name: string }) {
  return (
    <span className="max-w-[110px] shrink-0 truncate rounded-sm bg-foreground/[0.06] px-1 text-[9.5px] uppercase tracking-wide text-muted-foreground">
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add context (collapsed): freeform + #id work-item mention + attachments
// ---------------------------------------------------------------------------

function ContextSection({
  tabId: _tabId,
  context,
  workItems,
  attachments,
  onContext,
  onAddWorkItem,
  onRemoveWorkItem,
  onAddAttachment,
  onRemoveAttachment,
}: {
  tabId: number;
  context: string;
  workItems: WorkItemRef[];
  attachments: Attachment[];
  onContext: (text: string) => void;
  onAddWorkItem: (item: WorkItemRef) => void;
  onRemoveWorkItem: (id: number) => void;
  onAddAttachment: (a: Attachment) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [ingestErrors, setIngestErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasContent =
    context.trim().length > 0 || workItems.length > 0 || attachments.length > 0;

  const mention = useWorkItemMention({
    value: context,
    onValueChange: onContext,
    onAdd: onAddWorkItem,
    selectedIds: workItems.map((w) => w.id),
  });

  const ingest = async (files: File[]) => {
    if (files.length === 0) return;
    const errs: string[] = [];
    for (const f of files) {
      const r = await ingestFile(f);
      if (r.ok) onAddAttachment(r.attachment);
      else errs.push(r.error.message);
    }
    if (errs.length > 0) setIngestErrors(errs);
  };

  return (
    <details open={hasContent} className="group/ctx">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={1.75}
          className="transition-transform group-open/ctx:rotate-90"
        />
        Add context
        <span className="text-muted-foreground/60">
          (the ticket you're fixing, specs, files)
        </span>
        {hasContent ? (
          <span className="ml-1 size-1.5 rounded-full bg-primary/70" />
        ) : null}
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        <div
          className={cn(
            "relative rounded-md border transition-colors",
            dragOver ? "border-primary/60 ring-1 ring-primary/30" : "border-border/55",
          )}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void ingest(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          {mention.active ? (
            <MentionDropdown mention={mention} placement="bottom" />
          ) : null}
          <textarea
            ref={taRef}
            value={context}
            rows={4}
            placeholder="Paste the Asana / Jira ticket or spec here — what should this change do? Type #id to attach an Azure DevOps work item. Drop or paste files/screenshots."
            onChange={(e) => {
              onContext(e.target.value);
              mention.noteInput(e.target.value, e.target.selectionStart ?? 0);
            }}
            onSelect={(e) =>
              mention.noteCaret(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? 0,
              )
            }
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              const named = files.map((f) =>
                f.name
                  ? f
                  : new File([f], synthesizeClipboardImageName(f.type || "image/png"), {
                      type: f.type,
                    }),
              );
              void ingest(named);
            }}
            className="block w-full resize-y rounded-md bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-snug text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {dragOver ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-primary/[0.06] text-[11px] font-medium text-primary">
              Drop to attach
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void ingest(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border/55 px-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
              >
                Attach files
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
              Attach source files or screenshots. Images go to the model as
              vision input; you can also drop or paste them.
            </TooltipContent>
          </Tooltip>
          <MentionHint loading={mention.loading} />
        </div>

        <WorkItemChips items={workItems} onRemove={onRemoveWorkItem} />
        {attachments.length > 0 ? (
          <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />
        ) : null}
        {ingestErrors.length > 0 ? (
          <div className="flex flex-col gap-1">
            {ingestErrors.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10.5px] text-amber-700 dark:text-amber-300"
              >
                <span className="min-w-0 flex-1 truncate">{m}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() =>
                        setIngestErrors((prev) => prev.filter((_, j) => j !== i))
                      }
                      aria-label="Dismiss"
                      className="shrink-0"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    Dismiss this error
                  </TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
