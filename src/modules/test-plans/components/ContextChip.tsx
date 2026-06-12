import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TypeTag } from "@/modules/ado/components/WorkItemMention";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BugIcon,
  DatabaseIcon,
  File01Icon,
  Link01Icon,
  TestTubeIcon,
} from "@hugeicons/core-free-icons";

/** What the suite chat can draw on for this conversation: the in-scope cases,
 *  their linked bugs, every work item the user has #mentioned (any type), and
 *  the best-practice files. Cases/best-practices are recomputed live; the
 *  mentioned set accumulates across the whole thread and is persisted. */
export type SuiteChatScope = {
  cases: { id: number; title: string }[];
  /** Bug ids auto-injected because they're linked to an in-scope case. */
  autoBugIds: number[];
  /** Work items the user #mentioned (any type), accumulated across the thread. */
  mentioned: { id: number; title: string; workItemType: string }[];
  bestPracticeFiles: string[];
  /** Cases that exist in the suite but weren't loaded (hard cap). */
  notLoaded: number;
  caseCap: number;
};

/**
 * Inspectable "what does the chat know?" chip. Replaces a silent cap with a
 * visible, openable scope: the QA tester can see every case and bug the model
 * was handed instead of guessing. Click to open a scrollable popover — capped
 * height so a 50-case suite can't blow past the viewport.
 */
export function ContextChip({
  scope,
  suite,
}: {
  scope: SuiteChatScope;
  /** Suite the chat is scoped to — forwarded when opening a case so the pane
   *  resolves its run outcome instead of showing the suite picker. */
  suite: { planId: number; suiteId: number } | null;
}) {
  // Controlled so a row click (which navigates to another tab) can close the
  // popover — otherwise the portaled content floats over the tab you just
  // jumped to. Radix already closes on outside-click, so switching tabs via
  // the tab bar is covered; this only adds the inside-click case.
  const [open, setOpen] = useState(false);
  const caseCount = scope.cases.length;
  const itemCount = scope.autoBugIds.length + scope.mentioned.length;

  const openCase = (id: number) => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-test-case", {
        detail: {
          caseId: id,
          title: `#${id}`,
          planId: suite?.planId ?? null,
          suiteId: suite?.suiteId ?? null,
        },
      }),
    );
  };
  const openBug = (id: number) => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-bug", {
        detail: { bugId: id, title: `Bug #${id}` },
      }),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:border-border hover:bg-foreground/[0.06] hover:text-foreground"
          title="See exactly which cases and work items the chat was given"
        >
          <HugeiconsIcon icon={DatabaseIcon} size={11} strokeWidth={1.75} />
          <span className="tabular-nums">
            {caseCount} case{caseCount === 1 ? "" : "s"} · {itemCount} item
            {itemCount === 1 ? "" : "s"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-80 max-w-[90vw] p-0"
      >
        <div className="border-b border-border/40 px-3 py-2">
          <p className="text-[11px] font-medium text-foreground">In context</p>
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            What this chat can draw on — cases in scope, their linked bugs, and
            every work item you've #mentioned.
          </p>
        </div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto py-1">
          <Section
            icon={TestTubeIcon}
            label="Cases"
            count={scope.cases.length}
          />
          {scope.cases.map((c) => (
            <Row key={`c-${c.id}`} onClick={() => openCase(c.id)}>
              <span className="font-mono text-primary">#{c.id}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {c.title}
              </span>
            </Row>
          ))}
          {scope.notLoaded > 0 ? (
            <p className="px-3 py-1 text-[10px] text-amber-700 dark:text-amber-300">
              + {scope.notLoaded} more in the suite not loaded (cap{" "}
              {scope.caseCap}). Search to narrow onto the ones you need.
            </p>
          ) : null}

          {scope.autoBugIds.length > 0 ? (
            <>
              <Section
                icon={BugIcon}
                label="Linked bugs"
                count={scope.autoBugIds.length}
                hint="auto-injected from in-scope cases"
              />
              {scope.autoBugIds.map((id) => (
                <Row key={`ab-${id}`} onClick={() => openBug(id)}>
                  <span className="font-mono text-primary">#{id}</span>
                  <span className="truncate text-muted-foreground/70">
                    linked defect
                  </span>
                </Row>
              ))}
            </>
          ) : null}

          {scope.mentioned.length > 0 ? (
            <>
              <Section
                icon={Link01Icon}
                label="Mentioned"
                count={scope.mentioned.length}
                hint="work items you attached with #id"
              />
              {scope.mentioned.map((b) => (
                <Row key={`m-${b.id}`} onClick={() => openBug(b.id)}>
                  <span className="font-mono text-primary">#{b.id}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">
                    {b.title}
                  </span>
                  <TypeTag type={b.workItemType} compact />
                </Row>
              ))}
            </>
          ) : null}

          {scope.bestPracticeFiles.length > 0 ? (
            <>
              <Section
                icon={File01Icon}
                label="Best practices"
                count={scope.bestPracticeFiles.length}
              />
              {scope.bestPracticeFiles.map((f) => (
                <div
                  key={`bp-${f}`}
                  className="flex items-center gap-2 px-3 py-1 text-[10.5px]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
                    {f}
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  icon,
  label,
  count,
  hint,
}: {
  icon: typeof BugIcon;
  label: string;
  count: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 pb-0.5 pt-2">
      <HugeiconsIcon
        icon={icon}
        size={11}
        strokeWidth={1.75}
        className="translate-y-px text-muted-foreground/70"
      />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
        {count}
      </span>
      {hint ? (
        <span className="truncate text-[10px] text-muted-foreground/55">
          · {hint}
        </span>
      ) : null}
    </div>
  );
}

function Row({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1 text-left text-[10.5px] transition-colors hover:bg-foreground/[0.05]",
      )}
    >
      {children}
    </button>
  );
}
