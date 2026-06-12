import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setBestPracticeFiles,
  setCustomInstructions,
  type BestPracticeFile,
} from "@/modules/settings/store";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

type ReadStatus = "checking" | "ok" | "error";

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Best-practices file manager, rendered as a subsection of the Models tab.
 * Best practices ARE AI config (they're injected as context into every AI
 * feature), so they live alongside the providers rather than in a tab of
 * their own — keeps the settings tab strip from overflowing.
 */
export function BestPracticesPanel() {
  const files = usePreferencesStore((s) => s.bestPracticeFiles);
  const customInstructions = usePreferencesStore((s) => s.customInstructions);
  const [status, setStatus] = useState<Record<string, ReadStatus>>({});

  // Re-check readability whenever the SET of paths changes. A best-practices
  // file may live on a network share that's currently offline — surfacing that
  // here (instead of silently at run time) tells the user why a standards file
  // isn't being applied.
  const pathsKey = files.map((f) => f.path).join("|");
  useEffect(() => {
    let alive = true;
    for (const f of files) {
      setStatus((s) => ({ ...s, [f.path]: "checking" }));
      void invoke("fs_stat", { path: f.path })
        .then(() => {
          if (alive) setStatus((s) => ({ ...s, [f.path]: "ok" }));
        })
        .catch(() => {
          if (alive) setStatus((s) => ({ ...s, [f.path]: "error" }));
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  const persist = (next: BestPracticeFile[]) => void setBestPracticeFiles(next);
  const updateAt = (i: number, patch: Partial<BestPracticeFile>) =>
    persist(files.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const removeAt = (i: number) =>
    persist(files.filter((_, idx) => idx !== i));

  const addFiles = async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        title: "Choose best-practices / standards files",
        filters: [
          {
            name: "Docs & images",
            extensions: [
              "md",
              "markdown",
              "mdx",
              "txt",
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "svg",
            ],
          },
          { name: "All files", extensions: ["*"] },
        ],
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length === 0) return;
      const existing = new Set(files.map((f) => f.path));
      const additions: BestPracticeFile[] = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({ path: p, label: baseName(p), enabled: true }));
      if (additions.length > 0) persist([...files, ...additions]);
    } catch {
      // User cancelled — nothing to do.
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Free-text instructions appended to the system prompt of every AI
          surface (Generator, Suite Chat, review Ask, Code Review, confidence
          scoring) via TaskInput.customInstructions → buildStableSystem. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
            Custom instructions
          </span>
          <p className="max-w-[440px] text-[10.5px] leading-relaxed text-muted-foreground/70">
            Added to every AI feature's system prompt (generation, suite chat,
            review chat, code review). Use it for house style, terminology, or
            standing rules — e.g. &ldquo;always write Gherkin-style steps.&rdquo;
          </p>
        </div>
        <Textarea
          value={customInstructions}
          placeholder="e.g. Prefer concise, imperative test steps. Reference the ticket id in each case title."
          onChange={(e) => void setCustomInstructions(e.currentTarget.value)}
          className="min-h-[88px] text-[12px] leading-relaxed"
        />
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
            Best practices
          </span>
          <p className="max-w-[440px] text-[10.5px] leading-relaxed text-muted-foreground/70">
            Coding-standards files fed as context into every AI feature — test
            generation, suite chat, the review Ask chat, and code review. Read
            fresh on each run, so a shared network file stays the source of truth.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => void addFiles()}>
              <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
              Add files
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Pick markdown, text, or image files. They're stored as path
            references (incl. network/UNC paths) and read live each time an AI
            feature runs.
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-2">
        {files.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">
              No best-practices files yet.
            </p>
            <p className="mx-auto mt-1 max-w-[420px] text-[10.5px] leading-relaxed text-muted-foreground/80">
              Add a coding-standards .md, a checklist, or a screenshot of your
              conventions. Every AI feature will read the enabled files and apply
              them when generating tests, reviewing code, and answering in chat.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {files.map((f, i) => (
              <FileRow
                key={f.path}
                file={f}
                status={status[f.path] ?? "checking"}
                onToggle={(enabled) => updateAt(i, { enabled })}
                onLabel={(label) => updateAt(i, { label })}
                onRemove={() => removeAt(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  status,
  onToggle,
  onLabel,
  onRemove,
}: {
  file: BestPracticeFile;
  status: ReadStatus;
  onToggle: (enabled: boolean) => void;
  onLabel: (label: string) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 transition-opacity",
        !file.enabled && "opacity-55",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIndicator status={status} />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Switch
                checked={file.enabled}
                onCheckedChange={(v) => onToggle(v)}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
            {file.enabled
              ? "Enabled — this file is injected as context into AI features. Toggle off to keep it in the list but skip it."
              : "Disabled — kept in the list but not sent to any AI feature."}
          </TooltipContent>
        </Tooltip>
        <Input
          value={file.label}
          placeholder="Label"
          onChange={(e) => onLabel(e.currentTarget.value)}
          className="h-7 flex-1 text-[11.5px]"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label="Remove file"
            >
              <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Remove from best practices
          </TooltipContent>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block truncate pl-1 font-mono text-[10.5px] text-muted-foreground">
            {file.path}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[420px] break-all text-[11px]">
          {file.path}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function StatusIndicator({ status }: { status: ReadStatus }) {
  if (status === "checking") {
    return <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />;
  }
  if (status === "ok") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 text-emerald-500">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={14}
              strokeWidth={1.75}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Readable — will be applied at run time.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 text-rose-500">
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
        Can't read this path right now — it may be offline (network share) or
        moved. It'll be skipped at run time with a warning.
      </TooltipContent>
    </Tooltip>
  );
}
