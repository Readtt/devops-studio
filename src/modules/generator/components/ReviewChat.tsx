import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGenerationSession } from "../store/useGenerationSession";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  AttachButton,
  AttachmentDropZone,
  ingestFile,
  synthesizeClipboardImageName,
} from "@/components/chat/attachments";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowTurnUpIcon,
  Cancel01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

/**
 * Ask side panel for the Review phase.
 *
 * Lives as a flex sibling of the review content (not an absolute drawer)
 * so the chat actually shares the pane with the draft — the user can read
 * cases on the left and ask questions on the right at the same time. The
 * panel is fully controlled by GeneratorPane: it mounts when the user
 * clicks Ask in the ProgressStrip header and unmounts on close, so there
 * is no separate "is the drawer open" animation state to keep in sync.
 *
 * Distinct from Refine: this is a *conversation* about the draft —
 * "do these cover X?", "why did you flag this bug?". The model can suggest
 * edits but the user has to use Refine to actually mutate the draft;
 * this chat is read-only against the workspace.
 */
const PANEL_WIDTH = 440;

type Props = {
  /** Called when the user dismisses the panel via the close button or
   *  Esc. The parent unmounts ReviewChat in response. */
  onClose: () => void;
};

export function ReviewChat({ onClose }: Props) {
  const [draft, setDraft] = useState("");

  const messages = useGenerationSession((s) => s.chatMessages);
  const busy = useGenerationSession((s) => s.chatBusy);
  const streamingId = useGenerationSession((s) => s.chatStreamingId);
  const error = useGenerationSession((s) => s.chatError);
  const send = useGenerationSession((s) => s.sendChatMessage);
  const cancel = useGenerationSession((s) => s.cancelChat);
  const clear = useGenerationSession((s) => s.clearChat);
  const dismissError = useGenerationSession((s) => s.dismissChatError);
  const attachments = useGenerationSession((s) => s.attachments);
  const addRichAttachment = useGenerationSession((s) => s.addRichAttachment);
  const removeAttachment = useGenerationSession((s) => s.removeAttachment);
  const [attErrors, setAttErrors] = useState<{ id: string; message: string }[]>(
    [],
  );

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const errs: { id: string; message: string }[] = [];
      for (const f of files) {
        const result = await ingestFile(f);
        if (result.ok) addRichAttachment(result.attachment);
        else
          errs.push({
            id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            message: result.error.message,
          });
      }
      if (errs.length) setAttErrors((p) => [...p, ...errs]);
    },
    [addRichAttachment],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? []) as File[];
      if (items.length === 0) return;
      e.preventDefault();
      const named = items.map((f) =>
        f.name
          ? f
          : new File([f], synthesizeClipboardImageName(f.type || "image/png"), {
              type: f.type,
            }),
      );
      void ingestFiles(named);
    },
    [ingestFiles],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      void ingestFiles(Array.from(e.dataTransfer?.files ?? []));
    },
    [ingestFiles],
  );

  const onFilePicker = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      void ingestFiles(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [ingestFiles],
  );

  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Autosize the single-row textarea up to a cap so the composer grows with
  // the text instead of starting tall and leaving the controls floating.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // Close-on-Escape — natural for a side panel. Skip when the composer has
  // focus so Esc there can cancel autocomplete / text selection instead of
  // dismissing the whole panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement === inputRef.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    void send(text);
    setDraft("");
  };

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-border/60 bg-card/40"
      style={{ width: PANEL_WIDTH }}
      aria-label="Ask about this draft"
    >
      {/* Editor-style header: an uppercase mono scope tag + a one-line
          description, mirroring how the ProgressStrip reads. The earlier
          design used a card-style bubble-icon badge that read as a chat
          avatar — distracting at the top of a working panel. The cleaner
          two-line layout signals scope without competing for attention. */}
      <header className="flex shrink-0 items-start gap-2 border-b border-border/40 bg-foreground/[0.02] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Ask · read-only
          </p>
          <p className="mt-0.5 text-[11.5px] leading-tight text-foreground/90">
            Questions about this draft
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
              onClick={onClose}
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
                    m.id === streamingId && m.content.trim() === "" ? (
                      <ThinkingDots />
                    ) : (
                      <ChatMarkdown
                        source={m.content}
                        streaming={m.id === streamingId}
                      />
                    )
                  ) : (
                    m.content
                  )}
                </div>
              </li>
            ))}
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
        <AttachmentDropZone
          attachments={attachments}
          errors={attErrors}
          remove={removeAttachment}
          dismissError={(id) =>
            setAttErrors((p) => p.filter((e) => e.id !== id))
          }
          className="mb-2"
        />
        {/* Single autosizing row — attach / input / send sit on one baseline
            (items-end) so the controls track the text as it grows instead of
            floating at the bottom of a fixed two-line box. */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            "group flex items-end gap-1.5 rounded-sm border border-border/40 bg-input/40 px-1.5 py-1 transition-colors",
            "focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/25",
            busy && "border-primary/35 bg-primary/[0.03]",
          )}
        >
          <AttachButton
            onFilePicker={onFilePicker}
            disabled={busy}
            iconSize={13}
            className="size-6 rounded-sm"
          />
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={busy}
            placeholder="Ask about the draft…  (Enter to send · Shift+Enter for newline)"
            className="min-h-[20px] w-full resize-none bg-transparent py-1 text-[11.5px] leading-[1.55] outline-none placeholder:text-muted-foreground/55"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => cancel()}
              aria-label="Stop"
              className="grid size-6 shrink-0 place-items-center rounded-sm bg-foreground/[0.08] text-foreground/80 transition-colors hover:bg-foreground/[0.14]"
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="Send message"
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-sm transition-colors",
                draft.trim()
                  ? "bg-primary text-primary-foreground hover:bg-primary/85"
                  : "bg-foreground/[0.06] text-muted-foreground/55",
              )}
            >
              <HugeiconsIcon icon={ArrowTurnUpIcon} size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Three pulsing dots shown in the assistant bubble before the first token
 *  lands — same language as the suite chat's streaming placeholder. */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.18s]" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.36s]" />
    </span>
  );
}
