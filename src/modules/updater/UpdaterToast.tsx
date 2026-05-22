import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowReloadHorizontalIcon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CloudDownloadIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { type ChangelogSection, parseChangelog } from "./parseChangelog";
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

const SECTION_TONE: Record<
  ChangelogSection["kind"],
  { label: string; chip: string }
> = {
  added: {
    label: "New",
    chip: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300",
  },
  fixed: {
    label: "Fixed",
    chip: "border-primary/30 bg-primary/[0.08] text-primary",
  },
  changed: {
    label: "Changed",
    chip: "border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300",
  },
  removed: {
    label: "Removed",
    chip: "border-rose-500/30 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300",
  },
  security: {
    label: "Security",
    chip: "border-violet-500/30 bg-violet-500/[0.08] text-violet-700 dark:text-violet-300",
  },
  other: {
    label: "Notes",
    chip: "border-border bg-muted/40 text-muted-foreground",
  },
};

/** How many items render inline per section before we hide the rest behind
 *  a "+N more" affordance. Keeps the toast scannable instead of paginated. */
const VISIBLE_ITEMS_PER_SECTION = 2;

export function UpdaterToast({ status, onInstall, onDismiss }: Props) {
  const [showAll, setShowAll] = useState(false);

  const presentation = useMemo(() => {
    if (status.kind === "available") {
      return {
        mode: "available" as const,
        version: status.update.version,
        body: status.update.body ?? "",
      };
    }
    if (status.kind === "downloading") {
      return { mode: "downloading" as const };
    }
    if (status.kind === "ready") {
      return { mode: "ready" as const };
    }
    return null;
  }, [status]);

  const sections = useMemo(
    () => (presentation?.mode === "available" ? parseChangelog(presentation.body) : []),
    [presentation],
  );

  if (!presentation) return null;

  const downloadPct =
    status.kind === "downloading" && status.contentLength
      ? Math.min(100, Math.round((status.downloaded / status.contentLength) * 100))
      : null;

  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const showOverflow = !showAll && totalItems > VISIBLE_ITEMS_PER_SECTION * sections.length;

  return (
    <div
      // Anchored to the bottom-left of the workspace panel (App.tsx renders
      // us inside that relative wrapper). pointer-events-none on the gutter
      // so the empty space around the card never absorbs clicks meant for
      // the panes behind it.
      className="pointer-events-none absolute bottom-3 left-3 z-40 w-[360px]"
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "pointer-events-auto relative overflow-hidden rounded-xl border border-border/70 bg-card/95 backdrop-blur-xl",
          "shadow-[0_18px_48px_-20px_rgba(0,0,0,0.45),0_2px_4px_-2px_rgba(0,0,0,0.25)]",
          "animate-in fade-in slide-in-from-bottom-3 duration-300",
        )}
      >
        {/* Soft accent strip on the left edge — the only chromatic flourish
            on the card so the eye lands on it before the content. */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[2px] bg-gradient-to-b from-primary via-primary/60 to-primary/20"
        />

        {/* HEADER ------------------------------------------------------- */}
        <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-1.5">
          <span
            className={cn(
              "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/[0.08] text-primary",
              presentation.mode === "ready" &&
                "border-primary/60 bg-primary text-primary-foreground",
            )}
          >
            <HugeiconsIcon
              icon={
                presentation.mode === "ready"
                  ? ArrowReloadHorizontalIcon
                  : presentation.mode === "downloading"
                    ? CloudDownloadIcon
                    : SparklesIcon
              }
              size={14}
              strokeWidth={1.75}
            />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/80">
              {presentation.mode === "ready"
                ? "ready to install"
                : presentation.mode === "downloading"
                  ? "downloading update"
                  : "new release available"}
            </p>
            <h3 className="mt-0.5 truncate text-[13px] font-semibold tracking-tight text-foreground">
              {presentation.mode === "available"
                ? `DevOps Studio v${presentation.version}`
                : presentation.mode === "downloading"
                  ? "Fetching the update…"
                  : "Restart to apply the update"}
            </h3>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onDismiss}
                className="-mt-0.5 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                aria-label="Dismiss"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[11px]">
              Dismiss — find this update again in the status bar
            </TooltipContent>
          </Tooltip>
        </div>

        {/* BODY --------------------------------------------------------- */}
        {presentation.mode === "available" && (
          <div className="flex flex-col gap-2 px-3.5 pt-1.5 pb-2.5">
            {sections.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                A new build is ready. Install now to pick it up, or review later
                from Settings → About.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {sections.map((s) => {
                  const tone = SECTION_TONE[s.kind];
                  const visible = showAll
                    ? s.items
                    : s.items.slice(0, VISIBLE_ITEMS_PER_SECTION);
                  return (
                    <section key={s.label} className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex h-4 items-center rounded-full border px-1.5 font-mono text-[9px] uppercase tracking-wider",
                            tone.chip,
                          )}
                        >
                          {tone.label}
                        </span>
                        {s.label.toLowerCase() !== tone.label.toLowerCase() && (
                          <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/60">
                            {s.label}
                          </span>
                        )}
                      </div>
                      <ul className="flex flex-col gap-0.5 pl-0.5">
                        {visible.map((it, i) => (
                          <li
                            key={i}
                            className="flex gap-1.5 text-[11.5px] leading-snug text-foreground/85"
                          >
                            <span
                              aria-hidden
                              className="mt-[5px] inline-block size-1 shrink-0 rounded-full bg-foreground/30"
                            />
                            <span className="line-clamp-2">{it}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
                {showOverflow && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="-mt-0.5 self-start font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
                  >
                    Show all {totalItems} changes
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {presentation.mode === "downloading" && (
          <div className="flex flex-col gap-2 px-3.5 pt-1 pb-3">
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary/70 via-primary to-primary/70 transition-[width] duration-300",
                  downloadPct === null && "w-1/3 animate-pulse",
                )}
                style={downloadPct !== null ? { width: `${downloadPct}%` } : undefined}
              />
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/80">
              <span className="uppercase tracking-wider">
                {downloadPct !== null ? `${downloadPct}% complete` : "Connecting…"}
              </span>
              <span className="tabular-nums">{formatBytes(status.kind === "downloading" ? status.downloaded : 0)}</span>
            </div>
          </div>
        )}

        {presentation.mode === "ready" && (
          <div className="flex flex-col gap-1 px-3.5 pt-1 pb-1">
            <p className="flex items-center gap-1.5 text-[11.5px] text-foreground/85">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={12}
                strokeWidth={2}
                className="text-primary"
              />
              The new build is downloaded and verified. Restart whenever you're
              ready — your tabs stay where they are.
            </p>
          </div>
        )}

        {/* FOOTER ------------------------------------------------------- */}
        <div className="flex items-center justify-end gap-1 border-t border-border/40 bg-muted/20 px-2 py-1.5">
          {presentation.mode === "available" && (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void openSettingsWindow("about")}
                className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                View in Settings
              </Button>
              <Button
                size="xs"
                onClick={onInstall}
                className="gap-1 px-2.5"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={11} strokeWidth={2} />
                <span>Install now</span>
              </Button>
            </>
          )}
          {presentation.mode === "downloading" && (
            <Button
              size="xs"
              variant="ghost"
              disabled
              className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Downloading…
            </Button>
          )}
          {presentation.mode === "ready" && (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={onDismiss}
                className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                Not now
              </Button>
              <Button size="xs" onClick={onInstall} className="gap-1 px-2.5">
                <HugeiconsIcon
                  icon={ArrowReloadHorizontalIcon}
                  size={11}
                  strokeWidth={2}
                />
                <span>Restart &amp; install</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
