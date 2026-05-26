import { BranchPicker } from "@/components/BranchPicker";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  AttachButton,
  AttachmentDropZone,
  AttachmentList,
  useAttachments,
  type Attachment,
} from "@/components/chat/attachments";
import { Kbd } from "@/components/ui/kbd";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import {
  MentionDropdown,
  WorkItemChips,
  useWorkItemMention,
  type WorkItemMention,
} from "@/modules/ado/components/WorkItemMention";
import { useBugContext } from "@/modules/ado/hooks/useBugContext";
import { getModel } from "@/modules/ai/config";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSourceDirGitInfo } from "@/modules/git/useSourceDirGitInfo";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  ArrowDown01Icon,
  ArrowTurnUpIcon,
  BubbleChatIcon,
  Cancel01Icon,
  Copy01Icon,
  GitBranchIcon,
  InformationCircleIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCodeReview } from "./useCodeReview";
import { CodeReviewSourcePicker } from "./CodeReviewSourcePicker";

const DEFAULT_FIRST_PROMPT =
  "Please review my changes — flag blockers, suggestions, and nits with file:line citations.";

type Props = {
  tabId: number;
  cwd: string;
  base: string | null;
  /** Persisted ADO source for this tab (commit/PR/branch). Null/absent ⇒
   *  the local working-copy diff. Survives reload + Duplicate via the tab. */
  source?: import("./source").CodeReviewSource | null;
  /** When set, useCodeReview.ensure() will preload the matching history
   *  thread on mount. The diff is still re-read from disk (we don't
   *  persist diffs across sessions), so the conversation may reference
   *  lines that have since moved — the model is told that explicitly. */
  rehydrateThreadId?: string | null;
};

