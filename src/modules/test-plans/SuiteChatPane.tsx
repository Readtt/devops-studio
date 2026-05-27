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
import { ENTER_KEY, SHIFT_KEY, fmtShortcut } from "@/lib/platform";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  AttachButton,
  AttachmentDropZone,
  AttachmentList,
  useAttachments,
  type Attachment,
} from "@/components/chat/attachments";
import {
  MentionDropdown,
  WorkItemChips,
  useWorkItemMention,
  type WorkItemMention,
} from "@/modules/ado/components/WorkItemMention";
import { useBugContext } from "@/modules/ado/hooks/useBugContext";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  AppliedEditRecord,
  ApplyEditResult,
  BugLookup,
  CaseLookup,
  UndoEditHandler,
} from "@/components/ChatMarkdown";
import {
  adoErrorMessage,
  createBug,
  createBugAndLink,
  createCaseInSuite,
  deleteBug,
  deleteTestCase,
  EXECUTION_OUTCOMES,
  getBug,
  getConnection,
  linkBugToCase,
  listTestPoints,
  setTestPointOutcome,
  toAdoError,
  updateBug,
  updateCaseSteps,
  updateWorkItemTitle,
  type ConnectionStatus,
  type ExecutionOutcome,
} from "@/modules/ado";
import { stripHtml } from "@/modules/ado/lib/bugContextBlock";
import { MODELS, type ModelId } from "@/modules/ai/config";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowTurnUpIcon,
  BubbleChatIcon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  FolderIcon,
  MessageAdd01Icon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useSuiteChat } from "./hooks/useSuiteChat";

