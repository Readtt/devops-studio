import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AiBrain01Icon,
  Cancel01Icon,
  FolderIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  deleteChatThread,
  listChatThreads,
  type StoredChatThread,
} from "./lib/chatThreadsApi";
import { useTestPlans } from "./hooks/useTestPlans";

type Props = {
  /** Opens (or focuses) a suite-chat tab for the given (planId, suiteId). */
  onOpenChat: (input: {
    planId: number;
    suiteId: number;
    title: string;
  }) => void;
};

/**
 * Persistent chat thread browser. Lists every (plan, suite) pair the user
 * has chatted about, newest-updated first. Threads resolve their plan +
 * suite names from the useTestPlans cache so we don't have to fan out an
 * ADO fetch per row — falls back to "#id" labels for threads whose plan
 * hasn't been browsed yet this session.
 */
export function ChatHistoryPanel({ onOpenChat }: Props) {
  const [threads, setThreads] = useState<StoredChatThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await listChatThreads();
      setThreads(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const plans = useTestPlans((s) => s.plans);
  const bySuite = useTestPlans((s) => s.bySuite);
  const planNameLookup = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of plans) m.set(p.id, p.name);
    return m;
  }, [plans]);
  const suiteNameLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const [planId, load] of bySuite) {
      for (const s of load.suites) m.set(`${planId}:${s.id}`, s.name);
    }
    return m;
  }, [bySuite]);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!threads) return null;
    const labeled = threads.map((t) => labelOf(t, planNameLookup, suiteNameLookup));
    return labeled.filter((row) => {
      if (!needle) return true;
      return (
        row.planLabel.toLowerCase().includes(needle) ||
        row.suiteLabel.toLowerCase().includes(needle) ||
        row.preview.toLowerCase().includes(needle)
      );
    });
  }, [threads, planNameLookup, suiteNameLookup, needle]);

  const onDelete = useCallback(
    async (planId: number, suiteId: number) => {
      try {
        await deleteChatThread({ planId, suiteId });
        await refresh();
      } catch {
        // best-effort
      }
    },
    [refresh],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter chats…"
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh chat list"
              onClick={() => void refresh()}
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                size={12}
                strokeWidth={1.75}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Re-read chat threads from local storage
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-3 py-2 text-[11px] text-destructive">{error}</p>
        ) : null}
        {!threads ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : threads.length === 0 ? (
          <EmptyState />
        ) : visible && visible.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            No chats match this filter.
          </p>
        ) : (
          <ul className="flex flex-col px-1 py-1">
            {visible!.map((row) => (
              <li key={row.key}>
                <ThreadRow
                  row={row}
                  onOpen={() =>
                    onOpenChat({
                      planId: row.planId,
                      suiteId: row.suiteId,
                      title: `Chat: ${row.suiteLabel}`,
                    })
                  }
                  onDelete={() => void onDelete(row.planId, row.suiteId)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type LabeledRow = {
  key: string;
  planId: number;
  suiteId: number;
  planLabel: string;
  suiteLabel: string;
  messageCount: number;
  preview: string;
  updatedAt: string;
  modelId: string | null;
};

function labelOf(
  t: StoredChatThread,
  planNames: Map<number, string>,
  suiteNames: Map<string, string>,
): LabeledRow {
  const planLabel = planNames.get(t.planId) ?? `Plan #${t.planId}`;
  const suiteLabel =
    suiteNames.get(`${t.planId}:${t.suiteId}`) ?? `Suite #${t.suiteId}`;
  const firstUser = t.messages.find((m) => m.role === "user");
  const preview = firstUser
    ? firstUser.content.replace(/\s+/g, " ").trim()
    : "(no messages yet)";
  return {
    key: `${t.planId}:${t.suiteId}`,
    planId: t.planId,
    suiteId: t.suiteId,
    planLabel,
    suiteLabel,
    messageCount: t.messages.length,
    preview,
    updatedAt: t.updatedAt,
    modelId: t.modelId,
  };
}

function ThreadRow({
  row,
  onOpen,
  onDelete,
}: {
  row: LabeledRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group/row flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <HugeiconsIcon
            icon={FolderIcon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-foreground/70"
          />
          <span className="truncate">{row.suiteLabel}</span>
        </div>
        <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
          {row.planLabel} · {row.messageCount} message
          {row.messageCount === 1 ? "" : "s"}
          {" · "}
          {formatRelative(row.updatedAt)}
        </p>
        {row.preview ? (
          <p
            className={cn(
              "mt-0.5 line-clamp-2 text-[10.5px] italic",
              row.messageCount > 0
                ? "text-foreground/70"
                : "text-muted-foreground/55",
            )}
          >
            {row.preview}
          </p>
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Delete this thread"
            onClick={onDelete}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover/row:opacity-100"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[11px]">
          Delete this chat thread permanently
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground">
        <HugeiconsIcon
          icon={AiBrain01Icon}
          size={16}
          strokeWidth={1.75}
        />
      </span>
      <p className="text-[12px] font-medium">No chat threads yet.</p>
      <p className="max-w-[220px] text-[10.5px] leading-relaxed text-muted-foreground">
        Right-click any suite in the Plans tree → <em>Chat with cases</em>{" "}
        to start a conversation. Threads autosave here.
      </p>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const day = Math.floor(h / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
