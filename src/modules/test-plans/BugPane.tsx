import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  adoErrorMessage,
  getBug,
  getConnection,
  toAdoError,
  type AdoError,
  type Bug,
  type CodeLink,
  type ConnectionStatus,
} from "@/modules/ado";
import { useWorkItemTitles } from "@/modules/ado/hooks/useWorkItemTitles";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { parseCodeLinks, stripCodeLinksBlock } from "./lib/codeLinksParser";
import {
  Bug01Icon,
  ExternalLink,
  FileScriptIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  bugId: number;
  /** Absolute path to the source directory the user picked. Code links are
   *  resolved relative to this when opening in the CodeViewer. */
  sourceRoot?: string | null;
};

export function BugPane({ bugId, sourceRoot }: Props) {
  const [bug, setBug] = useState<Bug | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdoError | null>(null);

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

  async function reload() {
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
  }

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
  const { titleFor, loadingFor } = useWorkItemTitles(linkedIds);

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
          <h1 className="min-w-0 truncate text-[16px] font-semibold tracking-tight">
            <HugeiconsIcon
              icon={Bug01Icon}
              size={14}
              strokeWidth={1.75}
              className="mr-1.5 inline-block -translate-y-0.5 text-rose-500"
            />
            <span className="mr-1.5 font-mono text-[12.5px] font-normal text-muted-foreground">
              #{bug.id}
            </span>
            {bug.title}
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
            dangerouslySetInnerHTML={{
              __html: stripCodeLinksBlock(bug.reproStepsHtml || "<p>—</p>"),
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
                const absPath = resolveAbsPath(sourceRoot ?? null, l.file);
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
                        if (!absPath) return;
                        window.dispatchEvent(
                          new CustomEvent("devops-studio:open-code-viewer", {
                            detail: {
                              path: absPath,
                              startLine: l.startLine,
                              endLine: l.endLine ?? l.startLine,
                            },
                          }),
                        );
                      }}
                      disabled={!absPath}
                      className={cn(
                        "min-w-0 flex-1 truncate text-left font-mono text-foreground/85",
                        absPath
                          ? "hover:text-primary hover:underline"
                          : "cursor-not-allowed opacity-60",
                      )}
                      title={
                        absPath
                          ? "Open in the code viewer"
                          : "Pick a source directory to enable this link"
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
              {bug.linkedWorkItems.map((lwi) => {
                const title = titleFor(lwi.id);
                const isLoading = loadingFor(lwi.id);
                return (
                  <li
                    key={`${lwi.rel}-${lwi.id}`}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/[0.06] px-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {lwi.kind}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      #{lwi.id}
                    </span>
                    {title ? (
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                    ) : isLoading ? (
                      <Skeleton className="h-3 w-32" />
                    ) : (
                      <span className="flex-1 text-[10.5px] italic text-muted-foreground/60">
                        (title unavailable)
                      </span>
                    )}
                    {lwi.webUrl ? (
                      <button
                        type="button"
                        onClick={() => void openUrl(lwi.webUrl)}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                      >
                        <HugeiconsIcon
                          icon={ExternalLink}
                          size={10}
                          strokeWidth={1.75}
                        />
                        ADO
                      </button>
                    ) : null}
                  </li>
                );
              })}
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

/** Join the user-picked sourceRoot with a relative file path from a code link.
 *  Returns null when no sourceRoot is known — the BugPane disables the link
 *  in that case with a helpful tooltip rather than guessing. */
function resolveAbsPath(sourceRoot: string | null, file: string): string | null {
  if (!sourceRoot) return null;
  const trimmedRoot = sourceRoot.replace(/[\\/]+$/, "");
  const trimmedFile = file.replace(/^[\\/]+/, "");
  return `${trimmedRoot}/${trimmedFile}`;
}
