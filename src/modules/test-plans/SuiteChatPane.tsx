import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { adoErrorMessage } from "@/modules/ado";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  FolderIcon,
  GitBranchIcon,
  RefreshIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { useSuiteChat } from "./hooks/useSuiteChat";

type Props = {
  planId: number;
  suiteId: number;
};

/**
 * Full-pane chat over an already-published test suite.
 *
 * Distinct from the generator's review chat: here the cases live in ADO,
 * the assistant gets file-system tool access (when a source dir is set),
 * and the user can ask "does the SSO case actually match the code?" with
 * concrete code-grounded answers instead of speculation.
 */
export function SuiteChatPane({ planId, suiteId }: Props) {
  const state = useSuiteChat((s) => s.byKey.get(`${planId}:${suiteId}`));
  const ensure = useSuiteChat((s) => s.ensure);
  const loadCases = useSuiteChat((s) => s.loadCases);
  const sendMessage = useSuiteChat((s) => s.sendMessage);
  const cancel = useSuiteChat((s) => s.cancel);
  const clearMessages = useSuiteChat((s) => s.clearMessages);
  const dismissError = useSuiteChat((s) => s.dismissError);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);

  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ensure(planId, suiteId);
    void loadCases(planId, suiteId);
  }, [planId, suiteId, ensure, loadCases]);

  // Auto-scroll on new messages / busy flip.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state?.messages, state?.busy]);

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
  } = state;

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
    <div className="flex h-full flex-col bg-background">
      {/* Header: identity + meta + actions ------------------------------- */}
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 bg-card/40 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
                  <span className={i === titleParts.length - 1 ? "" : "text-muted-foreground"}>
                    {p}
                  </span>
                </span>
              ))}
            </span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {casesLoading ? (
                <>Loading cases…</>
              ) : cases ? (
                <>
                  <span className="font-medium text-foreground/85">
                    {cases.length}
                  </span>{" "}
                  case{cases.length === 1 ? "" : "s"} loaded
                  {truncated ? (
                    <span className="ml-1 text-amber-700 dark:text-amber-300">
                      (of {totalCases} — capped at 50)
                    </span>
                  ) : null}
                </>
              ) : (
                <>—</>
              )}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                sourceLabel ? "text-foreground/85" : "text-amber-700 dark:text-amber-300",
              )}
            >
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={10}
                strokeWidth={1.75}
              />
              {sourceLabel ? (
                <>
                  source: <span className="font-mono">{sourceLabel}</span>
                </>
              ) : (
                <>no source dir — code grounding off</>
              )}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => void loadCases(planId, suiteId, true)}
                disabled={casesLoading}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.75}
                  className={casesLoading ? "animate-spin" : ""}
                />
                Reload cases
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Re-fetch every case in this suite from Azure DevOps
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => clearMessages(planId, suiteId)}
                disabled={messages.length === 0 || busy}
              >
                Clear chat
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Drop the current conversation (cases stay loaded).
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* Optional advisory banners --------------------------------------- */}
      {!sourceRoot && cases && cases.length > 0 ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/[0.05] px-5 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={11}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          <p className="leading-relaxed">
            No source directory is set, so the analyst can only review case
            definitions on their own merits. Set one in Settings → Preferences
            to enable code-grounded answers (&ldquo;does the code in
            <code className="mx-0.5 font-mono">login.ts</code> actually match
            what step 3 asserts?&rdquo;).
          </p>
        </div>
      ) : null}
      {truncated ? (
        <div className="shrink-0 border-b border-border/40 bg-foreground/[0.03] px-5 py-1.5 text-[10.5px] text-muted-foreground">
          Showing the first 50 of {totalCases} cases. Suite-wide questions
          may miss content outside this window — narrow the scope to specific
          case ids when accuracy matters.
        </div>
      ) : null}
      {casesError ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/[0.06] px-5 py-2 text-[11px] text-destructive">
          Couldn&apos;t load cases: {adoErrorMessage(casesError)}
        </div>
      ) : null}

      {/* Thread ----------------------------------------------------------- */}
      <div
        ref={threadRef}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-5">
          {casesLoading && !cases ? (
            <CaseLoadingShimmer />
          ) : cases && cases.length === 0 ? (
            <EmptySuiteHint suiteName={suiteName} />
          ) : messages.length === 0 ? (
            <ChatOnboarding hasCases={cases !== null && cases.length > 0} hasSource={!!sourceRoot} />
          ) : null}

          {messages.map((m) => (
            <MessageBubble key={m.id} role={m.role} content={m.content} />
          ))}
          {busy ? (
            <div className="flex items-center gap-2 self-start rounded-md bg-foreground/[0.05] px-3 py-1.5 text-[11px] text-muted-foreground">
              <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              Thinking…
              <button
                type="button"
                onClick={() => cancel(planId, suiteId)}
                className="ml-1 font-mono text-[10px] underline-offset-2 hover:underline"
              >
                cancel
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Chat error banner ---------------------------------------------- */}
      {error ? (
        <div className="flex items-start gap-1.5 border-t border-destructive/30 bg-destructive/[0.06] px-5 py-1.5 text-[11px] text-destructive">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => dismissError(planId, suiteId)}
            className="text-[10.5px] underline-offset-2 hover:underline"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* Composer ------------------------------------------------------- */}
      <div className="shrink-0 border-t border-border/40 bg-card/40 px-5 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="relative">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              disabled={busy || casesLoading || !cases}
              placeholder={
                cases
                  ? "Ask about these cases… (Enter to send, Shift+Enter for newline)"
                  : "Loading cases…"
              }
              className="w-full resize-none rounded-md border border-border/50 bg-input/40 px-3 py-2 pr-10 text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || busy || !cases}
              aria-label="Send message"
              className={cn(
                "absolute bottom-2 right-2 grid size-7 place-items-center rounded-sm transition-colors",
                draft.trim() && !busy && cases
                  ? "bg-primary text-primary-foreground hover:bg-primary/85"
                  : "bg-foreground/[0.06] text-muted-foreground/55",
              )}
            >
              <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: string;
}) {
  return (
    <div
      className={cn(
        "flex",
        role === "user" ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap break-words rounded-md px-3 py-2 text-[12px] leading-relaxed",
          role === "user"
            ? "bg-primary/15 text-foreground"
            : "bg-foreground/[0.05] text-foreground/90",
        )}
      >
        {content}
      </div>
    </div>
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
      No cases in <span className="font-medium text-foreground/90">{suiteName ?? "this suite"}</span> yet —
      generate some from the suite&apos;s context menu, then come back here
      to chat about them.
    </div>
  );
}

function ChatOnboarding({
  hasCases,
  hasSource,
}: {
  hasCases: boolean;
  hasSource: boolean;
}) {
  if (!hasCases) return null;
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-4 py-4 text-[12px] leading-relaxed">
      <p className="font-medium text-foreground/90">Ask the analyst about this suite.</p>
      <p className="mt-1.5 text-muted-foreground">
        The full case list is in scope. Try things like:
      </p>
      <ul className="mt-1.5 ml-3 flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        <li>
          &ldquo;Are there gaps in coverage for the auth flow?&rdquo;
        </li>
        <li>
          &ldquo;Which cases are too vague to actually run?&rdquo;
        </li>
        {hasSource ? (
          <li>
            &ldquo;Look at <code className="font-mono">src/auth/login.ts</code>{" "}
            — do the cases here actually match how the code returns errors?&rdquo;
          </li>
        ) : (
          <li>
            &ldquo;Set a source directory to ground answers in real code.&rdquo;
          </li>
        )}
        <li>
          &ldquo;If I asked you whether these all pass, what would you need?&rdquo;
        </li>
      </ul>
    </div>
  );
}
