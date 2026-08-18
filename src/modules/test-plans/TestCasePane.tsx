import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  adoErrorMessage,
  buildAdoReposWebUrl,
  getCase,
  getConnection,
  toAdoError,
  updateCaseSteps,
  updateWorkItemTitle,
  type AdoError,
  type ConnectionStatus,
  type TestCase,
  type TestStep,
} from "@/modules/ado";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSourceLinks } from "./lib/sourceLinksParser";
import { StepsTable } from "./lib/stepsRenderer";
import {
  Bug01Icon,
  ExternalLink,
  FileScriptIcon,
  Link01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useWorkItemTitles } from "@/modules/ado/hooks/useWorkItemTitles";
import type { LinkedWorkItem, SourceLink } from "@/modules/ado";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceRepo } from "@/modules/settings/store";
import { EditableText } from "@/modules/generator/components/EditableText";
import { OutcomeControl } from "./OutcomeControl";
import { ConfidenceChip } from "./components/ConfidenceChip";
import { ConfidenceDetailPanel } from "./components/ConfidenceDetailPanel";
import { fromTestCase } from "./lib/runConfidenceEval";
import { resolveSuiteRequirement } from "./lib/resolveSuiteRequirement";
import { evaluateCaseConfidence } from "./lib/evaluateCaseConfidence";
import { clearConfidence, getConfidence, saveConfidence } from "./lib/confidenceApi";
import type { ConfidenceVerdict } from "./lib/confidence";
import { useSuiteConfidence } from "./hooks/useSuiteConfidence";

type Props = {
  caseId: number;
  /** Plan + suite the case was opened from, threaded through the tab so the
   *  Execute bar can record a Pass/Fail/Blocked outcome against the right
   *  test point. Null when opened without suite context — the bar then
   *  offers a suite picker. */
  planId?: number | null;
  suiteId?: number | null;
};

