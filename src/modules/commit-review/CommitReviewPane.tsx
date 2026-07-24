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
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  GitBranchIcon,
  Loading03Icon,
  PencilEdit01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { MODELS, type ModelId } from "@/modules/ai/config";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
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
} from "@/modules/ai/lib/contextEstimate";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setCodeSearchEnabled } from "@/modules/settings/store";
import { SOURCE_GIT_CHANGED_EVENT } from "@/modules/git";
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
import {
  useCommitReview,
  selectedDiffs,
  allDiffsLoaded,
  type CommitReviewSlice,
} from "./useCommitReview";
import { combinedPatchBytes, COMBINED_DIFF_WARN_BYTES } from "./runCommitReview";
import { CommitDiffPanel } from "./CommitDiffView";
import { FindingCard } from "./FindingCard";
import { LOCAL_CHANGES_SHA, type CommitMeta } from "./gitCommitApi";
import type { Finding } from "./schema";
import type { AppliedPatchRecord, AppliedPatchesMap } from "./patchSchema";
import type { WorkItemRef } from "@/modules/ado";
import type { Attachment } from "@/components/chat/attachments";

type Props = {
  tabId: number;
  cwd: string;
  modelId?: ModelId | null;
  rehydrateRunId?: string | null;
};

export function CommitReviewPane({ tabId, cwd, modelId, rehydrateRunId }: Props) {
  const slice = useCommitReview((s) => s.byTab.get(tabId));
  const ensure = useCommitReview((s) => s.ensure);
  const toggleCommit = useCommitReview((s) => s.toggleCommit);
  const toggleLocalChanges = useCommitReview((s) => s.toggleLocalChanges);
  const refreshSource = useCommitReview((s) => s.refreshSource);
  const clearCommits = useCommitReview((s) => s.clearCommits);
  const setContext = useCommitReview((s) => s.setContext);
  const addAttachment = useCommitReview((s) => s.addAttachment);
  const removeAttachment = useCommitReview((s) => s.removeAttachment);
  const addWorkItem = useCommitReview((s) => s.addWorkItem);
  const removeWorkItem = useCommitReview((s) => s.removeWorkItem);
  const setModel = useCommitReview((s) => s.setModel);
  const run = useCommitReview((s) => s.run);
  const stop = useCommitReview((s) => s.stop);
  const applyFix = useCommitReview((s) => s.applyFix);

  const codeSearchEnabled = usePreferencesStore((s) => s.codeSearchEnabled);
  const defaultModelId = usePreferencesStore((s) => s.defaultModelId);
  const availability = useModelAvailability();

  // Whether the commit's diff is expanded below. Toggled from the stats chip
  // in the header; persists across commit switches within this tab session.
  const [showDiff, setShowDiff] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void ensure(tabId, cwd, rehydrateRunId ?? null, modelId ?? null);
  }, [tabId, cwd, rehydrateRunId, modelId, ensure]);

  // Keep an open tab in sync with the source dir's git state: when a branch
  // switch / pull / stash op fires `source-git-changed` (the same event the
  // status-bar readers listen to), re-read this tab's commit list, dirty-state,
  // and any cached "Local changes" diff so it never shows the previous branch.
  useEffect(() => {
    const onChanged = () => void refreshSource(tabId);
    window.addEventListener(SOURCE_GIT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SOURCE_GIT_CHANGED_EVENT, onChanged);
  }, [tabId, refreshSource]);

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

  // Repo-level failure (no source dir / not a git repo) — nothing else works.
  if (slice.commitsError && slice.commits.length === 0) {
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
            Can't read commits here
          </p>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            {slice.commitsError}. Point your source directory (bottom-left
            status bar) at a git repository, then reopen Commit Review.
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
  const distinctFiles = new Set(diffs.flatMap((d) => d.files.map((f) => f.path)))
    .size;
  const localSelected = slice.selectedShas.includes(LOCAL_CHANGES_SHA);
  const commitSelectedCount = slice.selectedShas.filter(
    (s) => s !== LOCAL_CHANGES_SHA,
  ).length;
  const headSha = diffs[0]?.headSha ?? "";
  const headMoved = diffs.some(
    (d) =>
      // The live working-tree diff is always against the current HEAD, so it
      // never "moved on" — only committed diffs can.
      !d.isLocal &&
      !!d.headSha &&
      !!d.shortSha &&
      d.shortSha.slice(0, 7) !== d.headSha.slice(0, 7),
  );
  const combinedDiffBytes = combinedPatchBytes(diffs);
  const combinedDiffTooLarge =
    selectionCount > 1 && combinedDiffBytes > COMBINED_DIFF_WARN_BYTES;

  // "Local changes" picked on its own, but its diff came back empty (clean tree,
  // or everything got committed since) — nothing to review. Only blocks the run
  // when local is the ONLY thing selected; alongside commits it's harmless.
  const localDiff = diffs.find((d) => d.isLocal);
  const localOnlyEmpty =
    localSelected &&
    commitSelectedCount === 0 &&
    !!localDiff &&
    localDiff.files.length === 0;
  const canRun = allDiffsLoaded(slice) && !slice.diffLoading && !localOnlyEmpty;
  const hasRun = slice.status !== "idle" && slice.status !== "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: commit picker + stats + model + run/stop */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/45 px-3 py-2">
        <CommitPicker
          commits={slice.commits}
          selected={slice.selectedShas}
          loading={slice.commitsLoading}
          disabled={slice.busy}
          hasLocalChanges={slice.hasLocalChanges}
          localSelected={localSelected}
          onToggleLocal={() => void toggleLocalChanges(tabId)}
          onToggle={(sha) => void toggleCommit(tabId, sha)}
          onClear={() => clearCommits(tabId)}
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
            <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
              {showDiff ? "Hide the diff." : "Show the diff."}{" "}
              {selectionCount > 1
                ? `These ${selectionCount} changes are reviewed together as one combined diff.`
                : "Only the selected change is reviewed."}{" "}
              The model investigates its blast radius across your code with
              read-only tools.
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
                Cancel this review. Partial progress is saved.
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
          {selectionCount > 1 ? "Some selected commits aren't" : "This commit isn't"}{" "}
          your latest
          {headSha ? (
            <>
              {" "}
              (working tree at <span className="font-mono">{headSha}</span>)
            </>
          ) : null}
          . Surrounding code is read from the current tree, which may differ from{" "}
          {selectionCount > 1 ? "those commits'" : "this commit's"} state.
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
      {guard.guardEnabled && guard.usage.tier !== "comfortable" ? (
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
        <Banner tone="warn">
          This review was {slice.status === "interrupted" ? "interrupted" : "cancelled"} before it finished. Re-run to complete it.
        </Banner>
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
          applyFix={applyFix}
          onRun={() => guard.attempt(() => void run(tabId))}
          showDiff={showDiff}
        />
      </div>
    </div>
  );
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
  applyFix,
  onRun,
  showDiff,
}: {
  slice: CommitReviewSlice;
  tabId: number;
  applyFix: (tabId: number, findingId: string, record: AppliedPatchRecord) => void;
  onRun: () => void;
  showDiff: boolean;
}) {
  const diffs = selectedDiffs(slice);
  return (
    <div className="flex flex-col gap-3">
      {showDiff && diffs.length > 0 ? <CommitDiffPanel diffs={diffs} /> : null}
      <BodyContent slice={slice} tabId={tabId} applyFix={applyFix} onRun={onRun} />
    </div>
  );
}

