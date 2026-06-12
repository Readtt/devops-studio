import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowReloadHorizontalIcon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdaterStatus } from "./useUpdater";

interface Props {
  /** Updater state from the shared hook in App.tsx. */
  status: UpdaterStatus;
  /** Triggered by the toast's primary CTA. */
  onInstall: () => void;
  /** Triggered by the X button. App.tsx remembers which version is dismissed
   *  so the toast doesn't reappear for the same release. */
  onDismiss: () => void;
}

/** Release notes live on GitHub, not in the toast — the capsule links out
 *  instead of inlining the changelog. */
const releaseUrl = (version: string) =>
  `https://github.com/Readtt/devops-studio/releases/tag/v${version}`;

export function UpdaterToast({ status, onInstall, onDismiss }: Props) {
  if (
    status.kind !== "available" &&
    status.kind !== "downloading" &&
    status.kind !== "ready"
  ) {
    return null;
  }

  const downloadPct =
    status.kind === "downloading" && status.contentLength
      ? Math.min(100, Math.round((status.downloaded / status.contentLength) * 100))
      : null;

  return (
    <div
      // Anchored to the bottom-left of the workspace panel (App.tsx renders
      // us inside that relative wrapper). pointer-events-none on the gutter
      // so the empty space around the capsule never absorbs clicks meant for
      // the panes behind it.
      className="pointer-events-none absolute bottom-3 left-3 z-40"
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "pointer-events-auto relative flex h-9 items-center gap-2 overflow-hidden rounded-full border border-border/60 bg-card/85 pl-3 pr-1 backdrop-blur-2xl",
          "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.2)]",
          // Hairline top highlight sells the glass without a second border.
          "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
          "animate-in fade-in slide-in-from-bottom-2 duration-300",
        )}
      >
        {status.kind === "available" && (
          <>
            <span className="relative flex size-1.5 shrink-0">
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/50" />
              <span className="relative size-1.5 rounded-full bg-primary shadow-[0_0_8px_-1px_var(--primary)]" />
            </span>
            <p className="whitespace-nowrap text-[12px] text-foreground">
              <span className="font-medium">Update available</span>
              <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">
                v{status.update.version}
              </span>
            </p>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-border/70" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void openUrl(releaseUrl(status.update.version))}
                  className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  What's new
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={10} strokeWidth={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Open the release notes on GitHub
              </TooltipContent>
            </Tooltip>
            <Button size="xs" onClick={onInstall} className="ml-0.5 rounded-full px-3">
              Install
            </Button>
            <DismissButton onDismiss={onDismiss} />
          </>
        )}

        {status.kind === "downloading" && (
          <>
            <span className="relative grid size-3.5 shrink-0 place-items-center">
              <span className="absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary" />
            </span>
            <p className="whitespace-nowrap pr-1 text-[12px] text-foreground">
              <span className="font-medium">Downloading update</span>
              <span className="ml-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {downloadPct !== null ? `${downloadPct}%` : "…"}
              </span>
            </p>
            <DismissButton onDismiss={onDismiss} />
            {/* Hairline progress track along the capsule's bottom edge. */}
            <span
              aria-hidden
              className="absolute inset-x-4 bottom-0 h-[2px] overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-300",
                  downloadPct === null && "w-1/3 animate-pulse",
                )}
                style={downloadPct !== null ? { width: `${downloadPct}%` } : undefined}
              />
            </span>
          </>
        )}

        {status.kind === "ready" && (
          <>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={13}
              strokeWidth={2}
              className="shrink-0 text-primary"
            />
            <p className="whitespace-nowrap text-[12px] text-foreground">
              <span className="font-medium">Update ready</span>
              <span className="ml-1.5 text-muted-foreground">restart to apply</span>
            </p>
            <Button size="xs" onClick={onInstall} className="ml-0.5 gap-1 rounded-full px-3">
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={11} strokeWidth={2} />
              <span>Restart</span>
            </Button>
            <DismissButton onDismiss={onDismiss} />
          </>
        )}
      </div>
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onDismiss}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Dismiss"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        Dismiss
      </TooltipContent>
    </Tooltip>
  );
}
