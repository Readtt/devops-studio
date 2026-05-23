import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGenerationSession } from "../store/useGenerationSession";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

/**
 * Floating Q&A panel anchored to the bottom-right of the review pane.
 *
 * Distinct from refine: this is a *conversation* about the draft — "do these
 * cover X?", "why did you flag this bug?", "is the 2FA case actually testable
 * without a backend?". The model can suggest edits but the user has to use
 * Refine to apply them; the chat itself never mutates the draft.
 *
 * The panel opens on FAB click, stays anchored, and animates in from the
 * bottom-right. Messages render as alternating bubbles, with the assistant
 * side rendered as preformatted text (we'd plug a markdown renderer here if
 * the rest of the app standardized on one — for now plain text keeps it
 * dependency-free and predictable across themes).
 */
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

  // Auto-scroll to the latest message when the thread changes or busy flips.
  // Pinned to the bottom edge — the panel is small enough that the user
  // doesn't want to scroll-to-top behavior on new replies.
  useEffect(() => {
    if (!open) return;
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  // Focus the input when the panel opens — chat is high-interaction, the
  // user almost always wants to type next.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    void send(text);
    setDraft("");
  };

  return (
    // Sits ABOVE the 28px bottom status bar — without this lift the FAB and
    // the expanded panel cover the status bar (branch + ADO connection chip)
    // making it unclickable. 44px = status bar (28px) + breathing room.
    <div className="pointer-events-none fixed bottom-11 right-4 z-40 flex flex-col items-end gap-2">
      {open ? (
        <div className="pointer-events-auto flex h-[520px] w-[440px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border border-border/60 bg-card/95 shadow-2xl backdrop-blur-md">
          <header className="flex items-center gap-2 border-b border-border/40 bg-foreground/[0.03] px-3 py-2">
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
                  className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
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
                  aria-label="Close chat"
                  className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={11}
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Close
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
            <div className="flex items-start gap-1.5 border-t border-destructive/30 bg-destructive/[0.06] px-3 py-1.5 text-[10.5px] text-destructive">
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
          <div className="border-t border-border/40 bg-card/40 p-2">
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
                <HugeiconsIcon icon={ArrowUp01Icon} size={12} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={open ? "outline" : "default"}
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Hide ask panel" : "Ask about this draft"}
            className="pointer-events-auto h-8 gap-1.5 rounded-md px-2.5 text-[11.5px] shadow-lg"
          >
            <HugeiconsIcon
              icon={open ? Cancel01Icon : BubbleChatIcon}
              size={12}
              strokeWidth={1.75}
            />
            {open ? "Hide" : "Ask"}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[11px]">
          {open
            ? "Hide chat"
            : "Ask questions about this draft — separate from Refine"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
