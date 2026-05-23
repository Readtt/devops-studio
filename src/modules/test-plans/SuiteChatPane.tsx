import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import type {
  AppliedEditRecord,
  ApplyEditResult,
  CaseLookup,
  UndoEditHandler,
} from "@/components/ChatMarkdown";
import {
  adoErrorMessage,
  getConnection,
  toAdoError,
  updateCaseSteps,
  updateWorkItemTitle,
  type ConnectionStatus,
} from "@/modules/ado";
import { MODELS, type ModelId } from "@/modules/ai/config";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  Copy01Icon,
  FolderIcon,
  MessageAdd01Icon,
  RefreshIcon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useSuiteChat } from "./hooks/useSuiteChat";

type Props = {
  planId: number;
  suiteId: number;
};

const SUGGESTED_PROMPTS_WITH_SOURCE = [
  "Are there gaps in coverage for the auth flow?",
  "Which cases are too vague to actually run?",
  "Look at the login code — do my cases match how it returns errors?",
  "If I asked whether these pass, what would you need to know?",
];

const SUGGESTED_PROMPTS_NO_SOURCE = [
  "Are there gaps in coverage for the auth flow?",
  "Which cases are too vague to actually run?",
  "What edge cases am I missing for invalid input?",
  "If I asked whether these pass, what would you need to know?",
];

