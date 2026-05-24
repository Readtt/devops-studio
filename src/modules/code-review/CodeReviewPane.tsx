import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  ArrowDown01Icon,
  RefreshIcon,
  SentIcon,
  StopCircleIcon,
  GitBranchIcon,
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
};

export function CodeReviewPane({ tabId, cwd, base }: Props) {
  const ensure = useCodeReview((s) => s.ensure);
  const refreshDiff = useCodeReview((s) => s.refreshDiff);
  const changeBase = useCodeReview((s) => s.changeBase);
  const send = useCodeReview((s) => s.send);
  const stop = useCodeReview((s) => s.stop);
  const clear = useCodeReview((s) => s.clear);
  const slice = useCodeReview((s) => s.byTab.get(tabId));
  const renameTab = useTabsStore((s) => s.renameTab);

  const [branches, setBranches] = useState<string[]>([]);
  const [draft, setDraft] = useState(DEFAULT_FIRST_PROMPT);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    void ensure(tabId, cwd, base);
    // Branch list loads lazily — failures here are non-fatal because the
    // Rust diff command has its own fallback chain.
    invoke<string[]>("git_branch_list", { cwd })
      .then(setBranches)
      .catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd]);

  // Auto-rename the tab once the diff resolves so the tab strip carries
  // useful context ("Review · main → feat/x") instead of bare "Code review".
  useEffect(() => {
    if (!slice?.diff) return;
    const name = `Review · ${slice.diff.base} → ${slice.diff.head}`;
    renameTab(tabId, name);
  }, [slice?.diff, tabId, renameTab]);

  // Auto-scroll to bottom when new content streams in — unless the user has
  // scrolled up to read history, in which case we stay put and show a
  // "Jump to latest" affordance.
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
    // Reset to the empty draft after the first send. Subsequent turns
    // start blank so the user types their follow-up fresh.
    setDraft("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter → Send. Plain Enter inserts a newline so users can
    // compose multi-line follow-ups (paste a stack trace etc).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const baseList = useMemo(() => {
    // Promote the current base + the detected fallbacks even when they
    // aren't in `branches` (shouldn't happen but defensive).
    const set = new Set<string>(branches);
    if (slice?.base) set.add(slice.base);
    for (const fallback of ["main", "master"]) set.add(fallback);
    return Array.from(set);
  }, [branches, slice?.base]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header ------------------------------------------------------- */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-card/40 px-3">
        <HugeiconsIcon
          icon={GitBranchIcon}
          size={13}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        <Select
          value={slice?.base ?? base ?? "main"}
          onValueChange={(v) => void changeBase(tabId, v)}
          disabled={busy}
        >
          <SelectTrigger
            className="h-6 w-auto min-w-32 gap-1 border-transparent bg-transparent px-1.5 text-[11.5px] hover:bg-foreground/[0.04]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {baseList.map((b) => (
              <SelectItem key={b} value={b} className="text-[12px]">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-muted-foreground">→</span>
        <span className="font-mono text-[11.5px] text-foreground/85">
          {diff?.head ?? "…"}
        </span>
        {totals ? (
          <span className="text-[11px] text-muted-foreground">
            · {totals.count} file{totals.count === 1 ? "" : "s"}{" "}
            <span className="text-emerald-600 dark:text-emerald-400">
              +{totals.adds}
            </span>{" "}
            <span className="text-rose-600 dark:text-rose-400">
              −{totals.dels}
            </span>
          </span>
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
            <TooltipContent side="bottom" className="text-[11px]">
              Re-read the diff from disk
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
              <TooltipContent side="bottom" className="text-[11px]">
                Drop the conversation and start fresh against the same diff
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {/* Diff error banner -------------------------------------------- */}
      {diffError ? (
        <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/[0.06] px-3 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
          Couldn't load diff: {diffError}
        </div>
      ) : null}
      {diff?.truncated ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Diff truncated to fit. The model has the file list + Read/Grep tools
          to see the rest.
        </div>
      ) : null}

      {/* Messages ----------------------------------------------------- */}
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
            fileCount={totals?.count ?? 0}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                role={m.role}
                content={m.content}
                streaming={busy && m === messages[messages.length - 1]}
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

      {/* Composer ----------------------------------------------------- */}
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
          ) : (
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!draft.trim() || !diff}
              className="h-8 shrink-0 gap-1"
            >
              <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={1.75} />
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ base, fileCount }: { base: string; fileCount: number }) {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-12 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-foreground/[0.04] text-muted-foreground">
        <HugeiconsIcon icon={GitBranchIcon} size={16} strokeWidth={1.5} />
      </div>
      <h2 className="text-[13px] font-medium">Code review</h2>
      <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
        {fileCount > 0 ? (
          <>
            Diffing <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">{base}</code> against your current branch — {fileCount} file{fileCount === 1 ? "" : "s"} changed.
            Edit the prompt below if you want, then press <kbd className="rounded border border-border/60 bg-card px-1 font-mono text-[10px]">Ctrl/Cmd+Enter</kbd> to send.
          </>
        ) : (
          <>
            {sourceRoot
              ? "No changes detected yet vs the base branch — commit something or change the base picker above."
              : "No source directory set. Open Settings → General to point DevOps Studio at your repo first."}
          </>
        )}
      </p>
    </div>
  );
}

function MessageRow({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[12px] leading-[1.55] text-foreground">
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border/60 bg-card/80 text-foreground/70">
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          R
        </span>
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border/45 bg-card/55 px-3.5 py-2.5">
        {content ? (
          <ChatMarkdown source={content} streaming={streaming} />
        ) : streaming ? (
          <StreamingDots />
        ) : (
          <p className="text-[11.5px] italic text-muted-foreground">
            (empty response)
          </p>
        )}
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