type Props = {
  planId: number;
  suiteId: number;
  /** Optional thread to activate on mount. When set, this tab is pinned
   *  to one specific conversation on the suite (typically because the
   *  user opened it from the chat-history sidebar). Without this prop
   *  the pane follows whatever thread is currently active for the
   *  suite — useful when the tab was opened from the suite tree and
   *  the user just wants "the chat on this suite". */
  boundThreadId?: string | null;
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

export function SuiteChatPane({ planId, suiteId, boundThreadId }: Props) {
  const suiteKey = `${planId}:${suiteId}`;
  const suite = useSuiteChat((s) => s.bySuite.get(suiteKey));
  const activeThreadId = useSuiteChat(
    (s) => s.activeThreadBySuite.get(suiteKey) ?? "default",
  );
  const thread = useSuiteChat((s) =>
    s.byThread.get(`${planId}:${suiteId}:${activeThreadId}`),
  );
  const threadList = useSuiteChat((s) => s.threadListBySuite.get(suiteKey));
  const ensure = useSuiteChat((s) => s.ensure);
  const loadCases = useSuiteChat((s) => s.loadCases);
  const sendMessage = useSuiteChat((s) => s.sendMessage);
  const cancel = useSuiteChat((s) => s.cancel);
  const dismissError = useSuiteChat((s) => s.dismissError);
  const setModel = useSuiteChat((s) => s.setModel);
  const setFilter = useSuiteChat((s) => s.setFilter);
  const markEditApplied = useSuiteChat((s) => s.markEditApplied);
  const clearEditApplied = useSuiteChat((s) => s.clearEditApplied);
  const newThread = useSuiteChat((s) => s.newThread);
  const setActiveThread = useSuiteChat((s) => s.setActiveThread);
  const deleteThread = useSuiteChat((s) => s.deleteThread);
  const renameThread = useSuiteChat((s) => s.renameThread);
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const globalModelId = useChatStore((s) => s.selectedModelId);
  const availability = useModelAvailability();

  const [draft, setDraft] = useState("");
  const att = useAttachments();
  const bugCtx = useBugContext();
  const mention = useWorkItemMention({
    value: draft,
    onValueChange: setDraft,
    onAdd: bugCtx.add,
    selectedIds: bugCtx.selected.map((b) => b.id),
  });
  const [conn, setConn] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    ensure(planId, suiteId);
    void loadCases(planId, suiteId);
  }, [planId, suiteId, ensure, loadCases]);

  // If the tab is bound to a specific thread (the user opened this tab
  // from the chat-history sidebar, or it was restored from localStorage
  // after a reload), activate that thread once the suite slice is
  // hydrated.
  //
  // Concurrency: the activation is guarded by a one-shot ref so it runs
  // exactly once per (tabId, boundThreadId) combination. The `suite`
  // selector returns a NEW object reference every time loadCases calls
  // patchSuite (which spreads ...curr into a fresh slice), and an effect
  // keyed on `suite` would re-run on every one of those updates. Without
  // the guard, the second-render setActiveThread call (with activeThreadId
  // still reading stale state via the snapshot React captured) could fire
  // in a tight loop and feed back into Radix's compose-refs on consumers
  // that re-render off the same store — the "Maximum update depth"
  // failure mode the user hit.
  const activatedBoundThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!boundThreadId) return;
    if (!suite) return; // wait for ensure() to land the suite slice
    if (activatedBoundThreadRef.current === boundThreadId) return;
    activatedBoundThreadRef.current = boundThreadId;
    // Read activeThreadId imperatively here so the effect doesn't depend
    // on a value that this very effect mutates — that's the dep cycle
    // that produces the render storm.
    const current = useSuiteChat
      .getState()
      .activeThreadBySuite.get(`${planId}:${suiteId}`);
    if (current === boundThreadId) return;
    setActiveThread(planId, suiteId, boundThreadId);
  }, [boundThreadId, suite, planId, suiteId, setActiveThread]);

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

  const cases = suite?.cases ?? null;

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
        // Every case in this lookup belongs to the suite being chatted, so
        // opening one carries the suite context — its Execute control lands
        // ready instead of asking the user to pick a suite.
        suite: { planId, suiteId },
      };
    };
  }, [cases, conn]);

  // Bug edits (create/update/delete-bug) diff against the bug's live ADO state.
  // Bugs aren't in the suite's case cache, so this reads them on demand — the
  // card only calls it when the user expands a bug edit's diff.
  const fetchBug = useCallback<BugLookup>(async (bugId: number) => {
    try {
      const b = await getBug(bugId);
      return {
        id: b.id,
        title: b.title,
        state: b.state ?? null,
        severity: b.severity ?? null,
        reproText: stripHtml(b.reproStepsHtml) || null,
      };
    } catch {
      return null;
    }
  }, []);

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

    const toNum = (raw: unknown): number | null =>
      typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw.trim())
          ? Number.parseInt(raw.trim(), 10)
          : null;
    const normalizeSeverity = (
      raw: unknown,
    ): "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low" => {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s.startsWith("1")) return "1 - Critical";
      if (s.startsWith("2")) return "2 - High";
      if (s.startsWith("4")) return "4 - Low";
      return "3 - Medium";
    };

    // --- Bug operations: target a bugId (or create a new bug), so handle them
    // before the caseId validation that the case kinds go through below. ---
    if (kind === "create-bug") {
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) return { ok: false, message: "Empty bug title — refusing to create." };
      const reproSteps = typeof p.reproSteps === "string" ? p.reproSteps : "";
      const severity = normalizeSeverity(p.severity);
      const linkCaseId = toNum(p.linkCaseId);
      try {
        const draft = { title, reproSteps, severity, codeLinks: [] };
        const result = linkCaseId
          ? await createBugAndLink(linkCaseId, draft)
          : await createBug(draft);
        if (linkCaseId) void loadCases(planId, suiteId, true);
        return {
          ok: true,
          message: linkCaseId
            ? `Created bug #${result.id} and linked it to #${linkCaseId}.`
            : `Created bug #${result.id}.`,
          before: { kind: "create-bug", bugId: result.id },
        };
      } catch (e) {
        console.error("[suite-chat] create-bug failed:", e);
        return { ok: false, message: adoErrorMessage(toAdoError(e)) || String(e) };
      }
    }
    if (kind === "update-bug") {
      const bugId = toNum(p.bugId);
      if (!bugId) return { ok: false, message: "Missing bugId — cannot update." };
      const title = typeof p.title === "string" ? p.title : undefined;
      const reproSteps = typeof p.reproSteps === "string" ? p.reproSteps : undefined;
      const severity = typeof p.severity === "string" ? p.severity : undefined;
      const state = typeof p.state === "string" ? p.state : undefined;
      if (title == null && reproSteps == null && severity == null && state == null) {
        return { ok: false, message: "No fields to update on the bug." };
      }
      try {
        // Snapshot the prior scalar fields so the update is reversible. The
        // suite-chat case cache doesn't track bugs, so we read the bug here.
        let before:
          | { kind: "update-bug"; bugId: number; title?: string; severity?: string; state?: string }
          | undefined;
        try {
          const prev = await getBug(bugId);
          before = {
            kind: "update-bug",
            bugId,
            ...(title != null ? { title: prev.title } : {}),
            ...(severity != null ? { severity: prev.severity ?? undefined } : {}),
            ...(state != null ? { state: prev.state } : {}),
          };
        } catch {
          // Best-effort snapshot — undo simply won't be offered without it.
        }
        await updateBug({ bugId, title, reproSteps, severity, state });
        return { ok: true, message: `Updated bug #${bugId}.`, before };
      } catch (e) {
        console.error("[suite-chat] update-bug failed:", e);
        return { ok: false, message: adoErrorMessage(toAdoError(e)) || String(e) };
      }
    }
    if (kind === "delete-bug") {
      const bugId = toNum(p.bugId);
      if (!bugId) return { ok: false, message: "Missing bugId — cannot delete." };
      try {
        await deleteBug({ bugId });
        return {
          ok: true,
          message: `Moved bug #${bugId} to the Recycle Bin (recoverable in ADO for 30 days).`,
        };
      } catch (e) {
        console.error("[suite-chat] delete-bug failed:", e);
        return { ok: false, message: adoErrorMessage(toAdoError(e)) || String(e) };
      }
    }
    if (kind === "link-bug-to-case") {
      const bugId = toNum(p.bugId);
      const linkCase = toNum(p.caseId);
      if (!bugId || !linkCase) {
        return { ok: false, message: "Need both a bugId and a caseId to link." };
      }
      try {
        await linkBugToCase(bugId, linkCase);
        void loadCases(planId, suiteId, true);
        return { ok: true, message: `Linked bug #${bugId} to case #${linkCase}.` };
      } catch (e) {
        console.error("[suite-chat] link-bug-to-case failed:", e);
        return { ok: false, message: adoErrorMessage(toAdoError(e)) || String(e) };
      }
    }

    // create-case is the only kind that doesn't require a target caseId
    // — the case doesn't exist yet. Handle it first and short-circuit
    // before the caseId validation below kicks in.
    if (kind === "create-case") {
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) return { ok: false, message: "Empty title — refusing to create." };
      const rawSteps = Array.isArray(p.steps) ? p.steps : null;
      if (!rawSteps || rawSteps.length === 0) {
        return { ok: false, message: "No steps in proposal — refusing to create." };
      }
      const steps = rawSteps
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s, i) => ({
          index: i + 1,
          action: typeof s.action === "string" ? s.action : "",
          expected: typeof s.expected === "string" ? s.expected : "",
        }));
      try {
        const result = await createCaseInSuite(planId, suiteId, {
          title,
          description: "",
          steps,
          tags: [],
        });
        void loadCases(planId, suiteId, true);
        return {
          ok: true,
          message: `Created #${result.id} in this suite.`,
        };
      } catch (e) {
        console.error("[suite-chat] create-case failed:", e);
        return {
          ok: false,
          message: adoErrorMessage(toAdoError(e)) || String(e),
        };
      }
    }

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
      if (kind === "delete-case") {
        try {
          await deleteTestCase({ caseId });
          void loadCases(planId, suiteId, true);
          return {
            ok: true,
            message: `Moved #${caseId} to the Recycle Bin (recoverable in ADO for 30 days).`,
          };
        } catch (e) {
          console.error("[suite-chat] delete-case failed:", e);
          return {
            ok: false,
            message: adoErrorMessage(toAdoError(e)) || String(e),
          };
        }
      }
      if (kind === "set-outcome") {
        const outcome = typeof p.outcome === "string" ? p.outcome : "";
        if (!(EXECUTION_OUTCOMES as readonly string[]).includes(outcome)) {
          return {
            ok: false,
            message: `Unsupported outcome "${outcome}". Expected Passed, Failed, Blocked, NotApplicable, or Active.`,
          };
        }
        // Outcomes live on the test point — resolve it from this suite. The
        // chat has no config picker, so we record against the first point
        // (the default configuration) and note it when more exist.
        const pts = await listTestPoints(planId, suiteId, caseId);
        if (pts.length === 0) {
          return {
            ok: false,
            message: `#${caseId} has no runnable test point in this suite — can't record an outcome.`,
          };
        }
        const point = pts[0];
        await setTestPointOutcome({
          planId,
          suiteId,
          pointId: point.id,
          caseId,
          outcome: outcome as ExecutionOutcome,
        });
        void loadCases(planId, suiteId, true);
        const suffix =
          pts.length > 1
            ? ` (default configuration — ${pts.length} configs exist; set the others from the case's Execute bar)`
            : "";
        return {
          ok: true,
          message: `Recorded #${caseId} as ${outcome}${suffix}.`,
        };
      }
      return {
        ok: false,
        message: `Unknown edit kind "${kind}". Supported: rename, rewrite-steps, create-case, delete-case, set-outcome.`,
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
    if (!record.before) {
      return {
        ok: false,
        message:
          "This edit doesn't carry an undo snapshot — re-apply isn't reversible.",
      };
    }
    const before = record.before;
    try {
      // Bug snapshots target a bugId, not a caseId.
      if (before.kind === "create-bug") {
        await deleteBug({ bugId: before.bugId });
        return {
          ok: true,
          message: `Deleted bug #${before.bugId} (the one this edit created).`,
        };
      }
      if (before.kind === "update-bug") {
        await updateBug({
          bugId: before.bugId,
          title: before.title,
          severity: before.severity,
          state: before.state,
        });
        return { ok: true, message: `Reverted bug #${before.bugId}.` };
      }
      // Case snapshots need the target case id.
      if (record.caseId == null) {
        return { ok: false, message: "Undo snapshot is missing its target case." };
      }
      const caseId = record.caseId;
      if (before.kind === "rename") {
        await updateWorkItemTitle(caseId, before.title);
        void loadCases(planId, suiteId, true);
        return { ok: true, message: `Reverted title on #${caseId}.` };
      }
      if (before.kind === "rewrite-steps") {
        const normalized = before.steps.map((s, i) => ({
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

  if (!suite || !thread) {
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
    filter,
  } = suite;
  const { messages, busy, error, modelId } = thread;

  const activeModelId = modelId ?? globalModelId;
  const activeModel = MODELS.find((m) => m.id === activeModelId);
  const titleParts = [...suitePath, suiteName ?? `#${suiteId}`];
  // How many cases the model will actually see after the filter is applied —
  // gives the user instant feedback when they narrow scope on a big suite.
  const scopedCount = (() => {
    if (!cases) return 0;
    const needle = filter.trim().toLowerCase();
    if (!needle) return cases.length;
    const idMatch = needle.match(/^#(\d+)$/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      return cases.filter((c) => c.id === id).length;
    }
    return cases.filter((c) => {
      if (String(c.id).includes(needle)) return true;
      if (c.title.toLowerCase().includes(needle)) return true;
      if (c.tags.some((t) => t.toLowerCase().includes(needle))) return true;
      return c.steps.some(
        (s) =>
          s.action.toLowerCase().includes(needle) ||
          s.expected.toLowerCase().includes(needle),
      );
    }).length;
  })();

  const submit = () => {
    const text = draft.trim();
    if ((!text && att.attachments.length === 0) || busy || !cases) return;
    void sendMessage(
      planId,
      suiteId,
      text,
      att.attachments,
      bugCtx.selected.map((b) => b.id),
    );
    setDraft("");
    att.clear();
    bugCtx.clear();
    mention.dismiss();
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      <ChatHeader
        titleParts={titleParts}
        cases={cases}
        casesLoading={casesLoading}
        totalCases={totalCases}
        truncated={truncated}
        scopedCount={scopedCount}
        filter={filter}
        onFilterChange={(v) => setFilter(planId, suiteId, v)}
        modelId={modelId}
        activeModel={activeModel}
        activeModelId={activeModelId}
        setModel={(id) => setModel(planId, suiteId, id)}
        availabilityFilter={availability.isAvailable}
        onNewThread={() => {
          newThread(planId, suiteId);
          setDraft("");
          att.clear();
        }}
        onReloadCases={() => void loadCases(planId, suiteId, true)}
        canReload={!casesLoading}
        threadList={threadList ?? []}
        activeThreadId={activeThreadId}
        onSwitchThread={(tid) => setActiveThread(planId, suiteId, tid)}
        onDeleteThread={(tid) => void deleteThread(planId, suiteId, tid)}
        onRenameThread={(tid, title) => renameThread(planId, suiteId, tid, title)}
        currentThreadTitle={thread.title}
        currentThreadMessageCount={messages.length}
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
        fetchBug={fetchBug}
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
        attachments={att.attachments}
        attachmentErrors={att.errors}
        onPaste={att.onPaste}
        onDrop={att.onDrop}
        onFilePicker={att.onFilePicker}
        onRemoveAttachment={att.remove}
        onDismissAttachmentError={att.dismissError}
        mention={mention}
        bugChips={
          <WorkItemChips items={bugCtx.selected} onRemove={bugCtx.remove} />
        }
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
  scopedCount,
  filter,
  onFilterChange,
  modelId,
  activeModel,
  activeModelId,
  setModel,
  availabilityFilter,
  onNewThread,
  onReloadCases,
  canReload,
  threadList,
  activeThreadId,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  currentThreadTitle,
  currentThreadMessageCount,
}: {
  titleParts: string[];
  cases: { id: number }[] | null;
  casesLoading: boolean;
  totalCases: number;
  truncated: boolean;
  scopedCount: number;
  filter: string;
  onFilterChange: (v: string) => void;
  modelId: ModelId | null;
  activeModel: { label: string } | undefined;
  activeModelId: ModelId;
  setModel: (id: ModelId | null) => void;
  availabilityFilter: (id: ModelId) => boolean;
  onNewThread: () => void;
  onReloadCases: () => void;
  canReload: boolean;
  threadList: { threadId: string; title: string | null; messageCount: number; updatedAt: string }[];
  activeThreadId: string;
  onSwitchThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  currentThreadTitle: string | null;
  currentThreadMessageCount: number;
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
          <ThreadSwitcher
            threadList={threadList}
            activeThreadId={activeThreadId}
            currentThreadTitle={currentThreadTitle}
            currentThreadMessageCount={currentThreadMessageCount}
            onSwitchThread={onSwitchThread}
            onNewThread={onNewThread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="New thread"
                onClick={onNewThread}
              >
                <HugeiconsIcon
                  icon={MessageAdd01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Start a new thread on this suite — your current chat is kept
              and reachable from the thread switcher.
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
      {/* Row 2 — case count + search. We deliberately keep this row light:
          the test-plan tree, the model picker, and the bottom status bar
          all carry their own signals. Here we only show what the user can
          DO on this chat: see how many cases are in scope, and narrow that
          scope with search when the suite is big. The "code grounding"
          chip used to live here too — removed because the model picker
          already shows the active provider, and the source-dir state is
          a global concern that belongs in Preferences, not in every
          chat header. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {casesLoading ? (
            "Loading cases…"
          ) : cases ? (
            <>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  filter.trim() ? "text-primary" : "text-foreground/85",
                )}
              >
                {filter.trim() ? scopedCount : cases.length}
              </span>{" "}
              case{(filter.trim() ? scopedCount : cases.length) === 1 ? "" : "s"}
              {filter.trim() ? (
                <span className="text-muted-foreground/70">
                  {" "}
                  matching · {cases.length} in suite
                </span>
              ) : truncated ? (
                <span className="text-amber-700 dark:text-amber-300">
                  {" "}
                  · {totalCases - cases.length} more not loaded
                </span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </span>
        {/* Scope-narrowing input. Earlier copy ("Search cases…") didn't
            explain why this control exists — users assumed it was a UI
            filter and ignored it. It's actually a budget control: the
            chat sends every loaded case to the model on every turn, so
            on a big suite the only way to keep answers grounded in the
            cases you care about is to narrow scope here. The leading
            "Narrow AI scope" label makes the intent unmistakable. */}
        {cases && cases.length > 5 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-background/40 pl-1.5 pr-0.5 py-0.5">
                <HugeiconsIcon
                  icon={Search01Icon}
                  size={10}
                  strokeWidth={1.75}
                  className="text-muted-foreground/80"
                />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/85">
                  Narrow AI scope
                </span>
                <div className="relative inline-flex items-center">
                  <input
                    value={filter}
                    onChange={(e) => onFilterChange(e.target.value)}
                    placeholder="title, #id, tag, step…"
                    aria-label="Narrow which cases the AI sees in this chat"
                    className={cn(
                      "h-5 w-[180px] rounded-sm border bg-background/60 pl-1.5 pr-5 text-[11px] outline-none transition-colors focus:border-primary/50 focus:ring-1 focus:ring-ring/30",
                      filter.trim()
                        ? "border-primary/40 bg-primary/[0.04] text-primary placeholder:text-primary/55"
                        : "border-border/60 placeholder:text-muted-foreground/65",
                    )}
                  />
                  {filter.trim() ? (
                    <button
                      type="button"
                      onClick={() => onFilterChange("")}
                      aria-label="Clear scope filter"
                      className="absolute right-0.5 grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={9}
                        strokeWidth={2}
                      />
                    </button>
                  ) : null}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              variant="panel"
              className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
            >
              The chat sends every loaded case to the model on each turn.
              On a big suite that dilutes answers — type a keyword here to
              focus the AI on the matching subset (title, step text, tag,
              or <span className="font-mono">#id</span>).
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
  attachments?: Attachment[];
};

function ChatThread({
  casesLoading,
  cases,
  suiteName,
  messages,
  busy,
  lookupCase,
  fetchBug,
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
  fetchBug: BugLookup;
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
            attachments={m.attachments}
            streaming={busy && m.role === "assistant" && idx === messages.length - 1}
            lookupCase={lookupCase}
            fetchBug={fetchBug}
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
  attachments,
  streaming,
  lookupCase,
  fetchBug,
  onApplyEdit,
  appliedEdits,
  onEditApplied,
  onUndoEdit,
  onEditUndone,
  assistantProvider,
}: {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  streaming: boolean;
  lookupCase: CaseLookup;
  fetchBug: BugLookup;
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
      <div className="flex flex-col items-end gap-1.5">
        {attachments && attachments.length > 0 ? (
          <AttachmentList
            attachments={attachments}
            className="max-w-[80%] justify-end"
          />
        ) : null}
        {content ? (
          <div className="group/msg relative max-w-[80%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[12px] leading-[1.55] text-foreground">
            <p className="whitespace-pre-wrap break-words">{content}</p>
          </div>
        ) : null}
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
            fetchBug={fetchBug}
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
  attachments,
  attachmentErrors,
  onPaste,
  onDrop,
  onFilePicker,
  onRemoveAttachment,
  onDismissAttachmentError,
  mention,
  bugChips,
}: {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled: boolean;
  hint: string;
  attachments: Attachment[];
  attachmentErrors: { id: string; message: string }[];
  onPaste: (e: React.ClipboardEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onFilePicker: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissAttachmentError: (id: string) => void;
  /** Inline `#id` work-item mention (detection + dropdown + keyboard nav). */
  mention?: WorkItemMention;
  /** Attached work-item chips, rendered above the input. */
  bugChips?: React.ReactNode;
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
        <AttachmentDropZone
          attachments={attachments}
          errors={attachmentErrors}
          remove={onRemoveAttachment}
          dismissError={onDismissAttachmentError}
          className="mb-2"
        />
        {bugChips ? <div className="mb-1.5">{bugChips}</div> : null}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            "group relative flex items-end gap-2 rounded-md border border-border/60 bg-input/40 px-2.5 py-1.5 transition-colors",
            "focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-ring/25",
            busy && "border-primary/35 bg-primary/[0.03]",
          )}
        >
          {mention?.active ? <MentionDropdown mention={mention} /> : null}
          <AttachButton onFilePicker={onFilePicker} disabled={disabled} />
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              onChange(e.target.value);
              mention?.noteInput(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) =>
              mention?.noteCaret(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length,
              )
            }
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Let the mention own arrows/enter/escape while its menu is open.
              if (mention?.onKeyDown(e)) return;
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
                  disabled={(!draft.trim() && attachments.length === 0) || disabled}
                  className="shrink-0"
                >
                  <HugeiconsIcon
                    icon={ArrowTurnUpIcon}
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
            <Kbd>{ENTER_KEY}</Kbd>
            send
          </span>
          <Dot />
          <span className="inline-flex items-center gap-1">
            <Kbd>{fmtShortcut(SHIFT_KEY, ENTER_KEY)}</Kbd>
            newline
          </span>
          <Dot />
          <span className="inline-flex items-center gap-1">
            <Kbd>#</Kbd>
            attach a work item
          </span>
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

// ---------------------------------------------------------------------------
// Thread switcher
// ---------------------------------------------------------------------------

/** How many threads we show in the chip's popover before sending the user
 *  to the full chats sidebar. Keep this small — the popover is for "switch
 *  between the chats I'm actively juggling on this suite", not for browsing
 *  the entire archive. */
const THREAD_SWITCHER_LIMIT = 5;

/**
 * Compact thread switcher chip. Shows the active thread's label (auto-
 * derived from the first user message or a user-set title) plus a count
 * pill. Clicking opens a small popover with the most recently-updated
 * threads on this suite — each row has labelled Rename and Delete buttons,
 * not naked icons. A "See all chats" footer hands off to the sidebar's
 * chats tab when the user wants to dig past the recent few.
 */
function ThreadSwitcher({
  threadList,
  activeThreadId,
  currentThreadTitle,
  currentThreadMessageCount,
  onSwitchThread,
  onNewThread,
  onDeleteThread,
  onRenameThread,
}: {
  threadList: { threadId: string; title: string | null; messageCount: number; updatedAt: string }[];
  activeThreadId: string;
  currentThreadTitle: string | null;
  currentThreadMessageCount: number;
  onSwitchThread: (threadId: string) => void;
  onNewThread: () => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Build the rendered list. If the current thread hasn't been persisted
  // yet (brand new + first user message hasn't sent), still surface it at
  // the top so the user can see "what I'm in right now".
  const fullList = (() => {
    const has = threadList.some((t) => t.threadId === activeThreadId);
    if (has) return threadList;
    return [
      {
        threadId: activeThreadId,
        title: currentThreadTitle,
        messageCount: currentThreadMessageCount,
        updatedAt: new Date().toISOString(),
      },
      ...threadList,
    ];
  })();
  // Active first, then most-recent. Capped — see THREAD_SWITCHER_LIMIT.
  const sorted = [...fullList].sort((a, b) => {
    if (a.threadId === activeThreadId) return -1;
    if (b.threadId === activeThreadId) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const list = sorted.slice(0, THREAD_SWITCHER_LIMIT);
  const overflowCount = Math.max(0, fullList.length - list.length);
  const label =
    currentThreadTitle ||
    fullList.find((t) => t.threadId === activeThreadId)?.title ||
    (currentThreadMessageCount === 0 ? "New chat" : "Untitled chat");

  const openChatsTab = () => {
    // The sidebar listens for this and switches its active view. Same
    // event the rest of the app uses for cross-pane navigation.
    window.dispatchEvent(
      new CustomEvent("devops-studio:switch-sidebar-view", {
        detail: { view: "chat-history" },
      }),
    );
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Switch chat thread"
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/60 px-2 text-[11px] text-foreground/85 hover:bg-foreground/[0.04]"
            >
              <HugeiconsIcon
                icon={BubbleChatIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0 text-foreground/60"
              />
              <span className="truncate">{label}</span>
              {fullList.length > 1 ? (
                <span className="ml-0.5 rounded-sm bg-foreground/[0.08] px-1 py-px text-[9px] font-medium text-muted-foreground">
                  {fullList.length}
                </span>
              ) : null}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground/60"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Switch between chat threads on this suite
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="bottom"
        // Tighter corners (rounded-sm) match the editor density of the
        // rest of the app — the default rounded-md popover felt like an
        // iOS sheet next to the boxier toolbar above it.
        className="w-[320px] overflow-hidden rounded-sm p-0"
      >
        <div className="flex items-center justify-between border-b border-border/40 bg-foreground/[0.02] px-2.5 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent threads
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  onNewThread();
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-card/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground/85 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
              >
                <HugeiconsIcon
                  icon={MessageAdd01Icon}
                  size={10}
                  strokeWidth={1.75}
                />
                New thread
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Start a fresh thread on this suite — the current one stays.
            </TooltipContent>
          </Tooltip>
        </div>
        <ul className="max-h-[260px] overflow-y-auto py-0.5">
          {list.length === 0 ? (
            <li className="px-2.5 py-3 text-center text-[10.5px] text-muted-foreground">
              No threads yet.
            </li>
          ) : null}
          {list.map((t) => (
            <ThreadRow
              key={t.threadId}
              thread={t}
              active={t.threadId === activeThreadId}
              canDelete={fullList.length > 1}
              onSelect={() => {
                onSwitchThread(t.threadId);
                setOpen(false);
              }}
              onDelete={() => onDeleteThread(t.threadId)}
              onRename={(title) => onRenameThread(t.threadId, title)}
            />
          ))}
        </ul>
        {overflowCount > 0 ? (
          <button
            type="button"
            onClick={openChatsTab}
            className="flex w-full items-center justify-between border-t border-border/40 bg-foreground/[0.02] px-2.5 py-1.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <span>
              + {overflowCount} more thread{overflowCount === 1 ? "" : "s"}
            </span>
            <span className="font-medium text-foreground/85">
              See all chats →
            </span>
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ThreadRow({
  thread,
  active,
  canDelete,
  onSelect,
  onDelete,
  onRename,
}: {
  thread: { threadId: string; title: string | null; messageCount: number; updatedAt: string };
  active: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title ?? "");
  useEffect(() => {
    if (!editing) setDraft(thread.title ?? "");
  }, [editing, thread.title]);

  return (
    <li
      className={cn(
        "group flex items-center gap-1.5 px-2 py-1.5 transition-colors",
        active ? "bg-primary/[0.07]" : "hover:bg-foreground/[0.04]",
      )}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim()) onRename(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (draft.trim()) onRename(draft);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          placeholder="Name this thread…"
          className="min-w-0 flex-1 rounded-sm border border-primary/50 bg-background/80 px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring/30"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
          title={
            active
              ? "Currently active thread"
              : "Click to switch to this thread"
          }
        >
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[11.5px]",
                active ? "font-medium text-primary" : "text-foreground/90",
                !thread.title && "italic text-muted-foreground/85",
              )}
            >
              {thread.title || (thread.messageCount === 0 ? "New chat" : "Untitled chat")}
            </span>
            {active ? (
              <span className="rounded-sm bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
                active
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[9.5px] text-muted-foreground/80">
            {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"} ·{" "}
            {formatThreadStamp(thread.updatedAt)}
          </p>
        </button>
      )}
      {!editing ? (
        // Per-row action buttons. They DO have tooltips now (the old
        // FolderIcon-as-rename was inscrutable). On non-hover state we
        // keep them visible at 60% opacity so users discover them
        // immediately instead of having to mouseover-and-hope.
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                aria-label="Rename thread"
                className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Edit02Icon}
                  size={10}
                  strokeWidth={1.75}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Rename this thread
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canDelete) return;
                  if (!window.confirm("Delete this thread permanently?")) {
                    return;
                  }
                  onDelete();
                }}
                disabled={!canDelete}
                aria-label="Delete thread"
                className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-30"
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={10}
                  strokeWidth={1.75}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              {canDelete
                ? "Delete this thread permanently"
                : "At least one thread must remain"}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}

function formatThreadStamp(iso: string): string {
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
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
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
