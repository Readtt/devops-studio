import { useState } from "react";
import {
  Cancel01Icon,
  CancelCircleIcon,
  Image01Icon,
  File01Icon,
  FileEditIcon,
  ZoomInAreaIcon,
} from "@hugeicons/core-free-icons";
import { DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { Attachment } from "../store/useGenerationSession";

type Props = {
  attachments: Attachment[];
  /** When omitted the list renders in read-only mode — no remove button on
   *  each chip. Used by the analyzing phase to surface what the model
   *  received without offering edits mid-run. Receives the attachment's
   *  stable `id` so identically-named files (two Windows screenshots
   *  pasted in a row) can be removed independently. */
  onRemove?: (id: string) => void;
  className?: string;
};

/** Renders attached files as compact chips with mime/size and a remove button.
 *  Image attachments get an inline thumbnail and open into a centered lightbox
 *  when clicked; text/binary attachments are display-only. */
export function AttachmentList({ attachments, onRemove, className }: Props) {
  // Single lightbox instance per list — the chip clicks pump the path into
  // state and the modal mounts only when there's something to show. Keeping
  // the modal here (not inside the chip) means clicking a different image
  // swaps the source instead of stacking dialogs.
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {attachments.map((a) => (
          <AttachmentChip
            key={a.id}
            attachment={a}
            onRemove={onRemove}
            onPreview={() => setPreview(a)}
          />
        ))}
      </div>
      <ImageLightbox
        attachment={preview}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
  onPreview,
}: {
  attachment: Attachment;
  onRemove?: (id: string) => void;
  onPreview: () => void;
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
  const previewable = isImage && attachment.content.startsWith("data:");

  return (
    <div
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 py-1 pl-1 pr-1.5 text-[11px] transition-colors hover:border-primary/40",
        previewable && "cursor-pointer",
      )}
      role={previewable ? "button" : undefined}
      tabIndex={previewable ? 0 : -1}
      // The whole chip becomes the affordance for previewable images — the
      // thumbnail and the filename both feel clickable, and the user doesn't
      // have to hunt for a tiny zoom icon. The trash button stops propagation
      // so removing doesn't also open the lightbox.
      onClick={previewable ? onPreview : undefined}
      onKeyDown={
        previewable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPreview();
              }
            }
          : undefined
      }
      aria-label={
        previewable ? `Open preview of ${attachment.path}` : undefined
      }
    >
      {isImage && attachment.content.startsWith("data:") ? (
        <span className="relative inline-flex">
          <img
            src={attachment.content}
            alt={attachment.path}
            className="size-6 shrink-0 rounded-sm object-cover"
          />
          {/* Hover overlay hints at the click action without taking space when
              the chip is at rest. Matches the editor-voice density. */}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">
            <HugeiconsIcon
              icon={ZoomInAreaIcon}
              className="size-3 text-background"
              strokeWidth={2}
            />
          </span>
        </span>
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
      {onRemove ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(attachment.id);
              }}
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
      ) : null}
    </div>
  );
}

/** Centered image lightbox. The shadcn DialogContent defaults to a grid +
 *  gap-4 + p-5 card meant for forms, which fights with a single image child
 *  and produces weird spacing on small images. We override to a clean flex
 *  column with no grid + no internal gap, and run the chrome (title row +
 *  caption row) as edge-to-edge bars so the image is the dominant element. */
function ImageLightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment | null;
  onClose: () => void;
}) {
  const open = !!attachment;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Important: the dialog itself MUST be capped at 92vh. Radix centers
        // via translate(-50%, -50%); if the dialog grows past viewport
        // (tall portrait screenshots), translation pushes the top and
        // bottom off-screen and the image gets clipped on both ends.
        // Capping the outer + letting the image stage flex-fill the
        // leftover space guarantees the image is always fully visible.
        // twMerge resolves our overrides against the shadcn defaults so
        // `flex` replaces `grid`, `p-0` replaces `p-5`, etc.
        className="flex h-fit max-h-[92vh] w-fit min-w-[360px] max-w-[min(92vw,1400px)] flex-col gap-0 overflow-hidden rounded-xl border-border/50 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl"
      >
        {attachment ? (
          <>
            <DialogTitle className="sr-only">{attachment.path}</DialogTitle>
            <DialogDescription className="sr-only">
              Enlarged preview of attached image {attachment.path}.
            </DialogDescription>

            {/* Header bar: monospace filename on the left, close pill on the
                right. Reads like a file viewer's title bar in the same
                typographic register as the rest of the app. */}
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-card/50 px-3">
              <span className="size-1.5 shrink-0 rounded-full bg-primary/70" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
                {attachment.path}
              </span>
              <DialogClose asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close preview"
                  className="size-6 text-muted-foreground hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    className="size-3"
                    strokeWidth={2}
                  />
                </Button>
              </DialogClose>
            </div>

            {/* Image stage: absorbs whatever vertical space is left between
                the title bar and footer (flex-1 + min-h-0). The image then
                fits 100% of that area with object-contain, so the entire
                image is always visible without internal scrolling.
                A subtle checker matte keeps transparent PNGs readable. */}
            <div
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[image:linear-gradient(45deg,var(--muted)_25%,transparent_25%),linear-gradient(-45deg,var(--muted)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--muted)_75%),linear-gradient(-45deg,transparent_75%,var(--muted)_75%)] bg-[length:14px_14px] bg-[position:0_0,0_7px,7px_-7px,-7px_0px] p-2 dark:bg-[image:linear-gradient(45deg,#1a1a1a_25%,transparent_25%),linear-gradient(-45deg,#1a1a1a_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#1a1a1a_75%),linear-gradient(-45deg,transparent_75%,#1a1a1a_75%)]"
            >
              <img
                src={attachment.content}
                alt={attachment.path}
                // max-h-full / max-w-full + object-contain = always fully
                // visible inside the stage, never cropped, always centered.
                // The dialog's outer max-h ensures the stage itself stays
                // within the viewport.
                className="block max-h-full max-w-full object-contain"
              />
            </div>

            {/* Footer bar: mime type + byte count + esc hint. Mirrors the
                header bar height so the chrome reads as a balanced frame. */}
            <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border/50 bg-card/50 px-3 font-mono text-[10px] text-muted-foreground/85">
              <span className="flex items-center gap-2">
                {attachment.mime ? (
                  <span className="rounded-sm bg-foreground/[0.06] px-1.5 py-px">
                    {attachment.mime}
                  </span>
                ) : null}
                <span className="tabular-nums">
                  {formatSize(attachment.sizeBytes)}
                </span>
              </span>
              <span className="flex items-center gap-1 text-muted-foreground/70">
                <Kbd>Esc</Kbd>
                <span>to close</span>
              </span>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
