import {
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type Props = {
  /** Current value rendered when the field isn't being edited. */
  value: string;
  /** Called when the user commits a change (blur or Enter / Ctrl+Enter). */
  onCommit: (next: string) => void;
  /** Optional placeholder shown when the resting value is empty. */
  placeholder?: string;
  /** Render hint — `singleline` swaps a textarea for an input and submits
   *  on Enter; `multiline` keeps Enter as a newline and submits on
   *  Ctrl/Cmd+Enter or blur. */
  variant?: "singleline" | "multiline";
  /** Outer className applied to BOTH the resting span and the editor input. */
  className?: string;
  /** className applied only to the resting span. Useful when the editing
   *  state shouldn't carry the same color / decoration as the display. */
  displayClassName?: string;
  /** className applied only to the editing input/textarea. */
  editClassName?: string;
  /** Accessible label for the editing field. */
  ariaLabel?: string;
  /** Disable editing entirely — falls back to a plain span. */
  readOnly?: boolean;
};

/**
 * Click-to-edit text field. Renders as plain text until the user clicks (or
 * focuses via Tab); then swaps to an input / textarea bound to local state.
 * Commits on blur, Enter (singleline), or Ctrl+Enter (multiline). Escape
 * reverts. Designed to be near-invisible at rest so the review surface
 * still reads as content, not as a form.
 */
export function EditableText({
  value,
  onCommit,
  placeholder,
  variant = "singleline",
  className,
  displayClassName,
  editClassName,
  ariaLabel,
  readOnly,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Sync external changes (e.g. a refine that replaced the batch) while the
  // user isn't actively editing — would otherwise stomp on a partial edit.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Focus + auto-resize on entry so the user can start typing immediately.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft;
    setEditing(false);
    if (trimmed !== value) onCommit(trimmed);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const onKeyDown = (
    e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (variant === "singleline" && e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (
      variant === "multiline" &&
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      commit();
    }
  };

  if (readOnly || !editing) {
    const hasValue = value.trim().length > 0;
    const isPlaceholder = !hasValue && !!placeholder;
    return (
      <span
        // Keyboard-accessible affordance: the resting span is focusable; Enter
        // / Space promote it to the editor. Click also works. Disabled when
        // readOnly is true.
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? -1 : 0}
        onClick={() => !readOnly && setEditing(true)}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        title={readOnly ? undefined : "Click to edit"}
        className={cn(
          className,
          displayClassName,
          !readOnly &&
            "cursor-text rounded-sm transition-colors hover:bg-foreground/[0.04] hover:outline hover:outline-1 hover:outline-border/40 -mx-0.5 px-0.5",
          isPlaceholder && "italic text-muted-foreground/55",
        )}
      >
        {hasValue ? value : placeholder ?? ""}
      </span>
    );
  }

  // Editing — swap in the matching control. Outline + ring give a clear
  // "you're editing now" cue without the heaviness of a full input chrome.
  const baseEdit =
    "w-full rounded-sm border border-primary/40 bg-card/80 px-1 py-0 outline-none focus:ring-2 focus:ring-ring/30 -mx-0.5";

  if (variant === "multiline") {
    return (
      <textarea
        ref={inputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // Auto-grow for multi-line entries — feels closer to real editor
          // behavior than a fixed-rows textarea.
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        rows={1}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cn(className, baseEdit, "resize-none", editClassName)}
      />
    );
  }
  return (
    <input
      ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={cn(className, baseEdit, editClassName)}
    />
  );
}
