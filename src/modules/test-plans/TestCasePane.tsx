import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  adoErrorMessage,
  buildAdoReposWebUrl,
  getCase,
  getConnection,
  toAdoError,
  type AdoError,
  type ConnectionStatus,
  type TestCase,
} from "@/modules/ado";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { parseSourceLinks } from "./lib/sourceLinksParser";
import { StepsTable } from "./lib/stepsRenderer";
import {
  ExternalLink,
  FileScriptIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  caseId: number;
};

export function TestCasePane({ caseId }: Props) {
  const [tc, setTc] = useState<TestCase | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdoError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [c, cs] = await Promise.all([getCase(caseId), getConnection()]);
        if (cancelled) return;
        setTc(c);
        setConn(cs);
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
  }, [caseId]);

  async function reload() {
    setLoading(true);
    try {
      const c = await getCase(caseId);
      setTc(c);
      setError(null);
    } catch (e) {
      setError(toAdoError(e));
    } finally {
      setLoading(false);
    }
  }

  if (loading && !tc) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px]">
        <p className="font-medium text-destructive">Couldn't load this case.</p>
        <p className="text-muted-foreground">{adoErrorMessage(error)}</p>
        <Button size="sm" variant="outline" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }
  if (!tc) return null;

  const links = parseSourceLinks(tc.descriptionHtml);
  const adoWebUrl = buildWorkItemWebUrl(conn, tc.id);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-border/60 bg-card/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-[16px] font-semibold tracking-tight">
            <span className="mr-1.5 font-mono text-[12.5px] font-normal text-muted-foreground">
              #{tc.id}
            </span>
            {tc.title}
          </h1>
          <div className="flex shrink-0 gap-1">
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
            {adoWebUrl ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => void openUrl(adoWebUrl)}
              >
                <HugeiconsIcon icon={ExternalLink} size={12} strokeWidth={1.75} />
                Open in ADO
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {buildMetadataInline(tc)}
        </p>
        {tc.tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {tc.tags.map((t) => (
              <span
                key={t}
                className={cn(
                  "rounded-full bg-foreground/[0.06] px-2 py-px text-[10px]",
                  t === "devops-studio:needs-review" &&
                    "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                )}
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <main className="flex flex-col gap-5 px-6 py-5">
        {tc.descriptionHtml ? (
          <Section title="Description">
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
              {htmlToPlain(stripSourceLinksBlock(tc.descriptionHtml))}
            </p>
          </Section>
        ) : null}

        <Section title="Steps">
          <StepsTable steps={tc.steps} />
        </Section>

        {tc.linkedWorkItems.length > 0 ? (
          <Section title={`Linked work items (${tc.linkedWorkItems.length})`}>
            <ul className="flex flex-col gap-1">
              {tc.linkedWorkItems.map((lwi) => {
                // "Tested by" / "Tests" link types most often point at bugs
                // — clicking opens our in-app BugPane via the side channel
                // rather than leaving the app for the ADO web UI.
                const isLikelyBug =
                  lwi.kind === "Tested by" || lwi.kind === "Tests";
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
                    {isLikelyBug ? (
                      <button
                        type="button"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("devops-studio:open-bug", {
                              detail: { bugId: lwi.id },
                            }),
                          )
                        }
                        className="ml-2 inline-flex shrink-0 items-center text-[10.5px] text-muted-foreground hover:text-primary hover:underline"
                      >
                        Open in app
                      </button>
                    ) : null}
                    {lwi.webUrl ? (
                      <button
                        type="button"
                        onClick={() => void openUrl(lwi.webUrl)}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                      >
                        <HugeiconsIcon icon={ExternalLink} size={10} strokeWidth={1.75} />
                        ADO
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}

        <Section title={`Linked source (${links.length})`}>
          {links.length === 0 ? (
            <p className="text-[11.5px] italic text-muted-foreground">
              No source links recorded on this case yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {links.map((l, i) => {
                const webUrl =
                  conn && conn.orgUrl && conn.project
                    ? buildAdoReposWebUrl({
                        orgUrl: conn.orgUrl,
                        project: conn.project,
                        repoName: l.repoName,
                        branch: l.trackingBranch || "main",
                        filePath: l.filePath,
                        lineRange: l.lineRange ?? undefined,
                      })
                    : null;
                return (
                  <li
                    key={`${l.repoName}/${l.filePath}/${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <HugeiconsIcon
                      icon={FileScriptIcon}
                      size={12}
                      strokeWidth={1.75}
                      className="text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
                      {l.repoName} / {l.filePath}
                      {l.symbol ? (
                        <span className="text-muted-foreground"> · {l.symbol}</span>
                      ) : null}
                      {l.lineRange ? (
                        <span className="text-muted-foreground">
                          {" "}
                          ({l.lineRange.start}-{l.lineRange.end})
                        </span>
                      ) : null}
                    </span>
                    {webUrl ? (
                      <button
                        type="button"
                        onClick={() => void openUrl(webUrl)}
                        className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
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
          )}
        </Section>
      </main>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
  caseId: number,
): string | null {
  if (!conn || !conn.orgUrl || !conn.project) return null;
  return `${conn.orgUrl.replace(/\/$/, "")}/${encodeURIComponent(conn.project)}/_workitems/edit/${caseId}`;
}

/**
 * Single-line metadata strip: `State · Priority · Area · Iteration · Assigned · Changed`.
 * Fields with no value are omitted entirely (no `Area: —` clutter).
 * Inline ` · ` separators keep horizontal spacing predictable across screen
 * sizes; the old flex-wrap chip strip was visually noisy and produced large
 * gaps between the label and value.
 */
function buildMetadataInline(tc: TestCase): React.ReactNode {
  const segments: { label: string; value: React.ReactNode }[] = [];
  segments.push({ label: "State", value: tc.state });
  if (tc.priority != null) segments.push({ label: "Priority", value: String(tc.priority) });
  if (tc.areaPath) {
    segments.push({
      label: "Area",
      value: <span className="font-mono">{tc.areaPath}</span>,
    });
  }
  if (tc.iterationPath) {
    segments.push({
      label: "Iteration",
      value: <span className="font-mono">{tc.iterationPath}</span>,
    });
  }
  if (tc.assignedTo) segments.push({ label: "Assigned", value: tc.assignedTo });
  if (tc.changedBy && tc.changedDate) {
    segments.push({
      label: "Updated",
      value: `${formatDate(tc.changedDate)} by ${tc.changedBy}`,
    });
  } else if (tc.changedDate) {
    segments.push({ label: "Updated", value: formatDate(tc.changedDate) });
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

/** Description rendered to the user shouldn't include the source-links block — links get their own section. */
function stripSourceLinksBlock(html: string): string {
  return html.replace(
    /<!-- devops-studio:source-links:v1 -->[\s\S]*?<!-- \/devops-studio:source-links -->/g,
    "",
  );
}

/**
 * ADO returns descriptions as HTML. The typography plugin isn't installed,
 * so we strip tags and decode entities to render as plain text. Links/styling
 * are out of scope for the case detail; full HTML rendering would require
 * pulling in @tailwindcss/typography (deferred — most descriptions are short
 * plain paragraphs in practice).
 */
function htmlToPlain(html: string): string {
  // Convert <br>, </p>, </div>, </li> to line breaks for readable plain text.
  const withBreaks = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  const tagless = withBreaks.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(tagless).replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(s: string): string {
  // Only the entities ADO commonly emits — full HTML5 table would be overkill.
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