export function TestCasePane({ caseId, planId = null, suiteId = null }: Props) {
  // Only used to recognise a source link's `<repo>/` prefix — see
  // `pathWithinRepo`. A machine that doesn't have the repo configured still
  // falls back to the link's own recorded repo name.
  const repos = usePreferencesStore((s) => s.repos);
  const [tc, setTc] = useState<TestCase | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdoError | null>(null);
  const [titleSaveError, setTitleSaveError] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);
  const [stepsSaveError, setStepsSaveError] = useState<string | null>(null);
  const [savingSteps, setSavingSteps] = useState(false);
  // Bumped on every case reload (button + window focus) so the header outcome
  // control re-reads its test point alongside the rest of the case.
  const [reloadKey, setReloadKey] = useState(0);
  // AI confidence verdict for this case (predicted pass + calibrated %).
  const [verdict, setVerdict] = useState<ConfidenceVerdict | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  // Inline confidence detail side panel (opens beside the case, not a new tab).
  const [confidenceOpen, setConfidenceOpen] = useState(false);

  // Live verdict from an in-progress bulk "score all cases" run. When this case
  // is scored mid-run, the store entry appears and the chip updates instantly —
  // no reopen, no SQLite round-trip.
  const liveVerdict = useSuiteConfidence((s) => s.scored.get(caseId));
  useEffect(() => {
    if (liveVerdict) setVerdict(liveVerdict);
  }, [liveVerdict]);

  // True while ANY evaluation owns this case — our own manual re-analyze OR the
  // bulk run currently scoring it. Drives the chip's spinner and blocks a
  // duplicate manual eval.
  const caseInFlight = useSuiteConfidence((s) => s.inFlight.has(caseId));

  // Load any persisted verdict for this case on open (covers tabs opened after
  // a case was scored). Recomputable, so a stale verdict just sits until the
  // user re-evaluates.
  useEffect(() => {
    let alive = true;
    void getConfidence(caseId)
      .then((v) => {
        if (!alive) return;
        // A live verdict that landed during the fetch is fresher — keep it.
        const live = useSuiteConfidence.getState().scored.get(caseId);
        setVerdict(live ?? v);
      })
      .catch(() => {
        if (alive) setVerdict(null);
      });
    return () => {
      alive = false;
    };
  }, [caseId]);

  const evalAbortRef = useRef<AbortController | null>(null);
  const handleEvaluate = useCallback(async () => {
    if (!tc || evaluating) return;
    // Claim the case so a bulk run won't also score it (and vice-versa). If the
    // bulk run already owns it, do nothing — its result will land here live.
    if (!useSuiteConfidence.getState().beginCaseEval(tc.id)) return;
    const ac = new AbortController();
    evalAbortRef.current = ac;
    setEvaluating(true);
    try {
      // A case opened from a requirement-based suite is graded against the
      // acceptance criteria it was written from. Resolved per invocation
      // rather than cached: this fires on an explicit user click, not in a
      // loop, and a stale requirement would be worse than a second request.
      const req = await resolveSuiteRequirement(planId, suiteId);
      const v = await evaluateCaseConfidence(fromTestCase(tc), {
        signal: ac.signal,
        requirement: req.requirement,
        requirementId: req.requirementId,
      });
      setVerdict(v);
      await saveConfidence(tc.id, v).catch(() => undefined);
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== "AbortError") {
        console.error("[confidence] evaluation failed:", e);
      }
    } finally {
      setEvaluating(false);
      evalAbortRef.current = null;
      useSuiteConfidence.getState().endCaseEval(tc.id);
    }
  }, [tc, evaluating, planId, suiteId]);
  const cancelEvaluate = useCallback(() => evalAbortRef.current?.abort(), []);

  // Optimistic title commit: update local state first so the UI feels live,
  // revert on a wire-level failure. ADO's response carries the new System.Title
  // but we already have it locally, so a refetch is unnecessary on success.
  async function commitTitle(next: string): Promise<void> {
    if (!tc) return;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === tc.title) return;
    const previous = tc.title;
    setTc({ ...tc, title: trimmed });
    setTitleSaveError(null);
    setSavingTitle(true);
    try {
      await updateWorkItemTitle(tc.id, trimmed);
    } catch (e) {
      setTc({ ...tc, title: previous });
      setTitleSaveError(adoErrorMessage(toAdoError(e)) || "Failed to save title.");
    } finally {
      setSavingTitle(false);
    }
  }

  // Steps editing: we replace the whole step list in one PATCH (ADO stores
  // steps as a single XML blob). Optimistic update + revert on failure
  // mirrors the title path. A short cooldown blocks the save spam if the
  // user adds + edits + removes rapidly — only the latest commit hits ADO.
  const stepsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function commitSteps(next: TestStep[]): Promise<void> {
    if (!tc) return;
    if (next.length === 0) return; // safety; UI also blocks removing the last
    const previous = tc.steps;
    setTc({ ...tc, steps: next });
    setStepsSaveError(null);
    // A verdict graded against the old steps is now stale — drop it (and its
    // stored copy) so the chip returns to "Evaluate" instead of showing a
    // misleading pass-readiness % the reviewer might act on.
    if (verdict) {
      setVerdict(null);
      void clearConfidence(tc.id).catch(() => undefined);
    }
    if (stepsSaveTimer.current) clearTimeout(stepsSaveTimer.current);
    stepsSaveTimer.current = setTimeout(() => {
      void (async () => {
        setSavingSteps(true);
        try {
          await updateCaseSteps(tc.id, next);
        } catch (e) {
          setTc((curr) => (curr ? { ...curr, steps: previous } : curr));
          setStepsSaveError(
            adoErrorMessage(toAdoError(e)) || "Failed to save steps.",
          );
        } finally {
          setSavingSteps(false);
        }
      })();
    }, 250);
  }

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

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const c = await getCase(caseId);
      setTc(c);
      setError(null);
    } catch (e) {
      setError(toAdoError(e));
    } finally {
      setLoading(false);
      // Re-read the recorded outcome too — a manual Refresh should reflect a
      // Pass/Fail set elsewhere (ADO web, another tab), not just the fields.
      setReloadKey((k) => k + 1);
    }
  }, [caseId]);

  // Resolve linked work-item titles. Called unconditionally so the hook
  // count is stable across render branches (loading / error / loaded).
  const linkedIds = useMemo(
    () => (tc ? tc.linkedWorkItems.map((lwi) => lwi.id) : []),
    [tc],
  );
  const { titleFor, loadingFor, refresh: refreshLinkedTitles } =
    useWorkItemTitles(linkedIds);

  // Refresh on window focus so renames made directly in ADO are picked up
  // when the user tabs back into our app. Skip while a save is in flight
  // (would race with our optimistic update) or while the initial load is
  // still pending. Editor draft state lives inside EditableText, so a
  // background `tc` swap during edit doesn't disturb in-progress typing.
  useEffect(() => {
    const onFocus = () => {
      if (loading || savingTitle) return;
      void reload();
      refreshLinkedTitles();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loading, savingTitle, reload, refreshLinkedTitles]);

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
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border/60 bg-card/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[16px] font-semibold tracking-tight">
            <span className="shrink-0 font-mono text-[12.5px] font-normal text-muted-foreground">
              #{tc.id}
            </span>
            <EditableText
              value={tc.title}
              onCommit={(next) => void commitTitle(next)}
              variant="singleline"
              ariaLabel="Test case title"
              placeholder="(no title — click to edit)"
              className="min-w-0 flex-1 truncate"
            />
          </h1>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Status group: the AI's prediction (pass-readiness) sits beside
                the recorded run outcome — predicted vs. actual — then a divider
                separates them from the utility actions. */}
            <ConfidenceChip
              verdict={verdict}
              loading={evaluating || caseInFlight}
              size="md"
              actionsSide="left"
              onEvaluate={() => void handleEvaluate()}
              onReevaluate={() => void handleEvaluate()}
              // Only show the inline cancel for our own manual eval — when the
              // bulk run owns the case, its capsule carries the cancel.
              onCancel={evaluating ? cancelEvaluate : undefined}
              onOpenDetail={verdict ? () => setConfidenceOpen(true) : undefined}
            />
            <OutcomeControl
              caseId={tc.id}
              planId={planId}
              suiteId={suiteId}
              refreshKey={reloadKey}
            />
            <div
              aria-hidden
              className="mx-0.5 h-5 w-px self-center bg-border/60"
            />
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
        {titleSaveError ? (
          <p className="mt-1.5 rounded-sm border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10.5px] text-destructive">
            Couldn't save the title: {titleSaveError}
          </p>
        ) : null}
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
          <StepsTable
            steps={tc.steps}
            onChange={(next) => void commitSteps(next)}
            disabled={savingSteps}
          />
          {stepsSaveError ? (
            <p className="mt-1 rounded-sm border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10.5px] text-destructive">
              Couldn&apos;t save steps: {stepsSaveError}
            </p>
          ) : null}
        </Section>

        {tc.linkedWorkItems.length > 0 ? (
          <Section title={`Linked work items (${tc.linkedWorkItems.length})`}>
            <ul className="flex flex-col gap-1">
              {tc.linkedWorkItems.map((lwi) => (
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

        <Section title={`Linked source (${links.length})`}>
          {links.length === 0 ? (
            <p className="text-[11.5px] italic text-muted-foreground">
              No source links recorded on this case yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {links.map((l, i) => {
                // The link's own project, because a workspace repo can live in
                // a different ADO project than the connection. Falling back to
                // the connection's is what every pre-binding link meant.
                const project = l.project || conn?.project;
                // `filePath` is recorded in the app's `<repo>/…` addressing
                // form. ADO's `?path=` is relative to the repo ROOT, so the
                // prefix has to come off — left on, every deep link resolves a
                // directory that doesn't exist and the page 404s.
                const filePath = pathWithinRepo(l, repos);
                const webUrl =
                  conn?.orgUrl && project
                    ? buildAdoReposWebUrl({
                        orgUrl: conn.orgUrl,
                        project,
                        // No branch means none was ever stamped. Publish
                        // deliberately records nothing rather than a guessed
                        // default, so the reader must not re-invent one.
                        repoName: l.repoName,
                        branch: l.trackingBranch || undefined,
                        filePath,
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
                      {l.repoName} / {filePath}
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
      {confidenceOpen ? (
        <ConfidenceDetailPanel
          title={tc.title}
          verdict={verdict}
          evaluating={evaluating || caseInFlight}
          onReevaluate={() => void handleEvaluate()}
          onClose={() => setConfidenceOpen(false)}
        />
      ) : null}
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

/**
 * Single row in the linked-work-items list. Surfaces the work item's title
 * inline with its id ("#1234 — Login flow accepts empty password") so a
 * reviewer can scan the relationships without bouncing into ADO. Bug-typed
 * links (Tested by / Tests) get the rose Bug icon + an in-app Open button
 * so the user can drill into the BugPane without a context switch.
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
  // ADO's link types from a test case → other work items mostly come back
  // as "Tested by" (the case tests THIS bug/PBI) or "Tests" (the inverse).
  // We treat both as bug-shaped because that's the dominant pattern in real
  // suites — a parent feature or a sibling PBI shows up as "Parent"/"Related"
  // and gets the neutral chain icon.
  const isLikelyBug = lwi.kind === "Tested by" || lwi.kind === "Tests";

  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11.5px] transition-colors",
        isLikelyBug
          ? "hover:border-rose-500/30 hover:bg-rose-500/[0.04]"
          : "hover:border-primary/30 hover:bg-foreground/[0.04]",
      )}
    >
      {/* Type glyph in a dedicated rail — Bug for bug-shaped links, generic
          chain icon for parent/child/related. Color carries the meaning so
          the kind tag doesn't need to compete for attention. */}
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-sm",
          isLikelyBug
            ? "bg-rose-500/10 text-rose-500 dark:text-rose-400"
            : "bg-foreground/[0.06] text-muted-foreground",
        )}
        aria-hidden
      >
        <HugeiconsIcon
          icon={isLikelyBug ? Bug01Icon : Link01Icon}
          size={11}
          strokeWidth={1.75}
        />
      </span>

      {/* Kind tag + monospace id, packed tight so the title gets the real
          estate. */}
      <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/[0.06] px-1.5 text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {lwi.kind}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/85">
        #{lwi.id}
      </span>

      {/* Title — primary content. Truncate at row width; the tooltip-via-
          title attribute lets a reviewer hover for the full string when it
          gets clipped on narrow panes. */}
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

      {/* Trailing actions: bug links open in-app, everything else goes to
          ADO. The "Open in app" button only appears on hover so the resting
          row stays tidy when the user isn't trying to act on it. */}
      {isLikelyBug ? (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("devops-studio:open-bug", {
                detail: { bugId: lwi.id, title: title ?? undefined },
              }),
            )
          }
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10.5px] text-muted-foreground opacity-0 transition-opacity hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500 focus:opacity-100 group-hover:opacity-100 dark:hover:text-rose-400"
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

/**
 * A source link's path relative to its REPO ROOT, which is the only form ADO's
 * `?path=` (and a human reading the row) accepts.
 *
 * The generator records `filePath` in the app's `<repo>/<path within repo>`
 * addressing form, so the leading segment has to come off. It is recognised two
 * ways, because a published case is read on machines that don't share the
 * publisher's workspace: against the configured repo names (what the AI tools
 * emit), and against the link's own `repo:` — which is that same segment
 * whenever the repo has no ADO binding. An unrecognised leading segment is left
 * alone: it's a real directory, and links published before repo prefixes
 * existed carry no prefix at all.
 */
function pathWithinRepo(link: SourceLink, repos: WorkspaceRepo[]): string {
  const path = link.filePath
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
  const cut = path.indexOf("/");
  if (cut <= 0) return path;
  const head = path.slice(0, cut).toLowerCase();
  const named = link.repoName.trim().toLowerCase();
  const isRepoPrefix =
    named === head ||
    // A configured repo named `head` whose ADO binding is the repo this link
    // NAMES. Both halves matter: the published `repo:` carries the ADO
    // repository name while the prefix carries the workspace folder name, and
    // only the registry connects the two — but matching any configured name
    // would eat a real first directory that merely shares one, silently
    // breaking every legacy link with no prefix at all.
    repos.some(
      (r) =>
        r.name.trim().toLowerCase() === head &&
        r.ado?.repoName.trim().toLowerCase() === named,
    );
  return isRepoPrefix ? path.slice(cut + 1) : path;
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
