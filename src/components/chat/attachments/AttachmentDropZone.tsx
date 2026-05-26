import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Attachment01Icon, CancelCircleIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AttachmentList } from "./AttachmentList";
import type { UseAttachments } from "./useAttachments";

type StripProps = Pick<
  UseAttachments,
  "attachments" | "errors" | "remove" | "dismissError"
> & { className?: string };

/** The attachments strip for a chat composer: the chip list (with remove) plus
 *  any dismissible ingestion-error chips. Renders nothing when both are empty,
 *  so it can sit unconditionally above a composer. Wire the matching
 *  `onDrop`/`onPaste` from useAttachments onto the composer's textarea, and
 *  drop an <AttachButton> into its toolbar. */
export function AttachmentDropZone({
  attachments,
  errors,
  remove,
  dismissError,
  className,
}: StripProps) {
  if (attachments.length === 0 && errors.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <AttachmentList attachments={attachments} onRemove={remove} />
      {errors.map((e) => (
        <div
          key={e.id}
          className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10.5px] text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1 truncate">{e.message}</span>
          <button
            type="button"
            onClick={() => dismissError(e.id)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-amber-700/70 hover:text-amber-700 dark:text-amber-300/70 dark:hover:text-amber-300"
            aria-label="Dismiss"
          >
            <HugeiconsIcon icon={CancelCircleIcon} className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Paperclip button + hidden file input for a composer toolbar. Calls the
 *  hook's `onFilePicker` on change. */
export function AttachButton({
  onFilePicker,
  disabled,
  className,
  iconSize = 15,
}: {
  onFilePicker: UseAttachments["onFilePicker"];
  disabled?: boolean;
  className?: string;
  /** Override the paperclip glyph size for compact composers. */
  iconSize?: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFilePicker}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
              className,
            )}
            aria-label="Attach files"
          >
            <HugeiconsIcon
              icon={Attachment01Icon}
              size={iconSize}
              strokeWidth={1.75}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
          Attach images or text files. Images are sent to the model as
          vision input; you can also drag-drop or paste them.
        </TooltipContent>
      </Tooltip>
    </>
  );
}
