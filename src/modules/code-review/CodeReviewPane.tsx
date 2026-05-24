import { BranchPicker } from "@/components/BranchPicker";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Textarea } from "@/components/ui/textarea";
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
  BubbleChatIcon,
  Copy01Icon,
  GitBranchIcon,
  InformationCircleIcon,
  RefreshIcon,
  SentIcon,
  StopCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCodeReview } from "./useCodeReview";

const DEFAULT_FIRST_PROMPT =
  "Please review my changes — flag blockers, suggestions, and nits with file:line citations.";

type Props = {
  tabId: number;
  cwd: string;
  base: string | null;
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
  rehydrateThreadId,
}: Props) {
  const ensure = useCodeReview((s) => s.ensure);
  const refreshDiff = useCodeReview((s) => s.refreshDiff);
  const changeBase = useCodeReview((s) => s.changeBase);
  const send = useCodeReview((s) => s.send);
  const stop = useCodeReview((s) => s.stop);
  const clear = useCodeReview((s) => s.clear);
  const slice = useCodeReview((s) => s.byTab.get(tabId));
  const renameTab = useTabsStore((s) => s.renameTab);

  // Live branch info from the status bar — same source of truth, so when
  // the user checks out a different branch in their terminal we react.
  // Without this, the pane's "HEAD" would freeze at whatever was current
  // when the tab was opened, which has caused real confusion.
  const liveGit = useSourceDirGitInfo();

  const [branches, setBranches] = useState<string[]>([]);
  const [draft, setDraft] = useState(DEFAULT_FIRST_PROMPT);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    void ensure(tabId, cwd, base, rehydrateThreadId ?? null);
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
    if (!text || busy) return;
    void send(tabId, text);
    setDraft("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <BranchPicker
                value={slice?.base ?? base ?? "main"}
                branches={baseList}
                onChange={(v) => void changeBase(tabId, v)}
                disabled={busy}
                ariaLabel="Base branch"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Base branch — the diff shows everything that's on your current
            branch but not on this one. Changing it wipes the conversation
            (different baseline = different review). Type to filter the
            list.
          </TooltipContent>
        </Tooltip>

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
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                streaming={busy && i === messages.length - 1}
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

      {/* Composer ------------------------------------------------------ */}
      <div className="shrink-0 border-t border-border/50 bg-card/30 px-3 py-2.5">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              messages.length === 0
                ? "Tweak the prompt or press Ctrl/Cmd+Enter to send…"
                : "Follow up — ask the reviewer to dig deeper, expand a finding, etc."
            }
            disabled={!diff && !diffLoading}
            rows={messages.length === 0 ? 3 : 2}
            className="min-h-0 resize-none text-[12px] leading-relaxed"
          />
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stop(tabId)}
                  className="h-8 shrink-0 gap-1"
                >
                  <HugeiconsIcon
                    icon={StopCircleIcon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  Stop
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] text-[11px]">
                Cancel the in-flight review. The partial answer stays visible
                — useful when the model has already said what you needed.
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={!draft.trim() || !diff}
                  className="h-8 shrink-0 gap-1"
                >
                  <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={1.75} />
                  Send
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] text-[11px]">
                Send this prompt to your default model with the diff as
                context. Ctrl/Cmd+Enter sends from the textarea too.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  base,
  head,
  fileCount,
}: {
  base: string;
  head: string | null;
  fileCount: number;
}) {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
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
            citations.
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
      <p className="text-[10.5px] text-muted-foreground/70">
        Tip: <kbd className="rounded border border-border/60 bg-card px-1 font-mono text-[10px]">Ctrl/Cmd+Enter</kbd>{" "}
        sends the prompt below.
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
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
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
      <div className="flex justify-end">
        <div className="group/msg relative max-w-[80%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[12px] leading-[1.55] text-foreground">
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border/60 bg-card/80 text-foreground/70">
        <HugeiconsIcon icon={BubbleChatIcon} size={11} strokeWidth={1.75} />
      </div>
      <div className="group/msg relative min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border/45 bg-card/55 px-3.5 py-2.5">
        {content ? (
          <ChatMarkdown source={content} streaming={streaming} />
        ) : streaming ? (
          <StreamingDots />
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

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 py-1">
      <span className="size-1.5 animate-pulse rounded-full bg-foreground/40" />
      <span
        className="size-1.5 animate-pulse rounded-full bg-foreground/40"
        style={{ animationDelay: "120ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-foreground/40"
        style={{ animationDelay: "240ms" }}
      />
    </span>
  );
}
