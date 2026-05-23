import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGenerationSession } from "../store/useGenerationSession";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowTurnUpIcon,
  BubbleChatIcon,
  Cancel01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

/**
 * Right-edge "Ask" side drawer for the Review phase.
 *
 * Replaces the older floating-FAB design. The drawer slides out from the
 * right edge of the GeneratorPane (its parent must be `relative`), sitting
 * between the progress strip and the bottom status bar so it never overlaps
 * either. When closed, a thin vertical "Ask" tab rests against the right
 * edge — discoverable, but stays out of the way of the review content.
 *
 * Distinct from refine: this is a *conversation* about the draft —
 * "do these cover X?", "why did you flag this bug?". The model can suggest
 * edits but the user has to use Refine to actually mutate the draft;
 * this chat is read-only against the workspace.
 */
const DRAWER_WIDTH = 440;

export function ReviewChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const messages = useGenerationSession((s) => s.chatMessages);
  const busy = useGenerationSession((s) => s.chatBusy);
  const error = useGenerationSession((s) => s.chatError);
  const send = useGenerationSession((s) => s.sendChatMessage);
  const cancel = useGenerationSession((s) => s.cancelChat);
  const clear = useGenerationSession((s) => s.clearChat);
  const dismissError = useGenerationSession((s) => s.dismissChatError);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close-on-Escape — natural for a side drawer. Don't intercept when the
  // user is mid-typing in the composer; let Escape cancel selection there.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.activeElement !== inputRef.current) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    void send(text);
    setDraft("");
  };

  return (
    <>
      {/* Closed-state toggle — a vertical "Ask" tab pinned to the right
          edge. Sits inside the GeneratorPane so it can never cover the
          bottom status bar. We deliberately keep the chip narrow so it
          intrudes on the review content as little as possible. */}
      {!open ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open the Ask panel"
              className={cn(
                "absolute right-0 top-1/2 z-30 -translate-y-1/2",
                "flex flex-col items-center gap-1.5 rounded-l-md border border-r-0 border-border/60",
                "bg-card/95 px-1.5 py-3 text-foreground/80 shadow-md backdrop-blur-sm",
                "transition-colors hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary",
              )}
            >
              <HugeiconsIcon
                icon={BubbleChatIcon}
                size={13}
                strokeWidth={1.75}
              />
              <span
                className="text-[10px] font-medium tracking-wider"
                style={{ writingMode: "vertical-rl" }}
              >
                Ask
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-[11px]">
            Ask questions about this draft — read-only, doesn't change cases.
          </TooltipContent>
        </Tooltip>
      ) : null}

      {/* Drawer. `absolute` (not fixed) so it's bounded to the GeneratorPane
          container — naturally clears the bottom status bar without us
          having to math out viewport offsets. */}
      <div
        aria-hidden={!open}
        className={cn(
          "absolute right-0 top-0 z-30 flex h-full flex-col border-l border-border/60 bg-card/95 shadow-2xl backdrop-blur-md",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
        style={{ width: DRAWER_WIDTH }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-foreground/[0.03] px-3 py-2">
          <span className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-card/80 text-foreground/70">
            <HugeiconsIcon icon={BubbleChatIcon} size={12} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] font-medium leading-none">
              Ask about this draft
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Read-only — use Refine to actually change cases.
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => clear()}
                disabled={messages.length === 0 || busy}
                aria-label="Clear chat"
                className="grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={11}
                  strokeWidth={1.75}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Clear chat
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close ask panel"
                className="grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={11}
                  strokeWidth={1.75}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Close · Esc
            </TooltipContent>
          </Tooltip>
        </header>

        <div
          ref={threadRef}
          className="flex-1 overflow-y-auto px-3 py-2.5 text-[11.5px]"
        >
          {messages.length === 0 && !busy ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
              <p className="text-[11.5px] font-medium text-foreground/90">
                What would you like to know?
              </p>
              <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                Try &ldquo;do these cover the password-reset flow?&rdquo; or
                &ldquo;why did you flag the SSO bug?&rdquo; — answers cite
                the current draft.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={cn(
                    "flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] break-words rounded-md px-2.5 py-1.5 text-[11.5px] leading-relaxed",
                      m.role === "user"
                        ? "whitespace-pre-wrap bg-primary/15 text-foreground"
                        : "bg-foreground/[0.05] text-foreground/90",
                    )}
                  >
                    {m.role === "assistant" ? (
                      <ChatMarkdown source={m.content} />
                    ) : (
                      m.content
                    )}
                  </div>
                </li>
              ))}
              {busy ? (
                <li className="flex justify-start">
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    Thinking…
                    <button
                      type="button"
                      onClick={() => cancel()}
                      className="ml-1 font-mono text-[10px] text-muted-foreground/85 underline-offset-2 hover:underline"
                    >
                      cancel
                    </button>
                  </div>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        {error ? (
          <div className="flex shrink-0 items-start gap-1.5 border-t border-destructive/30 bg-destructive/[0.06] px-3 py-1.5 text-[10.5px] text-destructive">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => dismissError()}
              className="text-[10px] underline-offset-2 hover:underline"
            >
              dismiss
            </button>
          </div>
        ) : null}

        <div className="shrink-0 border-t border-border/40 bg-card/40 p-2">
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
              disabled={busy}
              placeholder="Ask about the draft… (Enter to send, Shift+Enter for newline)"
              className="w-full resize-none rounded-sm border border-border/40 bg-input/40 px-2 py-1.5 pr-8 text-[11.5px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || busy}
              aria-label="Send message"
              className={cn(
                "absolute bottom-1.5 right-1.5 grid size-6 place-items-center rounded-sm transition-colors",
                draft.trim() && !busy
                  ? "bg-primary text-primary-foreground hover:bg-primary/85"
                  : "bg-foreground/[0.06] text-muted-foreground/55",
              )}
            >
              <HugeiconsIcon icon={ArrowTurnUpIcon} size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
