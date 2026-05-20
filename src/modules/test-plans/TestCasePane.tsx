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
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-[12px] text-muted-foreground">
              #{tc.id}
            </span>
            <h1 className="truncate text-[16px] font-semibold tracking-tight">
              {tc.title}
            </h1>
          </div>
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
                <HugeiconsIcon
                  icon={ExternalLink}
                  size={12}
                  strokeWidth={1.75}
                />
                Open in ADO
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          <span>
            State: <span className="text-foreground/85">{tc.state}</span>
          </span>
          {tc.areaPath ? (
            <span>
              Area: <span className="font-mono text-foreground/85">{tc.areaPath}</span>
            </span>
          ) : null}
          {tc.iterationPath ? (
            <span>
              Iteration:{" "}
              <span className="font-mono text-foreground/85">{tc.iterationPath}</span>
            </span>
          ) : null}
        </div>
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
