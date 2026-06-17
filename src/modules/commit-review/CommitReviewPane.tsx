import { useEffect, useRef, useState } from "react";
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
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type ModelId } from "@/modules/ai/config";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setCodeSearchEnabled } from "@/modules/settings/store";
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
import type { CommitMeta } from "./gitCommitApi";
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

  // The toggle lives in the fixed header but the diff renders at the top of the
  // scroll body — bring it into view when revealed so a scrolled-down reader
  // doesn't toggle it on and see nothing change.
  useEffect(() => {
    if (showDiff) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [showDiff]);

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
            {slice.commitsError}. Set your source directory to a git repository
            in Settings → General, then reopen Commit Review.
          </p>
        </div>
      </div>
    );
  }

  const effectiveModelId = slice.modelId ?? defaultModelId;
  const diffs = selectedDiffs(slice);
  const commitCount = diffs.length;
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
  const headSha = diffs[0]?.headSha ?? "";
  const headMoved = diffs.some(
    (d) =>
      !!d.headSha &&
      !!d.shortSha &&
      d.shortSha.slice(0, 7) !== d.headSha.slice(0, 7),
  );
  const combinedDiffBytes = combinedPatchBytes(diffs);
  const combinedDiffTooLarge =
    commitCount > 1 && combinedDiffBytes > COMBINED_DIFF_WARN_BYTES;

  const canRun = allDiffsLoaded(slice) && !slice.diffLoading;
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
          onToggle={(sha) => void toggleCommit(tabId, sha)}
          onClear={() => clearCommits(tabId)}
        />
        {commitCount > 0 ? (
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
                {commitCount > 1 ? `${commitCount} commits · ` : ""}
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
              {commitCount > 1
                ? `These ${commitCount} commits are reviewed together as one combined change.`
                : "Only this commit's own change is reviewed."}{" "}
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
                title="Model for this review. Pinning scopes only to this tab."
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/50 bg-card/60 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/[0.05]"
              >
                <ProviderIcon provider={provider} size={12} />
                <span className="max-w-[150px] truncate">{label}</span>
                {slice.modelId ? (
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
                  onClick={() => void run(tabId)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-medium transition-colors",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                    !canRun && "cursor-not-allowed opacity-50",
                  )}
                >
                  <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
                  {hasRun
                    ? "Re-run"
                    : commitCount > 1
                      ? "Review commits"
                      : "Review commit"}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
                {!canRun
                  ? "Select at least one commit and wait for its diff to load."
                  : hasRun
                    ? "Re-analyze from scratch."
                    : commitCount > 1
                      ? `Analyze these ${commitCount} commits together for bugs and regressions.`
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
          {commitCount > 1 ? "Some selected commits aren't" : "This commit isn't"}{" "}
          your latest
          {headSha ? (
            <>
              {" "}
              (working tree at <span className="font-mono">{headSha}</span>)
            </>
          ) : null}
          . Surrounding code is read from the current tree, which may differ from{" "}
          {commitCount > 1 ? "those commits'" : "this commit's"} state.
        </Banner>
      ) : null}
      {slice.diffError ? (
        <Banner tone="warn">{slice.diffError}</Banner>
      ) : null}
      {combinedDiffTooLarge ? (
        <Banner tone="warn">
          These {commitCount} commits add up to a large combined diff (~
          {Math.round(combinedDiffBytes / 1024)} KB). They're reviewed as one
          change, so a selection this big can exhaust the model's context or step
          budget and yield thinner findings — consider reviewing fewer commits at
          a time.
        </Banner>
      ) : null}
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
          onRun={() => void run(tabId)}
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
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-8 text-center">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          size={22}
          strokeWidth={1.75}
          className="text-emerald-600 dark:text-emerald-400"
        />
        <p className="text-[12.5px] font-medium text-foreground">
          {doneDiffs.length > 1
            ? `No issues found across these ${doneDiffs.length} commits.`
            : "No issues found in this commit's changes."}
        </p>
        <p className="max-w-sm text-[11.5px] leading-snug text-muted-foreground">
          {doneDiffs.length === 1 ? (
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-border/55 bg-card/30 p-8 text-center">
      <HugeiconsIcon
        icon={SparklesIcon}
        size={20}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      <p className="text-[12.5px] font-medium text-foreground">
        Review one or more commits for bugs
      </p>
      <p className="max-w-md text-[11.5px] leading-snug text-muted-foreground">
        Pick one or more commits and press{" "}
        <span className="font-medium text-foreground">Review</span>. The reviewer
        reads only the selected commits' changes, then investigates their blast
        radius across your code — surfacing bugs by severity with one-click fixes.
        Select several commits (e.g. a feature split across commits) to review
        them together. Add context (the ticket you're fixing) to also check the
        change does what was asked.
      </p>
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
  onToggle,
  onClear,
}: {
  commits: CommitMeta[];
  selected: string[];
  loading: boolean;
  /** Locked while a review is running so the reviewed set can't change mid-run. */
  disabled?: boolean;
  onToggle: (sha: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const headSha = commits[0]?.sha;
  // When exactly one is selected, show it inline; otherwise show a count.
  const onlyCommit =
    selected.length === 1
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
            icon={loading ? Loading03Icon : GitBranchIcon}
            size={12}
            strokeWidth={1.75}
            className={cn("shrink-0 text-muted-foreground", loading && "animate-spin")}
          />
          {onlyCommit ? (
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
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                No commits match.
              </div>
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
              <span>
                {selected.length} commit{selected.length === 1 ? "" : "s"} selected
              </span>
              <button
                type="button"
                onClick={onClear}
                className="rounded-sm px-1.5 py-px font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
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
