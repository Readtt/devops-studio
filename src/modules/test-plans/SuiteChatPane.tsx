import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { adoErrorMessage } from "@/modules/ado";
import { MODELS, type ModelId } from "@/modules/ai/config";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  Copy01Icon,
  FolderIcon,
  GitBranchIcon,
  MessageAdd01Icon,
  RefreshIcon,
  SentIcon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useSuiteChat } from "./hooks/useSuiteChat";

type Props = {
  planId: number;
  suiteId: number;
};

const SUGGESTED_PROMPTS_WITH_SOURCE = [
  "Are there gaps in coverage for the auth flow?",
  "Which cases are too vague to actually run?",
  "Look at the login code — do my cases match how it returns errors?",
  "If I asked whether these pass, what would you need to know?",
];

const SUGGESTED_PROMPTS_NO_SOURCE = [
  "Are there gaps in coverage for the auth flow?",
  "Which cases are too vague to actually run?",
  "What edge cases am I missing for invalid input?",
  "If I asked whether these pass, what would you need to know?",
];

export function SuiteChatPane({ planId, suiteId }: Props) {
  const state = useSuiteChat((s) => s.byKey.get(`${planId}:${suiteId}`));
  const ensure = useSuiteChat((s) => s.ensure);
  const loadCases = useSuiteChat((s) => s.loadCases);
  const sendMessage = useSuiteChat((s) => s.sendMessage);
  const cancel = useSuiteChat((s) => s.cancel);
  const clearMessages = useSuiteChat((s) => s.clearMessages);
  const dismissError = useSuiteChat((s) => s.dismissError);
  const setModel = useSuiteChat((s) => s.setModel);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const globalModelId = useChatStore((s) => s.selectedModelId);
  const availability = useModelAvailability();

  const [draft, setDraft] = useState("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ensure(planId, suiteId);
    void loadCases(planId, suiteId);
  }, [planId, suiteId, ensure, loadCases]);

  // Auto-grow the composer to fit content, capped so a long paragraph
  // doesn't push the thread off-screen. The cap matches the visual rhythm
  // of the pane — past ~6 lines you really should be using a longer
  // explanation in two messages.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  // Auto-stick to the bottom when the user is already near the bottom, but
  // pause auto-scroll when they've scrolled up to read older messages —
  // surfacing a "Jump to latest" pill instead so the streaming text doesn't
  // yank them away from what they were reading.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 96) {
      el.scrollTop = el.scrollHeight;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [state?.messages, state?.busy]);

  // Track scroll position so the "Jump to latest" pill disappears once the
  // user scrolls back down on their own.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpToLatest(dist > 96);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  if (!state) {
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const {
    cases,
    casesLoading,
    casesError,
    totalCases,
    truncated,
    suiteName,
    suitePath,
    messages,
    busy,
    error,
    modelId,
  } = state;

  const activeModelId = modelId ?? globalModelId;
  const activeModel = MODELS.find((m) => m.id === activeModelId);
  const sourceLabel = sourceRoot
    ? sourceRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] || sourceRoot
    : null;
  const titleParts = [...suitePath, suiteName ?? `#${suiteId}`];

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !cases) return;
    void sendMessage(planId, suiteId, text);
    setDraft("");
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Header ---------------------------------------------------------- */}
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 bg-card/30 px-5 py-3 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <HugeiconsIcon
                icon={AiBrain01Icon}
                size={11}
                strokeWidth={1.75}
                className="text-primary"
              />
              <span className="font-mono uppercase tracking-wider">
                suite chat
              </span>
            </div>
            <h1 className="mt-0.5 flex items-baseline gap-1.5 text-[15px] font-semibold tracking-tight">
              <HugeiconsIcon
                icon={FolderIcon}
                size={13}
                strokeWidth={1.75}
                className="translate-y-0.5 shrink-0 text-foreground/70"
              />
              <span className="min-w-0 truncate">
                {titleParts.map((p, i) => (
                  <span key={i}>
                    {i > 0 ? (
                      <span className="mx-1.5 text-muted-foreground/40">›</span>
                    ) : null}
                    <span
                      className={
                        i === titleParts.length - 1 ? "" : "text-muted-foreground"
                      }
                    >
                      {p}
                    </span>
                  </span>
                ))}
              </span>
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ModelPicker
              value={activeModelId}
              onChange={(id) => setModel(planId, suiteId, id)}
              filter={(id) => availability.isAvailable(id)}
              align="end"
              side="bottom"
              trigger={({ label, provider }) => (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-7 max-w-[180px] items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/60 px-2 text-[11px] text-foreground/85 hover:bg-foreground/[0.04]"
                    >
                      <ProviderIcon provider={provider} className="size-3" />
                      <span className="truncate">{label}</span>
                      {modelId ? (
                        <span className="ml-0.5 rounded-sm bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
                          pin
                        </span>
                      ) : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    {modelId
                      ? `Model pinned for this chat. Click to change or unset.`
                      : `Inherits the global model (${activeModel?.label ?? activeModelId}). Click to pin a different model for this chat only.`}
                  </TooltipContent>
                </Tooltip>
              )}
              footer={
                modelId ? (
                  <button
                    type="button"
                    onClick={() => setModel(planId, suiteId, null as unknown as ModelId)}
                    className="w-full px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-foreground/[0.04]"
                  >
                    Unpin — inherit global default
                  </button>
                ) : undefined
              }
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="New thread"
                  onClick={() => clearMessages(planId, suiteId)}
                  disabled={messages.length === 0 || busy}
                >
                  <HugeiconsIcon
                    icon={MessageAdd01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Start a new thread (drops the current conversation; cases stay loaded)
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Reload cases"
                  onClick={() => void loadCases(planId, suiteId, true)}
                  disabled={casesLoading}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    size={12}
                    strokeWidth={1.75}
                    className={casesLoading ? "animate-spin" : ""}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Re-fetch every case in this suite from Azure DevOps
              </TooltipContent>
            </Tooltip>
            {!sourceRoot ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open settings"
                    onClick={() => void openSettingsWindow("general")}
                  >
                    <HugeiconsIcon
                      icon={Settings01Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[11px]">
                  Pick a source directory to enable code-grounded answers
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1">
                {casesLoading ? (
                  "Loading cases…"
                ) : cases ? (
                  <>
                    <span className="font-medium text-foreground/85">
                      {cases.length}
                    </span>{" "}
                    case{cases.length === 1 ? "" : "s"}
                    {truncated ? (
                      <span className="text-amber-700 dark:text-amber-300">
                        {" "}
                        of {totalCases}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {truncated
                ? `Loaded the first ${cases?.length ?? 0} of ${totalCases} cases — suite-wide questions may miss content beyond this window.`
                : `Number of cases currently fed into the chat as context.`}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  sourceLabel
                    ? "text-foreground/85"
                    : "text-amber-700 dark:text-amber-300",
                )}
              >
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={10}
                  strokeWidth={1.75}
                />
                {sourceLabel ? (
                  <>
                    source:{" "}
                    <span className="font-mono">{sourceLabel}</span>
                  </>
                ) : (
                  "no source dir"
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {sourceLabel
                ? `Read/Glob/Grep available against this directory — the model can verify cases against actual code.`
                : `Pick a source dir in Preferences to let the model verify cases against real code.`}
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* Optional advisory banners --------------------------------------- */}
      {truncated ? (
        <div className="shrink-0 border-b border-border/40 bg-foreground/[0.03] px-5 py-1.5 text-[10.5px] text-muted-foreground">
          Showing the first {cases?.length ?? 0} of {totalCases} cases.
          Suite-wide questions may miss content outside this window — narrow
          to specific case ids when accuracy matters.
        </div>
      ) : null}
      {casesError ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/[0.06] px-5 py-2 text-[11px] text-destructive">
          Couldn&apos;t load cases: {adoErrorMessage(casesError)}
        </div>
      ) : null}

      {/* Thread ----------------------------------------------------------- */}
      <div ref={threadRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-5">
          {casesLoading && !cases ? (
            <CaseLoadingShimmer />
          ) : cases && cases.length === 0 ? (
            <EmptySuiteHint suiteName={suiteName} />
          ) : messages.length === 0 ? (
            <Onboarding
              hasCases={cases !== null && cases.length > 0}
              hasSource={!!sourceRoot}
              onPick={(p) => setDraft(p)}
            />
          ) : null}

          {messages.map((m, idx) => (
            <MessageBubble
              key={m.id}
              role={m.role}
              content={m.content}
              streaming={busy && m.role === "assistant" && idx === messages.length - 1}
            />
          ))}
        </div>

        {/* Floating jump-to-latest pill ----------------------------------- */}
        {showJumpToLatest ? (
          <button
            type="button"
            onClick={() => {
              const el = threadRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="pointer-events-auto absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-card/95 px-3 py-1 text-[11px] font-medium text-foreground shadow-lg backdrop-blur-sm hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={11}
              strokeWidth={1.75}
            />
            Jump to latest
          </button>
        ) : null}
      </div>

      {/* Error banner --------------------------------------------------- */}
      {error ? (
        <div className="flex items-start gap-1.5 border-t border-destructive/30 bg-destructive/[0.06] px-5 py-1.5 text-[11px] text-destructive">
          <span className="flex-1">{error}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => dismissError(planId, suiteId)}
                className="text-[10.5px] underline-offset-2 hover:underline"
              >
                dismiss
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Hide this error banner
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {/* Composer ------------------------------------------------------- */}
      <div className="shrink-0 border-t border-border/40 bg-card/40 px-5 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="group relative flex items-end gap-2 rounded-lg border border-border/60 bg-input/40 px-3 py-2 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              disabled={casesLoading || !cases}
              placeholder={
                cases
                  ? "Ask about these cases…  (Enter to send · Shift+Enter for newline)"
                  : "Loading cases…"
              }
              className="min-h-[28px] w-full resize-none bg-transparent text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/55"
            />
            {busy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Cancel response"
                    onClick={() => cancel(planId, suiteId)}
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
                  Stop the response in flight
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    aria-label="Send message"
                    onClick={submit}
                    disabled={!draft.trim() || !cases}
                    className={cn(
                      "shrink-0 transition-transform",
                      draft.trim() && cases ? "scale-100" : "scale-95",
                    )}
                  >
                    <HugeiconsIcon
                      icon={SentIcon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  Send · Enter
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const meta = useMemo(() => {
    const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
    return wordCount;
  }, [content]);

  return (
    <div
      className={cn(
        "flex",
        role === "user" ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "group/msg relative max-w-[88%] overflow-hidden rounded-lg text-[12px] leading-relaxed",
          role === "user"
            ? "bg-primary/12 text-foreground"
            : "border border-border/40 bg-card/60 text-foreground/90",
        )}
      >
        <div className="px-3 py-2">
          {role === "user" ? (
            <p className="whitespace-pre-wrap break-words">{content}</p>
          ) : content ? (
            <ChatMarkdown source={content} />
          ) : streaming ? (
            <StreamingPlaceholder />
          ) : null}
          {role === "assistant" && content && streaming ? (
            <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary/80" />
          ) : null}
        </div>
        {/* Per-message action rail — copy + (future) apply edit. Only
            shows for assistant messages, slides in on hover. */}
        {role === "assistant" && content && !streaming ? (
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
                {copied ? "Copied" : `Copy message (${meta} words)`}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StreamingPlaceholder() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      Thinking…
    </span>
  );
}

function CaseLoadingShimmer() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

function EmptySuiteHint({ suiteName }: { suiteName: string | null }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-4 py-4 text-[12px] leading-relaxed text-muted-foreground">
      No cases in{" "}
      <span className="font-medium text-foreground/90">
        {suiteName ?? "this suite"}
      </span>{" "}
      yet — generate some from the suite&apos;s context menu, then come back
      here to chat about them.
    </div>
  );
}

function Onboarding({
  hasCases,
  hasSource,
  onPick,
}: {
  hasCases: boolean;
  hasSource: boolean;
  onPick: (prompt: string) => void;
}) {
  if (!hasCases) return null;
  const prompts = hasSource
    ? SUGGESTED_PROMPTS_WITH_SOURCE
    : SUGGESTED_PROMPTS_NO_SOURCE;
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 px-4 py-4">
      <p className="text-[13px] font-medium text-foreground/90">
        Ask the analyst about this suite.
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        The full case list is in scope.
        {hasSource
          ? " Source directory is set — answers can reference real code via Read/Glob/Grep."
          : " No source dir yet — answers will be limited to case-definition review."}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {prompts.map((p) => (
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
    </div>
  );
}
