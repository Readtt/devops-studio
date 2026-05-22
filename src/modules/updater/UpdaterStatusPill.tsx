import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowReloadHorizontalIcon,
  ArrowUp01Icon,
  CloudDownloadIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UpdaterStatus } from "./useUpdater";

interface Props {
  status: UpdaterStatus;
  onReopenToast: () => void;
}

/** Status-bar chip that surfaces updater state without ever blocking the
 *  workspace. Lives alongside the ADO + stale-queue pills in the footer and
 *  uses the same visual vocabulary: 20px tall, 10.5px monospace tag with a
 *  short label, a colored dot when something needs attention. */
export function UpdaterStatusPill({ status, onReopenToast }: Props) {
  switch (status.kind) {
    case "available": {
      const v = status.update.version;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onReopenToast}
              className={cn(
                "group relative flex h-5 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/[0.08] px-1.5 text-foreground transition-colors hover:border-primary/60 hover:bg-primary/[0.14]",
                // Subtle ring glow so a fresh update reads as different
                // from the steady-state pills without screaming for it.
                "shadow-[0_0_0_3px_var(--update-glow)] [--update-glow:transparent] hover:[--update-glow:color-mix(in_oklch,var(--primary)_18%,transparent)]",
              )}
              aria-label={`Update to v${v} available`}
            >
              <span className="relative flex size-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/50" />
                <span className="relative size-1.5 rounded-full bg-primary shadow-[0_0_6px_-1px_var(--primary)]" />
              </span>
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                size={11}
                strokeWidth={2}
                className="text-primary"
              />
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-primary/90">
                update
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="font-mono text-[10px] text-foreground/80">v{v}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            DevOps Studio v{v} is ready to install. Click to review release notes.
          </TooltipContent>
        </Tooltip>
      );
    }
    case "downloading": {
      const pct =
        status.contentLength != null && status.contentLength > 0
          ? Math.min(100, Math.round((status.downloaded / status.contentLength) * 100))
          : null;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onReopenToast}
              className="relative flex h-5 items-center gap-1.5 overflow-hidden rounded-md border border-primary/35 bg-primary/[0.06] px-1.5 transition-colors hover:border-primary/55"
              aria-label="Downloading update"
            >
              {/* Indeterminate vs determinate fill — both stay behind text. */}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-300",
                  pct === null && "w-1/3 animate-pulse",
                )}
                style={pct !== null ? { width: `${pct}%` } : undefined}
              />
              <HugeiconsIcon
                icon={CloudDownloadIcon}
                size={11}
                strokeWidth={1.75}
                className="relative text-primary"
              />
              <span className="relative font-mono text-[9.5px] uppercase tracking-wider text-primary/90">
                updating
              </span>
              {pct !== null && (
                <>
                  <span className="relative text-muted-foreground/40">·</span>
                  <span className="relative font-mono text-[10px] tabular-nums text-foreground/85">
                    {pct}%
                  </span>
                </>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            Downloading the update — DevOps Studio will restart on its own when finished.
          </TooltipContent>
        </Tooltip>
      );
    }
    case "ready": {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onReopenToast}
              className={cn(
                "flex h-5 items-center gap-1.5 rounded-md border border-primary/70 bg-primary px-1.5 text-primary-foreground transition-colors hover:brightness-110",
                "shadow-[0_0_18px_-6px_var(--primary)]",
              )}
              aria-label="Restart to install update"
            >
              <HugeiconsIcon
                icon={ArrowReloadHorizontalIcon}
                size={11}
                strokeWidth={2}
              />
              <span className="font-mono text-[9.5px] uppercase tracking-wider">
                restart
              </span>
              <span className="opacity-50">·</span>
              <span className="text-[10.5px] font-medium">to install</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            Update downloaded. Restart now to apply it.
          </TooltipContent>
        </Tooltip>
      );
    }
    case "error": {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openSettingsWindow("about")}
              className="flex h-5 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/[0.08] px-1.5 text-destructive transition-colors hover:bg-destructive/[0.14] dark:text-red-300"
              aria-label="Update check failed"
            >
              <HugeiconsIcon icon={InformationCircleIcon} size={11} strokeWidth={1.75} />
              <span className="font-mono text-[9.5px] uppercase tracking-wider">
                update failed
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] text-[11px]">
            Couldn't check for updates. Open Settings → About to retry.
          </TooltipContent>
        </Tooltip>
      );
    }
    default:
      return null;
  }
}
