import {
  CancelCircleIcon,
  Image01Icon,
  File01Icon,
  FileEditIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Attachment } from "../store/useGenerationSession";

type Props = {
  attachments: Attachment[];
  onRemove: (path: string) => void;
  className?: string;
};

/** Renders attached files as compact chips with mime/size and a remove button.
 *  Image attachments get an inline thumbnail (their content is a base64 data
 *  URL); text attachments get a file icon and byte count. */
export function AttachmentList({ attachments, onRemove, className }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {attachments.map((a) => (
        <AttachmentChip key={a.path} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: (path: string) => void;
}) {
  const isImage = attachment.kind === "image";
  const isText = attachment.kind === "text";
  // Strip the extension so we can render it as a separate mono tag — the
  // visual rhythm matches how the rest of the app surfaces structural
  // metadata (file:line on bug refs, hint on model rows, etc.).
  const lastDot = attachment.path.lastIndexOf(".");
  const stem =
    lastDot > 0 ? attachment.path.slice(0, lastDot) : attachment.path;
  const ext = lastDot > 0 ? attachment.path.slice(lastDot + 1) : null;
  return (
    <div className="group inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 py-1 pl-1 pr-1.5 text-[11px] transition-colors hover:border-primary/40">
      {isImage && attachment.content.startsWith("data:") ? (
        <img
          src={attachment.content}
          alt={attachment.path}
          className="size-6 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <HugeiconsIcon
          icon={isText ? FileEditIcon : isImage ? Image01Icon : File01Icon}
          className={cn(
            "size-3.5 shrink-0",
            isImage ? "text-primary/80" : "text-muted-foreground",
          )}
        />
      )}
      <span className="max-w-[160px] truncate font-mono text-foreground/85">
        {stem}
      </span>
      {ext ? (
        <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 py-px font-mono text-[9.5px] text-muted-foreground">
          .{ext}
        </span>
      ) : null}
      <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
        {formatSize(attachment.sizeBytes)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onRemove(attachment.path)}
            className="ml-0.5 inline-flex size-4 items-center justify-center rounded text-muted-foreground/60 hover:bg-destructive/15 hover:text-destructive"
            aria-label={`Remove ${attachment.path}`}
          >
            <HugeiconsIcon icon={CancelCircleIcon} className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Remove attachment
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
