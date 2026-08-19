import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  adoErrorMessage,
  getBug,
  getConnection,
  toAdoError,
  updateWorkItemTitle,
  type AdoError,
  type Bug,
  type CodeLink,
  type ConnectionStatus,
} from "@/modules/ado";
import { useWorkItemTitles } from "@/modules/ado/hooks/useWorkItemTitles";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseCodeLinks, stripCodeLinksBlock } from "./lib/codeLinksParser";
import {
  Bug01Icon,
  ExternalLink,
  FileScriptIcon,
  Link01Icon,
  RefreshIcon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LinkedWorkItem } from "@/modules/ado";
import { EditableText } from "@/modules/generator/components/EditableText";
import { usePreferencesStore } from "@/modules/settings/preferences";

type Props = {
  bugId: number;
};

export function BugPane({ bugId }: Props) {
  // Code links are stored repo-relative; the viewer resolves them. All this
  // needs to know is whether there's anywhere to look.
  const repos = usePreferencesStore((s) => s.repos);
  const [bug, setBug] = useState<Bug | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdoError | null>(null);
  const [titleSaveError, setTitleSaveError] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);

  async function commitTitle(next: string): Promise<void> {
    if (!bug) return;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === bug.title) return;
    const previous = bug.title;
    setBug({ ...bug, title: trimmed });
    setTitleSaveError(null);
    setSavingTitle(true);
    try {
      await updateWorkItemTitle(bug.id, trimmed);
    } catch (e) {
      setBug({ ...bug, title: previous });
      setTitleSaveError(adoErrorMessage(toAdoError(e)) || "Failed to save title.");
    } finally {
      setSavingTitle(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [b, c] = await Promise.all([getBug(bugId), getConnection()]);
        if (cancelled) return;
        setBug(b);
        setConn(c);
      } catch (e) {
        if (cancelled) return;
        setError(toAdoError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bugId]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const b = await getBug(bugId);
      setBug(b);
      setError(null);
    } catch (e) {
      setError(toAdoError(e));
    } finally {
      setLoading(false);
    }
  }, [bugId]);

  const codeLinks = useMemo<CodeLink[]>(
    () => (bug ? parseCodeLinks(bug.reproStepsHtml) : []),
    [bug],
  );

  // Resolve linked work-item titles. Called unconditionally so the hook
  // count is stable across render branches (loading / error / loaded).
  const linkedIds = useMemo(
    () => (bug ? bug.linkedWorkItems.map((lwi) => lwi.id) : []),
    [bug],
  );
  const { titleFor, loadingFor, refresh: refreshLinkedTitles } =
    useWorkItemTitles(linkedIds);

  // Refetch from ADO on window focus so renames / metadata edits made in the
  // ADO web UI show up the next time the user tabs back. Skipped during a
  // save round-trip to avoid stomping the optimistic title update.
  useEffect(() => {
    const onFocus = () => {
      if (loading || savingTitle) return;
      void reload();
      refreshLinkedTitles();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loading, savingTitle, reload, refreshLinkedTitles]);

  if (loading && !bug) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px]">
        <p className="font-medium text-destructive">Couldn't load this bug.</p>
        <p className="text-muted-foreground">{adoErrorMessage(error)}</p>
        <Button size="sm" variant="outline" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }
  if (!bug) return null;

  const webUrl = buildWorkItemWebUrl(conn, bug.id);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-border/60 bg-card/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[16px] font-semibold tracking-tight">
            <HugeiconsIcon
              icon={Bug01Icon}
              size={14}
              strokeWidth={1.75}
              className="shrink-0 translate-y-0.5 text-rose-500"
            />
            <span className="shrink-0 font-mono text-[12.5px] font-normal text-muted-foreground">
              #{bug.id}
            </span>
            <EditableText
              value={bug.title}
              onCommit={(next) => void commitTitle(next)}
              variant="singleline"
              ariaLabel="Bug title"
              placeholder="(no title — click to edit)"
              className="min-w-0 flex-1 truncate"
            />
          </h1>
          <div className="flex shrink-0 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={reload}
                  disabled={loading}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    size={12}
                    strokeWidth={1.75}
                    className={loading ? "animate-spin" : ""}
                  />
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Refetch this bug from Azure DevOps
              </TooltipContent>
            </Tooltip>
            {webUrl ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => void openUrl(webUrl)}
              >
                <HugeiconsIcon icon={ExternalLink} size={12} strokeWidth={1.75} />
                Open in ADO
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {buildMetadataInline(bug)}
        </p>
        {titleSaveError ? (
          <p className="mt-1.5 rounded-sm border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10.5px] text-destructive">
            Couldn't save the title: {titleSaveError}
          </p>
        ) : null}
        {bug.tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {bug.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-foreground/[0.06] px-2 py-px text-[10px]"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <main className="flex flex-col gap-5 px-6 py-5">
        <Section title="Repro steps">
          <div
            className="prose prose-sm max-w-none text-[12.5px] leading-relaxed text-foreground/90 [&_*]:my-0 [&_p]:my-2"
            // ADO repro steps are third-party HTML (anyone on the project can
            // edit a bug) rendered inside a webview with IPC access — sanitize
            // before injecting. The only such site in the app.
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(
                stripCodeLinksBlock(bug.reproStepsHtml || "<p>—</p>"),
              ),
            }}
          />
        </Section>

        <Section title={`Code links (${codeLinks.length})`}>
          {codeLinks.length === 0 ? (
            <p className="text-[11.5px] italic text-muted-foreground">
              No source anchors recorded on this bug yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {codeLinks.map((l, i) => {
                // The viewer resolves `<repo>/<path>` itself (and finds a
                // legacy bare path by searching every repo), so the row hands
                // over what the bug recorded rather than joining it against one
                // repo here — which is how a link naming repo-two used to open
                // repo-one's file, or nothing.
                const canOpen = repos.length > 0;
                return (
                  <li
                    key={`${l.file}:${l.startLine}:${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <HugeiconsIcon
                      icon={FileScriptIcon}
                      size={12}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!canOpen) return;
                        window.dispatchEvent(
                          new CustomEvent("devops-studio:open-code-viewer", {
                            detail: {
                              path: l.file,
                              startLine: l.startLine,
                              endLine: l.endLine ?? l.startLine,
                            },
                          }),
                        );
                      }}
                      disabled={!canOpen}
                      className={cn(
                        "min-w-0 flex-1 truncate text-left font-mono text-foreground/85",
                        canOpen
                          ? "hover:text-primary hover:underline"
                          : "cursor-not-allowed opacity-60",
                      )}
                      title={
                        canOpen
                          ? "Open in the code viewer"
                          : "Add a source repo in Settings to enable this link"
                      }
                    >
                      {l.file}
                      <span className="text-muted-foreground">
                        :{l.startLine}
                        {l.endLine && l.endLine !== l.startLine
                          ? `–${l.endLine}`
                          : ""}
                      </span>
                      {l.commitSha ? (
                        <span className="ml-1 text-[10.5px] text-muted-foreground/80">
                          ({l.commitSha.slice(0, 7)})
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {bug.linkedWorkItems.length > 0 ? (
          <Section title={`Linked work items (${bug.linkedWorkItems.length})`}>
            <ul className="flex flex-col gap-1">
              {bug.linkedWorkItems.map((lwi) => (
                <LinkedItemRow
                  key={`${lwi.rel}-${lwi.id}`}
                  lwi={lwi}
                  title={titleFor(lwi.id)}
                  isLoading={loadingFor(lwi.id)}
                />
              ))}
            </ul>
          </Section>
        ) : null}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Linked work-item row, viewed from a bug. From a bug's perspective the most
 * common case-shaped link types ADO emits are "Tested by" / "Tests" — those
 * point at test cases, so we dispatch open-test-case to land in the app's
 * TestCasePane. Everything else (Parent/Child/Related/etc.) falls back to
 * opening in the ADO web UI.
 */
function LinkedItemRow({
  lwi,
  title,
  isLoading,
}: {
  lwi: LinkedWorkItem;
  title: string | null;
  isLoading: boolean;
}) {
  const isLikelyCase = lwi.kind === "Tested by" || lwi.kind === "Tests";
  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11.5px] transition-colors",
        isLikelyCase
          ? "hover:border-primary/30 hover:bg-primary/[0.04]"
          : "hover:border-border/70 hover:bg-foreground/[0.04]",
      )}
    >
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-sm",
          isLikelyCase
            ? "bg-primary/10 text-primary"
            : "bg-foreground/[0.06] text-muted-foreground",
        )}
        aria-hidden
      >
        <HugeiconsIcon
          icon={isLikelyCase ? TaskDone01Icon : Link01Icon}
          size={11}
          strokeWidth={1.75}
        />
      </span>
      <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/[0.06] px-1.5 text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {lwi.kind}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/85">
        #{lwi.id}
      </span>
      {title ? (
        <span
          className="min-w-0 flex-1 truncate text-foreground/90"
          title={title}
        >
          <span className="mr-1 text-muted-foreground/40">—</span>
          {title}
        </span>
      ) : isLoading ? (
        <span className="min-w-0 flex-1">
          <Skeleton className="h-3 w-40" />
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[10.5px] italic text-muted-foreground/55">
          (title unavailable)
        </span>
      )}
      {isLikelyCase ? (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("devops-studio:open-test-case", {
                detail: { caseId: lwi.id, title: title ?? undefined },
              }),
            )
          }
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10.5px] text-muted-foreground opacity-0 transition-opacity hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          Open in app
        </button>
      ) : null}
      {lwi.webUrl ? (
        <button
          type="button"
          onClick={() => void openUrl(lwi.webUrl)}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-border/60 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <HugeiconsIcon icon={ExternalLink} size={9} strokeWidth={1.75} />
          ADO
        </button>
      ) : null}
    </li>
  );
}

function buildWorkItemWebUrl(
  conn: ConnectionStatus | null,
  bugId: number,
): string | null {
  if (!conn || !conn.orgUrl || !conn.project) return null;
  return `${conn.orgUrl.replace(/\/$/, "")}/${encodeURIComponent(conn.project)}/_workitems/edit/${bugId}`;
}

function buildMetadataInline(bug: Bug): React.ReactNode {
  const segments: { label: string; value: React.ReactNode }[] = [];
  segments.push({ label: "State", value: bug.state });
  if (bug.severity) segments.push({ label: "Severity", value: bug.severity });
  if (bug.priority != null)
    segments.push({ label: "Priority", value: String(bug.priority) });
  if (bug.assignedTo) segments.push({ label: "Assigned", value: bug.assignedTo });
  if (bug.changedBy && bug.changedDate) {
    segments.push({
      label: "Updated",
      value: `${formatDate(bug.changedDate)} by ${bug.changedBy}`,
    });
  } else if (bug.changedDate) {
    segments.push({ label: "Updated", value: formatDate(bug.changedDate) });
  }
  return (
    <>
      {segments.map((s, i) => (
        <span key={s.label}>
          {i > 0 ? <span className="px-1.5 text-muted-foreground/50">·</span> : null}
          <span>
            {s.label}: <span className="text-foreground/85">{s.value}</span>
          </span>
        </span>
      ))}
    </>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