export function SuiteChatPane({ planId, suiteId }: Props) {
  const state = useSuiteChat((s) => s.byKey.get(`${planId}:${suiteId}`));
  const ensure = useSuiteChat((s) => s.ensure);
  const loadCases = useSuiteChat((s) => s.loadCases);
  const sendMessage = useSuiteChat((s) => s.sendMessage);
  const cancel = useSuiteChat((s) => s.cancel);
  const clearMessages = useSuiteChat((s) => s.clearMessages);
  const dismissError = useSuiteChat((s) => s.dismissError);
  const setModel = useSuiteChat((s) => s.setModel);
  const markEditApplied = useSuiteChat((s) => s.markEditApplied);
  const clearEditApplied = useSuiteChat((s) => s.clearEditApplied);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const globalModelId = useChatStore((s) => s.selectedModelId);
  const availability = useModelAvailability();

  const [draft, setDraft] = useState("");
  const [conn, setConn] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    ensure(planId, suiteId);
    void loadCases(planId, suiteId);
  }, [planId, suiteId, ensure, loadCases]);

  // Pull the ADO connection so case chips can link out to the ADO web UI.
  // Cheap — Tauri command, cached on the Rust side.
  useEffect(() => {
    let cancelled = false;
    void getConnection()
      .then((c) => {
        if (!cancelled) setConn(c);
      })
      .catch(() => {
        if (!cancelled) setConn(null);
      });
    return () => {
      cancelled = true;
    };
  }, [planId, suiteId]);

  const cases = state?.cases ?? null;

  // Single lookup function used by every inline `#case` chip *and* by the
  // ApplyEditCard diff. Cheap O(N) — the suite's case list is capped at 50.
  const lookupCase = useMemo<CaseLookup>(() => {
    return (caseId: number) => {
      const c = cases?.find((x) => x.id === caseId);
      if (!c) return null;
      return {
        title: c.title,
        steps: c.steps.map((s) => ({
          index: s.index,
          action: s.action,
          expected: s.expected,
        })),
        webUrl:
          conn && conn.configured && conn.orgUrl && conn.project
            ? `${conn.orgUrl.replace(/\/$/, "")}/${encodeURIComponent(conn.project)}/_workitems/edit/${caseId}`
            : null,
      };
    };
  }, [cases, conn]);

  // NOTE: handleApplyEdit must be declared BEFORE any conditional early
  // return to keep React's hook order stable across the "state is null"
  // first-render → "state hydrated" second-render transition. Reading
  // `cases` (already nullable) is enough — we don't need the destructured
  // slice fields for this callback.
  const handleApplyEdit = useCallback(async (
    payload: unknown,
  ): Promise<ApplyEditResult> => {
    if (!cases) return { ok: false, message: "Cases haven't finished loading." };
    if (!payload || typeof payload !== "object") {
      return { ok: false, message: "Edit payload is not an object." };
    }
    const p = payload as Record<string, unknown>;
    const kind = typeof p.kind === "string" ? p.kind : null;
    // Tolerate both numeric and string caseId — the model occasionally
    // stringifies. ApplyEditCard already normalizes on its side, this
    // belt-and-suspenders check keeps the handler robust if the card
    // contract ever changes.
    const caseIdRaw = p.caseId;
    const caseId =
      typeof caseIdRaw === "number" && Number.isFinite(caseIdRaw)
        ? caseIdRaw
        : typeof caseIdRaw === "string" && /^\d+$/.test(caseIdRaw.trim())
          ? Number.parseInt(caseIdRaw.trim(), 10)
          : null;
    if (!caseId) {
      return { ok: false, message: "Missing or invalid caseId in edit payload." };
    }
    if (!cases.some((c) => c.id === caseId)) {
      return {
        ok: false,
        message: `Case #${caseId} isn't in the loaded scope — reload cases and try again.`,
      };
    }
    try {
      if (kind === "rename") {
        const title = typeof p.title === "string" ? p.title.trim() : "";
        if (!title) return { ok: false, message: "Empty title — refusing." };
        await updateWorkItemTitle(caseId, title);
        void loadCases(planId, suiteId, true);
        return { ok: true, message: `Title updated on #${caseId}.` };
      }
      if (kind === "rewrite-steps") {
        const raw = Array.isArray(p.steps) ? p.steps : null;
        if (!raw || raw.length === 0) {
          return { ok: false, message: "Step list is empty — refusing." };
        }
        const normalized: { index: number; action: string; expected: string }[] = [];
        for (let i = 0; i < raw.length; i++) {
          const s = raw[i];
          if (!s || typeof s !== "object") continue;
          const obj = s as Record<string, unknown>;
          normalized.push({
            index: i + 1,
            action: typeof obj.action === "string" ? obj.action : "",
            expected: typeof obj.expected === "string" ? obj.expected : "",
          });
        }
        if (normalized.length === 0) {
          return { ok: false, message: "No valid steps in payload." };
        }
        await updateCaseSteps(caseId, normalized);
        void loadCases(planId, suiteId, true);
        return {
          ok: true,
          message: `Replaced ${normalized.length} step${normalized.length === 1 ? "" : "s"} on #${caseId}.`,
        };
      }
      return {
        ok: false,
        message: `Unknown edit kind "${kind}". Supported: rename, rewrite-steps.`,
      };
    } catch (e) {
      // ADO failures are easy to miss when the card just shows "Couldn't
      // apply" — surface the full error to the console so the user can
      // open devtools to diagnose connection / permission issues without
      // needing us to instrument the path further.
      console.error("[suite-chat] apply-to-ADO failed:", e);
      return {
        ok: false,
        message: adoErrorMessage(toAdoError(e)) || String(e),
      };
    }
  }, [cases, loadCases, planId, suiteId]);

  // Inverse of handleApplyEdit — restores a case to the pre-apply snapshot
  // the applied-edit record captured. We don't require the case to still
  // be in the loaded scope: an undo against a since-removed case still
  // hits ADO directly and the cases list re-syncs after.
  const handleUndoEdit = useCallback(async (
    record: AppliedEditRecord,
  ): Promise<ApplyEditResult> => {
    if (!record.before || record.caseId == null) {
      return {
        ok: false,
        message:
          "This edit doesn't carry an undo snapshot — re-apply isn't reversible.",
      };
    }
    const caseId = record.caseId;
    try {
      if (record.before.kind === "rename") {
        await updateWorkItemTitle(caseId, record.before.title);
        void loadCases(planId, suiteId, true);
        return { ok: true, message: `Reverted title on #${caseId}.` };
      }
      if (record.before.kind === "rewrite-steps") {
        const normalized = record.before.steps.map((s, i) => ({
          index: i + 1,
          action: s.action,
          expected: s.expected,
        }));
        if (normalized.length === 0) {
          return {
            ok: false,
            message: "Snapshot has no steps to restore — refusing.",
          };
        }
        await updateCaseSteps(caseId, normalized);
        void loadCases(planId, suiteId, true);
        return {
          ok: true,
          message: `Reverted ${normalized.length} step${normalized.length === 1 ? "" : "s"} on #${caseId}.`,
        };
      }
      return { ok: false, message: "Unsupported undo snapshot kind." };
    } catch (e) {
      console.error("[suite-chat] undo-from-ADO failed:", e);
      return {
        ok: false,
        message: adoErrorMessage(toAdoError(e)) || String(e),
      };
    }
  }, [loadCases, planId, suiteId]);

  if (!state) {
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const {
    casesLoading,
    casesError,
    totalCases,
    truncated,
    suiteName,
    suitePath,
    messages,
    busy,
    error,
    modelId,
  } = state;

  const activeModelId = modelId ?? globalModelId;
  const activeModel = MODELS.find((m) => m.id === activeModelId);
  const sourceLabel = sourceRoot
    ? sourceRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] || sourceRoot
    : null;
  const titleParts = [...suitePath, suiteName ?? `#${suiteId}`];

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !cases) return;
    void sendMessage(planId, suiteId, text);
    setDraft("");
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      <ChatHeader
        titleParts={titleParts}
        cases={cases}
        casesLoading={casesLoading}
        totalCases={totalCases}
        truncated={truncated}
        sourceLabel={sourceLabel}
        sourceRoot={sourceRoot}
        modelId={modelId}
        activeModel={activeModel}
        activeModelId={activeModelId}
        setModel={(id) => setModel(planId, suiteId, id)}
        availabilityFilter={availability.isAvailable}
        onNewThread={() => clearMessages(planId, suiteId)}
        onReloadCases={() => void loadCases(planId, suiteId, true)}
        canNewThread={messages.length > 0 && !busy}
        canReload={!casesLoading}
      />

      {truncated ? (
        <Banner tone="info">
          Showing the first <b>{cases?.length ?? 0}</b> of {totalCases} cases.
          Suite-wide questions may miss content outside this window — narrow
          to specific case ids when accuracy matters.
        </Banner>
      ) : null}
      {casesError ? (
        <Banner tone="error">
          Couldn&apos;t load cases: {adoErrorMessage(casesError)}
        </Banner>
      ) : null}

      <ChatThread
        casesLoading={casesLoading}
        cases={cases}
        suiteName={suiteName}
        messages={messages}
        busy={busy}
        lookupCase={lookupCase}
        onApplyEdit={handleApplyEdit}
        onEditApplied={(messageId, blockHash, record) =>
          markEditApplied(planId, suiteId, messageId, blockHash, record)
        }
        onUndoEdit={handleUndoEdit}
        onEditUndone={(messageId, blockHash) =>
          clearEditApplied(planId, suiteId, messageId, blockHash)
        }
        hasSource={!!sourceRoot}
        onPick={setDraft}
        assistantProvider={activeModel?.provider ?? null}
      />

      {error ? (
        <div className="flex items-start gap-1.5 border-t border-destructive/30 bg-destructive/[0.06] px-5 py-1.5 text-[11px] text-destructive">
          <span className="flex-1">{error}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => dismissError(planId, suiteId)}
                className="text-[10.5px] underline-offset-2 hover:underline"
              >
                dismiss
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Hide this error banner
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <Composer
        draft={draft}
        onChange={setDraft}
        onSubmit={submit}
        onCancel={() => cancel(planId, suiteId)}
        busy={busy}
        disabled={casesLoading || !cases}
        hint={
          cases
            ? "Ask about these cases…  (Enter to send · Shift+Enter for newline)"
            : "Loading cases…"
        }
        sourceLabel={sourceLabel}
        modelLabel={activeModel?.label ?? activeModelId}
        sourceMissing={!sourceRoot}
        onOpenSettings={() => void openSettingsWindow("general")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ChatHeader({
  titleParts,
  cases,
  casesLoading,
  totalCases,
  truncated,
  sourceLabel,
  sourceRoot,
  modelId,
  activeModel,
  activeModelId,
  setModel,
  availabilityFilter,
  onNewThread,
  onReloadCases,
  canNewThread,
  canReload,
}: {
  titleParts: string[];
  cases: { id: number }[] | null;
  casesLoading: boolean;
  totalCases: number;
  truncated: boolean;
  sourceLabel: string | null;
  sourceRoot: string | null;
  modelId: ModelId | null;
  activeModel: { label: string } | undefined;
  activeModelId: ModelId;
  setModel: (id: ModelId | null) => void;
  availabilityFilter: (id: ModelId) => boolean;
  onNewThread: () => void;
  onReloadCases: () => void;
  canNewThread: boolean;
  canReload: boolean;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 bg-card/30 px-5 py-3 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
            <HugeiconsIcon
              icon={FolderIcon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0 text-foreground/70"
            />
            <span className="min-w-0 truncate">
              {titleParts.map((p, i) => (
                <span key={i}>
                  {i > 0 ? (
                    <span className="mx-1.5 text-muted-foreground/40">›</span>
                  ) : null}
                  <span
                    className={
                      i === titleParts.length - 1 ? "" : "text-muted-foreground"
                    }
                  >
                    {p}
                  </span>
                </span>
              ))}
            </span>
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ModelPicker
            value={activeModelId}
            onChange={(id) => setModel(id)}
            filter={(id) => availabilityFilter(id)}
            align="end"
            side="bottom"
            // The trigger render-prop is ALREADY wrapped in a <button> by
            // ModelPicker itself (PopoverTrigger asChild → button). We must
            // return a non-button element here, otherwise React 19 warns
            // about nested buttons. Use a span styled to look like a chip,
            // with the `title` attribute as the calm hover hint — Tooltip
            // would re-wrap us in another button and re-trigger the nesting.
            trigger={({ label, provider }) => (
              <span
                title={
                  modelId
                    ? "Model pinned for this chat — click to change or unset."
                    : `Inherits the global model (${activeModel?.label ?? activeModelId}). Click to pin a different model for this chat only.`
                }
                className="inline-flex h-7 max-w-[180px] items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/60 px-2 text-[11px] text-foreground/85 hover:bg-foreground/[0.04]"
              >
                <ProviderIcon provider={provider} className="size-3" />
                <span className="truncate">{label}</span>
                {modelId ? (
                  <span className="ml-0.5 rounded-sm bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
                    pin
                  </span>
                ) : null}
              </span>
            )}
            footer={
              modelId ? (
                <button
                  type="button"
                  onClick={() => setModel(null)}
                  className="w-full px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-foreground/[0.04]"
                >
                  Unpin — inherit global default
                </button>
              ) : undefined
            }
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="New thread"
                onClick={onNewThread}
                disabled={!canNewThread}
              >
                <HugeiconsIcon
                  icon={MessageAdd01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Start a new thread (drops the current conversation; cases stay loaded)
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Reload cases"
                onClick={onReloadCases}
                disabled={!canReload}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.75}
                  className={!canReload ? "animate-spin" : ""}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Re-fetch every case in this suite from Azure DevOps
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1">
              {casesLoading ? (
                "Loading cases…"
              ) : cases ? (
                <>
                  <span className="font-medium text-foreground/85">
                    {cases.length}
                  </span>{" "}
                  case{cases.length === 1 ? "" : "s"}
                  {truncated ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {" "}
                      of {totalCases}
                    </span>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {truncated
              ? `Loaded the first ${cases?.length ?? 0} of ${totalCases} cases — suite-wide questions may miss content beyond this window.`
              : `Number of cases currently fed into the chat as context.`}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                sourceLabel
                  ? "text-foreground/85"
                  : "text-amber-700 dark:text-amber-300",
              )}
            >
              {sourceLabel ? (
                <>
                  code grounding:{" "}
                  <span className="font-mono">{sourceLabel}</span>
                </>
              ) : (
                "code grounding off"
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {sourceLabel
              ? `Source directory set — the model can read code to verify cases.`
              : `No source dir — pick one in Preferences to enable code-grounded answers.`}
          </TooltipContent>
        </Tooltip>
        {!sourceRoot ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void openSettingsWindow("general")}
                className="h-5 gap-1 px-1.5 text-[10.5px] text-primary"
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  size={10}
                  strokeWidth={1.75}
                />
                set
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Pick a source directory to enable code-grounded answers
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  appliedEdits?: Record<string, AppliedEditRecord>;
};

function ChatThread({
  casesLoading,
  cases,
  suiteName,
  messages,
  busy,
  lookupCase,
  onApplyEdit,
  onEditApplied,
  onUndoEdit,
  onEditUndone,
  hasSource,
  onPick,
  assistantProvider,
}: {
  casesLoading: boolean;
  cases: { id: number }[] | null;
  suiteName: string | null;
  messages: Msg[];
  busy: boolean;
  lookupCase: CaseLookup;
  onApplyEdit: (payload: unknown) => Promise<ApplyEditResult>;
  onEditApplied: (
    messageId: string,
    blockHash: string,
    record: AppliedEditRecord,
  ) => void;
  onUndoEdit: UndoEditHandler;
  onEditUndone: (messageId: string, blockHash: string) => void;
  hasSource: boolean;
  onPick: (prompt: string) => void;
  assistantProvider: import("@/modules/ai/config").ProviderId | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Persistent "stick to bottom" intent. Starts true; flips to false the
  // moment the user scrolls UP, flips back to true when they reach the
  // bottom again (or click the jump pill).
  const stickRef = useRef(true);
  const [showPill, setShowPill] = useState(false);
  const rafRef = useRef<number | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = containerRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    stickRef.current = true;
    setShowPill(false);
  }, []);

  // Detect "near bottom" using a sentinel + IntersectionObserver. This is
  // both cheaper and more reliable than computing scroll math on every
  // mutation — the observer fires exactly when the sentinel enters/leaves
  // the viewport, which is the thing we actually care about.
  useEffect(() => {
    const root = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        const atBottom = entry.isIntersecting;
        if (atBottom) {
          stickRef.current = true;
          setShowPill(false);
        } else {
          // Hide pill until the user has actually drifted away from the bottom.
          setShowPill(true);
        }
      },
      { root, threshold: 0, rootMargin: "0px 0px 64px 0px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, []);

  // Wheel / touch listener so any UP gesture immediately releases the
  // stick-to-bottom intent — without waiting for the observer to fire.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") {
        stickRef.current = false;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  // Re-stick on every render that mutated content. Uses rAF so we run AFTER
  // the layout — otherwise the new tokens haven't expanded scrollHeight yet.
  const lastContent = messages.map((m) => m.content.length).join(",");
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [lastContent, messages.length, busy]);

  // Resize observer — the thread also has to follow when its own height
  // shrinks (composer grows, an error banner appears) while sticking.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      tabIndex={-1}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-5">
        {casesLoading && !cases ? (
          <CaseLoadingShimmer />
        ) : cases && cases.length === 0 ? (
          <EmptySuiteHint suiteName={suiteName} />
        ) : messages.length === 0 ? (
          <Onboarding
            hasCases={cases !== null && cases.length > 0}
            hasSource={hasSource}
            onPick={onPick}
          />
        ) : null}

        {messages.map((m, idx) => (
          <MessageBubble
            key={m.id}
            role={m.role}
            content={m.content}
            streaming={busy && m.role === "assistant" && idx === messages.length - 1}
            lookupCase={lookupCase}
            onApplyEdit={onApplyEdit}
            appliedEdits={m.appliedEdits}
            onEditApplied={(blockHash, record) =>
              onEditApplied(m.id, blockHash, record)
            }
            onUndoEdit={onUndoEdit}
            onEditUndone={(blockHash) => onEditUndone(m.id, blockHash)}
            assistantProvider={assistantProvider}
          />
        ))}
        <div ref={sentinelRef} aria-hidden className="h-1 w-full" />
      </div>

      {showPill ? (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          className={cn(
            "pointer-events-auto absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-card/95 px-3 py-1 text-[11px] font-medium text-foreground shadow-lg backdrop-blur-sm transition-all hover:bg-foreground/[0.04]",
            busy && "border-primary/35 text-primary",
          )}
          aria-label="Jump to latest message"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={1.75}
          />
          {busy ? "Streaming · jump to latest" : "Jump to latest"}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function MessageBubble({
  role,
  content,
  streaming,
  lookupCase,
  onApplyEdit,
  appliedEdits,
  onEditApplied,
  onUndoEdit,
  onEditUndone,
  assistantProvider,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  lookupCase: CaseLookup;
  onApplyEdit: (payload: unknown) => Promise<ApplyEditResult>;
  appliedEdits?: Record<string, AppliedEditRecord>;
  onEditApplied: (blockHash: string, record: AppliedEditRecord) => void;
  onUndoEdit: UndoEditHandler;
  onEditUndone: (blockHash: string) => void;
  assistantProvider: import("@/modules/ai/config").ProviderId | null;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      // ignore
    }
  };
  const wordCount = useMemo(() => {
    return content.trim() ? content.trim().split(/\s+/).length : 0;
  }, [content]);

  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="group/msg relative max-w-[80%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[12px] leading-[1.55] text-foreground">
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border/60 bg-card/80 text-foreground/70">
        {assistantProvider ? (
          <ProviderIcon provider={assistantProvider} size={11} />
        ) : (
          <HugeiconsIcon
            icon={BubbleChatIcon}
            size={11}
            strokeWidth={1.75}
          />
        )}
      </div>
      <div className="group/msg relative min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border/45 bg-card/55 px-3.5 py-2.5">
        {content ? (
          <ChatMarkdown
            source={content}
            lookupCase={lookupCase}
            onApplyEdit={onApplyEdit}
            streaming={streaming}
            appliedEdits={appliedEdits}
            onEditApplied={onEditApplied}
            onUndoEdit={onUndoEdit}
            onEditUndone={onEditUndone}
          />
        ) : streaming ? (
          <StreamingPlaceholder />
        ) : (
          <p className="text-[11.5px] italic text-muted-foreground">
            (empty response)
          </p>
        )}

        {!streaming && content ? (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onCopy}
                  aria-label="Copy message"
                  className={cn(
                    "grid size-5 place-items-center rounded-sm transition-colors",
                    copied
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={copied ? Tick02Icon : Copy01Icon}
                    size={10}
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                {copied ? "Copied" : `Copy reply (${wordCount} words)`}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StreamingPlaceholder() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.18s]" />
      <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.36s]" />
      <span className="ml-1">Reading the suite…</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  disabled,
  hint,
  sourceLabel,
  sourceMissing,
  modelLabel,
  onOpenSettings,
}: {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled: boolean;
  hint: string;
  sourceLabel: string | null;
  sourceMissing: boolean;
  modelLabel: string;
  onOpenSettings: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  // Composer chrome matches the rest of the app: shadcn-style rounded-md
  // border, h-8 controls, 12px body text. No leading icon — it was throwing
  // off the textarea baseline. Send/Cancel buttons live on the right rail
  // and align bottom so the surface grows up as the user types.
  return (
    <div className="shrink-0 border-t border-border/40 bg-card/40 px-5 py-3">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            "group relative flex items-end gap-2 rounded-md border border-border/60 bg-input/40 px-2.5 py-1.5 transition-colors",
            "focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/25",
            busy && "border-primary/35 bg-primary/[0.03]",
          )}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={hint}
            className="min-h-[20px] w-full resize-none bg-transparent py-1 text-[12px] leading-[1.55] outline-none placeholder:text-muted-foreground/55"
          />
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Cancel response"
                  onClick={onCancel}
                  className="shrink-0 text-destructive hover:bg-destructive/15"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Stop the response in flight
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  aria-label="Send message"
                  onClick={onSubmit}
                  disabled={!draft.trim() || disabled}
                  className="shrink-0"
                >
                  <HugeiconsIcon
                    icon={ArrowUp01Icon}
                    size={13}
                    strokeWidth={2}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Send · Enter
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-[10px] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd>
            send
          </span>
          <Dot />
          <span className="inline-flex items-center gap-1">
            <Kbd>⇧↵</Kbd>
            newline
          </span>
          <Dot />
          <span className="truncate">
            <span className="text-muted-foreground/70">model</span>{" "}
            <span className="font-medium text-foreground/85">{modelLabel}</span>
          </span>
          {sourceMissing ? (
            <>
              <Dot />
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-1 text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  size={9}
                  strokeWidth={1.75}
                />
                set source dir
              </button>
            </>
          ) : sourceLabel ? (
            <>
              <Dot />
              <span className="inline-flex items-center gap-1 truncate">
                <span className="text-muted-foreground/70">code:</span>
                <span className="truncate font-mono text-foreground/70">
                  {sourceLabel}
                </span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side widgets
// ---------------------------------------------------------------------------

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
}) {
  if (tone === "error") {
    return (
      <div className="shrink-0 border-b border-destructive/30 bg-destructive/[0.06] px-5 py-2 text-[11px] text-destructive">
        {children}
      </div>
    );
  }
  return (
    <div className="shrink-0 border-b border-border/40 bg-foreground/[0.03] px-5 py-1.5 text-[10.5px] text-muted-foreground">
      {children}
    </div>
  );
}

function CaseLoadingShimmer() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

function EmptySuiteHint({ suiteName }: { suiteName: string | null }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-4 py-4 text-[12px] leading-relaxed text-muted-foreground">
      No cases in{" "}
      <span className="font-medium text-foreground/90">
        {suiteName ?? "this suite"}
      </span>{" "}
      yet — generate some from the suite&apos;s context menu, then come back
      here to chat about them.
    </div>
  );
}

function Onboarding({
  hasCases,
  hasSource,
  onPick,
}: {
  hasCases: boolean;
  hasSource: boolean;
  onPick: (prompt: string) => void;
}) {
  if (!hasCases) return null;
  const prompts = hasSource
    ? SUGGESTED_PROMPTS_WITH_SOURCE
    : SUGGESTED_PROMPTS_NO_SOURCE;
  return (
    <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-4">
      <p className="text-[13px] font-medium text-foreground/90">
        Ask about this suite.
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        The full case list is in scope.
        {hasSource
          ? " Source directory is set — answers can reference real code."
          : " No source dir yet — answers will be limited to case-definition review."}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-full border border-border/50 bg-background/60 px-2.5 py-1 text-[10.5px] text-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