function BodyContent({
  slice,
  tabId,
  applyFix,
  onRun,
}: {
  slice: CommitReviewSlice;
  tabId: number;
  applyFix: (tabId: number, findingId: string, record: AppliedPatchRecord) => void;
  onRun: () => void;
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
        <AnalyzeActivityLog entries={slice.activity} running maxHeightClass="max-h-[60vh]" />
      </div>
    );
  }

  if (slice.status === "error") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/[0.05] p-4">
        <p className="text-[12px] font-medium text-destructive">
          {slice.error ?? "The review failed."}
        </p>
        {slice.schemaViolationRaw ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground">
              Show the model's raw output
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-sm border border-border/40 bg-foreground/[0.04] p-2 text-[10.5px] leading-relaxed text-foreground/80">
              {slice.schemaViolationRaw}
            </pre>
          </details>
        ) : null}
        <button
          type="button"
          onClick={onRun}
          className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2.5 text-[11.5px] font-medium hover:bg-foreground/[0.05]"
        >
          <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
          Re-run
        </button>
      </div>
    );
  }

  if (slice.findings.length > 0) {
    return (
      <FindingsList
        findings={slice.findings}
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
  appliedPatches,
  durationMs,
  onApply,
}: {
  findings: Finding[];
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
  selected,
  loading,
  disabled,
  hasLocalChanges,
  localSelected,
  onToggleLocal,
  onToggle,
  onClear,
}: {
  commits: CommitMeta[];
  selected: string[];
  loading: boolean;
  /** Locked while a review is running so the reviewed set can't change mid-run. */
  disabled?: boolean;
  /** Whether the working tree has uncommitted changes (gates the local row). */
  hasLocalChanges: boolean;
  /** Whether the "Local changes" target is part of the selection. */
  localSelected: boolean;
  onToggleLocal: () => void;
  onToggle: (sha: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const headSha = commits[0]?.sha;
  const commitSelectedCount = selected.filter(
    (s) => s !== LOCAL_CHANGES_SHA,
  ).length;
  // When exactly one commit (and nothing else) is selected, show it inline.
  const onlyCommit =
    !localSelected && selected.length === 1
      ? commits.find((c) => c.sha === selected[0]) ?? null
      : null;

  // Manual, order-preserving filter. cmdk's built-in fuzzy sort reorders rows
  // by match score (and the order doesn't fully restore after you clear the
  // box), so we disable it and keep commits in chronological order always.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? commits.filter(
        (c) =>
          c.shortSha.toLowerCase().includes(q) ||
          c.subject.toLowerCase().includes(q) ||
          c.sha.toLowerCase().includes(q),
      )
    : commits;
  // The "Local changes" row matches an empty box or any of its keywords.
  const localRowVisible =
    hasLocalChanges &&
    (!q || "local changes uncommitted working tree".includes(q));

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
              {commitSelectedCount > 0
                ? ` + ${commitSelectedCount} commit${commitSelectedCount === 1 ? "" : "s"}`
                : ""}
            </span>
          ) : onlyCommit ? (
            <>
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
            placeholder="Search commits by message or sha…"
          />
          <CommandList className="max-h-[340px]">
            {localRowVisible ? (
              <CommandGroup heading="Working tree">
                <CommandItem
                  value="__local_changes__"
                  data-checked={localSelected}
                  // Toggles in place — can be reviewed alone or with commits.
                  onSelect={onToggleLocal}
                  className="items-center gap-2"
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                      localSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70",
                    )}
                  >
                    {localSelected ? (
                      <HugeiconsIcon icon={Tick02Icon} size={9} strokeWidth={3} />
                    ) : null}
                  </span>
                  <HugeiconsIcon
                    icon={PencilEdit01Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    Local changes
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    uncommitted
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {filtered.length === 0 ? (
              localRowVisible ? null : (
                <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                  No commits match.
                </div>
              )
            ) : (
            <CommandGroup heading="Commits">
              {filtered.map((c) => {
                const isSel = selectedSet.has(c.sha);
                return (
                <CommandItem
                  key={c.sha}
                  value={c.sha}
                  data-checked={isSel}
                  // Don't close — multi-select toggles in place.
                  onSelect={() => onToggle(c.sha)}
                  className="items-center gap-2"
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                      isSel
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70",
                    )}
                  >
                    {isSel ? (
                      <HugeiconsIcon icon={Tick02Icon} size={9} strokeWidth={3} />
                    ) : null}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {c.shortSha}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {c.subject}
                  </span>
                  {c.sha === headSha ? (
                    <span
                      title="The latest commit on this branch (HEAD). Surrounding code in your working tree matches this commit."
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
          {selected.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {[
                  localSelected ? "Local changes" : null,
                  commitSelectedCount > 0
                    ? `${commitSelectedCount} commit${commitSelectedCount === 1 ? "" : "s"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" + ")}{" "}
                selected
              </span>
              <button
                type="button"
                onClick={onClear}
                className="shrink-0 rounded-sm px-1.5 py-px font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                Clear
              </button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
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