export function CodeReviewPane({
  tabId,
  cwd,
  base,
  source,
  rehydrateThreadId,
}: Props) {
  const ensure = useCodeReview((s) => s.ensure);
  const refreshDiff = useCodeReview((s) => s.refreshDiff);
  const changeBase = useCodeReview((s) => s.changeBase);
  const setModel = useCodeReview((s) => s.setModel);
  const setSource = useCodeReview((s) => s.setSource);
  const send = useCodeReview((s) => s.send);
  const stop = useCodeReview((s) => s.stop);
  const clear = useCodeReview((s) => s.clear);
  const slice = useCodeReview((s) => s.byTab.get(tabId));
  const renameTab = useTabsStore((s) => s.renameTab);
  const globalModelId = usePreferencesStore((s) => s.defaultModelId);
  const pinnedModelId = slice?.modelId ?? null;
  const activeModelId = pinnedModelId ?? globalModelId;
  const activeModel = getModel(activeModelId);
  const availability = useModelAvailability();

  // Live branch info from the status bar — same source of truth, so when
  // the user checks out a different branch in their terminal we react.
  // Without this, the pane's "HEAD" would freeze at whatever was current
  // when the tab was opened, which has caused real confusion.
  const liveGit = useSourceDirGitInfo();

  const [branches, setBranches] = useState<string[]>([]);
  const [draft, setDraft] = useState(DEFAULT_FIRST_PROMPT);
  const att = useAttachments();
  const bugCtx = useBugContext();
  const mention = useWorkItemMention({
    value: draft,
    onValueChange: setDraft,
    onAdd: bugCtx.add,
    selectedIds: bugCtx.selected.map((b) => b.id),
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    void ensure(tabId, cwd, base, rehydrateThreadId ?? null, source ?? null);
    invoke<string[]>("git_branch_list", { cwd })
      .then(setBranches)
      .catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd]);

  // When the live current branch changes (user `git checkout`'d elsewhere),
  // refresh the diff so HEAD + the per-file list track reality. We don't
  // wipe the message history — the conversation may still be useful for
  // follow-up questions about the prior diff. If the user wants a fresh
  // thread, the Clear button is one click away.
  const lastSeenBranchRef = useRef<string | null>(slice?.diff?.head ?? null);
  useEffect(() => {
    if (!slice?.diff) return;
    const branch = liveGit.branch ?? liveGit.commit ?? null;
    if (!branch) return;
    if (branch === lastSeenBranchRef.current) return;
    if (branch === slice.diff.head) {
      lastSeenBranchRef.current = branch;
      return;
    }
    lastSeenBranchRef.current = branch;
    void refreshDiff(tabId);
  }, [liveGit.branch, liveGit.commit, slice?.diff, refreshDiff, tabId]);

  // Auto-rename the tab once the diff resolves so the tab strip carries
  // useful context.
  useEffect(() => {
    if (!slice?.diff) return;
    const name = `Review · ${slice.diff.base} → ${slice.diff.head}`;
    renameTab(tabId, name);
  }, [slice?.diff, tabId, renameTab]);

  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [slice?.messages, atBottom]);

  const messages = slice?.messages ?? [];
  const busy = slice?.busy ?? false;
  const diff = slice?.diff ?? null;
  const diffLoading = slice?.diffLoading ?? false;
  const diffError = slice?.diffError ?? null;
  const error = slice?.error ?? null;

  const totals = useMemo(() => {
    if (!diff) return null;
    const adds = diff.files.reduce((s, f) => s + f.additions, 0);
    const dels = diff.files.reduce((s, f) => s + f.deletions, 0);
    return { adds, dels, count: diff.files.length };
  }, [diff]);

  const handleSend = () => {
    const text = draft.trim();
    if ((!text && att.attachments.length === 0) || busy) return;
    void send(
      tabId,
      text,
      att.attachments,
      bugCtx.selected.map((b) => b.id),
    );
    setDraft("");
    att.clear();
    bugCtx.clear();
    mention.dismiss();
  };

  const baseList = useMemo(() => {
    const set = new Set<string>(branches);
    if (slice?.base) set.add(slice.base);
    for (const fallback of ["main", "master"]) set.add(fallback);
    return Array.from(set);
  }, [branches, slice?.base]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header — every control gets a tooltip so users new to this feature
          can hover anything and read what it does. */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-card/40 px-3">
        <CodeReviewSourcePicker
          source={slice?.source ?? null}
          onChange={(s) => void setSource(tabId, s)}
          disabled={busy}
        />
        {!slice?.source ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <BranchPicker
                  value={slice?.base ?? base ?? ""}
                  placeholder={diffLoading ? "Detecting base…" : "Select base"}
                  branches={baseList}
                  onChange={(v) => void changeBase(tabId, v)}
                  disabled={busy}
                  ariaLabel="Base branch"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
              Base branch — the diff shows everything that's on your current
              branch but not on this one. Defaults to whatever git finds
              first: main → master → origin/HEAD. Changing it wipes the
              conversation (different baseline = different review). Type to
              filter the list.
            </TooltipContent>
          </Tooltip>
        ) : null}

        <span className="text-[11px] text-muted-foreground">→</span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-[11.5px] text-foreground/85">
              {diff?.head ?? liveGit.branch ?? "…"}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Your current branch (matches the one shown in the bottom status
            bar). Checkout a different branch and this auto-refreshes.
          </TooltipContent>
        </Tooltip>

        {totals ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[11px] text-muted-foreground">
                · {totals.count} file{totals.count === 1 ? "" : "s"}{" "}
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{totals.adds}
                </span>{" "}
                <span className="text-rose-600 dark:text-rose-400">
                  −{totals.dels}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-[320px] text-[11px] leading-relaxed"
            >
              {totals.count} file{totals.count === 1 ? "" : "s"} changed —{" "}
              {totals.adds} line{totals.adds === 1 ? "" : "s"} added,{" "}
              {totals.dels} removed. The diff is fed to the reviewer model
              along with Read/Glob/Grep tools so it can dig into context
              outside the changed lines.
            </TooltipContent>
          </Tooltip>
        ) : diffLoading ? (
          <span className="text-[11px] text-muted-foreground">
            · loading diff…
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {/* Model picker — matches SuiteChatPane: chip that shows the
              active model, click to choose another. Pinning here only
              scopes to this tab; "Unpin" footer returns to the global
              default. */}
          <ModelPicker
            value={activeModelId}
            onChange={(id) => setModel(tabId, id)}
            filter={(id) => availability.isAvailable(id)}
            align="end"
            side="bottom"
            trigger={({ label, provider }) => (
              <span
                title={
                  pinnedModelId
                    ? "Model pinned for this review — click to change or unset."
                    : `Inherits the global model (${activeModel?.label ?? activeModelId}). Click to pin a different model for this review only.`
                }
                className="inline-flex h-6 max-w-[160px] items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/60 px-2 text-[11px] text-foreground/85 hover:bg-foreground/[0.04]"
              >
                <ProviderIcon provider={provider} className="size-3" />
                <span className="truncate">{label}</span>
                {pinnedModelId ? (
                  <span className="ml-0.5 rounded-sm bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
                    pin
                  </span>
                ) : null}
              </span>
            )}
            footer={
              pinnedModelId ? (
                <button
                  type="button"
                  onClick={() => setModel(tabId, null)}
                  className="w-full px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-foreground/[0.04]"
                >
                  Unpin — inherit global default
                </button>
              ) : undefined
            }
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void refreshDiff(tabId)}
                disabled={busy || diffLoading}
                aria-label="Refresh diff"
                className={cn(
                  "grid h-6 w-6 cursor-pointer place-items-center rounded-md",
                  "text-muted-foreground transition-colors",
                  "hover:bg-foreground/[0.06] hover:text-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.75}
                  className={diffLoading ? "animate-spin" : ""}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
              Re-read the diff from disk. Use this after you commit new
              changes or check out a different branch and want the reviewer
              to see the latest state.
            </TooltipContent>
          </Tooltip>
          {messages.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => clear(tabId)}
                  disabled={busy}
                  className={cn(
                    "rounded-md px-2 text-[11px] text-muted-foreground transition-colors",
                    "hover:bg-foreground/[0.06] hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  Clear
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
                Discard this conversation and start a fresh review against
                the same diff. The diff itself isn't cleared.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {/* Status banners ------------------------------------------------ */}
      {diffError ? (
        <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/[0.06] px-3 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
          Couldn't load diff: {diffError}
        </div>
      ) : null}
      {diff?.truncated ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <HugeiconsIcon
            icon={InformationCircleIcon}
            size={12}
            strokeWidth={1.75}
          />
          Diff truncated to fit. The model still sees the full file list and
          can read whatever it needs via its Read/Grep tools.
        </div>
      ) : null}

      {/* Messages ------------------------------------------------------ */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (near !== atBottom) setAtBottom(near);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 ? (
          <EmptyState
            base={slice?.base ?? base ?? "main"}
            head={diff?.head ?? liveGit.branch ?? null}
            fileCount={totals?.count ?? 0}
            onPick={(prompt) => setDraft(prompt)}
            canPick={!!diff}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                attachments={m.attachments}
                streaming={busy && i === messages.length - 1}
                assistantProvider={activeModel.provider}
              />
            ))}
            {error ? (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-[11.5px] text-rose-700 dark:text-rose-300">
                {error}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!atBottom && messages.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setAtBottom(true);
          }}
          className={cn(
            "pointer-events-auto mx-auto mb-2 flex h-6 items-center gap-1 rounded-full",
            "border border-border/60 bg-card/95 px-2.5 text-[10.5px] text-foreground/85 shadow-sm",
            "hover:bg-card hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={1.75} />
          {busy ? "Streaming · jump to latest" : "Jump to latest"}
        </button>
      ) : null}

      {/* Composer — mirrors SuiteChatPane's chat composer so the two
          surfaces feel like one tool. Single rounded textarea with the
          send/cancel button inset on the right, Enter to send, Shift+Enter
          for newline, autosizing up to 180px. */}
      <ChatComposer
        draft={draft}
        onChange={setDraft}
        onSubmit={handleSend}
        onCancel={() => stop(tabId)}
        busy={busy}
        disabled={!diff && !diffLoading}
        hint={
          messages.length === 0
            ? "Review prompt — Enter to send · Shift+Enter for newline"
            : "Follow up on the review… (Enter to send · Shift+Enter for newline)"
        }
        attachments={att.attachments}
        attachmentErrors={att.errors}
        onPaste={att.onPaste}
        onDrop={att.onDrop}
        onFilePicker={att.onFilePicker}
        onRemoveAttachment={att.remove}
        onDismissAttachmentError={att.dismissError}
        mention={mention}
        bugChips={
          <WorkItemChips items={bugCtx.selected} onRemove={bugCtx.remove} />
        }
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chat-style composer — identical visual + interaction language to the
// SuiteChatPane composer. We intentionally keep this as a local copy
// rather than extracting a shared component yet: the two surfaces have
// diverged subtly before (model labels, attachment hooks) and a shared
// component would create coupling neither pane benefits from yet.
// ─────────────────────────────────────────────────────────────────────────

function ChatComposer({
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  disabled,
  hint,
  attachments,
  attachmentErrors,
  onPaste,
  onDrop,
  onFilePicker,
  onRemoveAttachment,
  onDismissAttachmentError,
  mention,
  bugChips,
}: {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled: boolean;
  hint: string;
  attachments: Attachment[];
  attachmentErrors: { id: string; message: string }[];
  onPaste: (e: React.ClipboardEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onFilePicker: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissAttachmentError: (id: string) => void;
  /** Inline `#id` work-item mention. */
  mention?: WorkItemMention;
  /** Attached work-item chips. */
  bugChips?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize: grow as the user types, capped at 180px so the composer
  // never eats the message list.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  return (
    <div className="shrink-0 border-t border-border/40 bg-card/40 px-5 py-3">
      <div className="mx-auto max-w-3xl">
        <AttachmentDropZone
          attachments={attachments}
          errors={attachmentErrors}
          remove={onRemoveAttachment}
          dismissError={onDismissAttachmentError}
          className="mb-2"
        />
        {bugChips ? <div className="mb-1.5">{bugChips}</div> : null}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            "group relative flex items-end gap-2 rounded-md border border-border/60 bg-input/40 px-2.5 py-1.5 transition-colors",
            "focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/25",
            busy && "border-primary/35 bg-primary/[0.03]",
          )}
        >
          {mention?.active ? <MentionDropdown mention={mention} /> : null}
          <AttachButton onFilePicker={onFilePicker} disabled={disabled} />
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              onChange(e.target.value);
              mention?.noteInput(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) =>
              mention?.noteCaret(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length,
              )
            }
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (mention?.onKeyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={hint}
            className="min-h-[20px] w-full resize-none bg-transparent py-1 text-[12px] leading-[1.55] outline-none placeholder:text-muted-foreground/55"
          />
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Cancel review"
                  onClick={onCancel}
                  className="shrink-0 text-destructive hover:bg-destructive/15"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Stop the review in flight
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  aria-label="Send"
                  onClick={onSubmit}
                  disabled={(!draft.trim() && attachments.length === 0) || disabled}
                  className="shrink-0"
                >
                  <HugeiconsIcon
                    icon={ArrowTurnUpIcon}
                    size={13}
                    strokeWidth={2}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Send · Enter
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-[10px] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd>
            send
          </span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⇧↵</Kbd>
            newline
          </span>
        </div>
      </div>
    </div>
  );
}

// Curated starter prompts the user can click to drop into the composer.
// Picked to cover the most common "I just want a quick second pair of
// eyes" asks for a branch — they read naturally as a user voice (not a
// system instruction) so the model treats them as the actual ask.
const SUGGESTED_PROMPTS = [
  "Review the diff — flag blockers, suggestions, and nits with file:line.",
  "What tests am I missing for this change?",
  "Are there security issues — injection, secrets, auth — in this diff?",
  "Suggest concrete patches I can apply to fix any blockers.",
];

function EmptyState({
  base,
  head,
  fileCount,
  onPick,
  canPick,
}: {
  base: string;
  head: string | null;
  fileCount: number;
  onPick: (prompt: string) => void;
  canPick: boolean;
}) {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-foreground/[0.04] text-muted-foreground">
        <HugeiconsIcon icon={GitBranchIcon} size={16} strokeWidth={1.5} />
      </div>
      <h2 className="text-[13px] font-medium">Code review</h2>
      <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
        Streamed review of your branch diff against{" "}
        <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
          {base}
        </code>
        {head ? (
          <>
            {" "}from{" "}
            <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
              {head}
            </code>
          </>
        ) : null}
        .
        {fileCount > 0 ? (
          <>
            {" "}{fileCount} file{fileCount === 1 ? "" : "s"} changed —{" "}
            findings come back grouped as <em>Blockers</em>, <em>Suggestions</em>,{" "}
            and <em>Nits</em> with clickable{" "}
            <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
              path:line
            </code>{" "}
            citations. Suggested fixes arrive as Apply cards you click to
            write straight to disk.
          </>
        ) : (
          <>
            {" "}{sourceRoot ? (
              <>No diff vs the base yet — commit something or pick a different
              base from the header.</>
            ) : (
              <>No source directory set. Open Settings → General to point
              DevOps Studio at your repo.</>
            )}
          </>
        )}
      </p>
      {/* Starter prompts mirror the chat tab's onboarding pills. They
          drop the text into the composer (not auto-send) so the user
          stays in control of when the diff is actually shipped to the
          model. Hidden until a diff has loaded — picking a prompt
          before then can't actually run anyway. */}
      {canPick ? (
        <div className="flex flex-wrap justify-center gap-1.5 px-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPick(p)}
              className="rounded-full border border-border/50 bg-background/60 px-2.5 py-1 text-[10.5px] text-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-[10.5px] text-muted-foreground/70">
        <kbd className="rounded border border-border/60 bg-card px-1 font-mono text-[10px]">Enter</kbd>{" "}
        sends · <kbd className="rounded border border-border/60 bg-card px-1 font-mono text-[10px]">Shift+Enter</kbd>{" "}
        adds a newline
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chat-style message bubbles, mirroring the SuiteChatPane treatment for
// design consistency: user messages right-aligned in a soft primary tint,
// assistant messages left-aligned with an avatar tile, copy-on-hover, and
// a streaming dot placeholder while text streams in.
// ─────────────────────────────────────────────────────────────────────────

function MessageBubble({
  role,
  content,
  attachments,
  streaming,
  assistantProvider,
}: {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  streaming: boolean;
  assistantProvider: import("@/modules/ai/config").ProviderId | null;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // ignore
    }
  };
  const wordCount = useMemo(
    () => (content.trim() ? content.trim().split(/\s+/).length : 0),
    [content],
  );

  if (role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {attachments && attachments.length > 0 ? (
          <AttachmentList
            attachments={attachments}
            className="max-w-[80%] justify-end"
          />
        ) : null}
        {content ? (
          <div className="group/msg relative max-w-[80%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[12px] leading-[1.55] text-foreground">
            <p className="whitespace-pre-wrap break-words">{content}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border/60 bg-card/80 text-foreground/70">
        {assistantProvider ? (
          <ProviderIcon provider={assistantProvider} size={11} />
        ) : (
          <HugeiconsIcon icon={BubbleChatIcon} size={11} strokeWidth={1.75} />
        )}
      </div>
      <div className="group/msg relative min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border/45 bg-card/55 px-3.5 py-2.5">
        {content ? (
          <ChatMarkdown source={content} streaming={streaming} />
        ) : streaming ? (
          <StreamingPlaceholder />
        ) : (
          <p className="text-[11.5px] italic text-muted-foreground">
            (empty response)
          </p>
        )}

        {!streaming && content ? (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onCopy}
                  aria-label="Copy message"
                  className={cn(
                    "grid size-5 place-items-center rounded-sm transition-colors",
                    copied
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={copied ? Tick02Icon : Copy01Icon}
                    size={10}
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                {copied ? "Copied" : `Copy reply (${wordCount} words)`}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Matches SuiteChatPane's placeholder: three pulsing primary-tinted dots
// staggered by 180ms, with a quiet "Reading the diff…" hint that names
// exactly what the reviewer is doing while the user waits.
function StreamingPlaceholder() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.18s]" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.36s]" />
      <span className="ml-1">Reading the diff…</span>
    </span>
  );
}
