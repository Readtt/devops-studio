// Per-suite chat thread + case cache. One store, keyed by `${planId}:${suiteId}`
// so the user can have several suite-chat tabs open simultaneously without
// them stomping each other's threads. Threads stay in memory only — closing
// the tab keeps the thread until the page reloads or the user clicks "clear".

import { create } from "zustand";
import {
  cancelClaudeRun,
  claudeErrorMessage,
} from "@/modules/ai/lib/claude";
import { resolveClaudeModelId, selectEngine } from "@/modules/ai/lib/engine";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  adoErrorMessage,
  getCase,
  listSuiteCases,
  listSuites,
  toAdoError,
  type AdoError,
  type SuiteRef,
  type TestCase,
} from "@/modules/ado";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  newSuiteChatMessageId,
  runSuiteChat,
  runSuiteChatClaude,
  type SuiteChatMessage,
} from "../lib/runSuiteChat";

/** Cap on the number of cases we'll embed in a single chat prompt. Past
 *  this size the system prompt overwhelms most context windows AND the
 *  user is unlikely to be asking suite-wide questions anyway. We surface
 *  the truncation explicitly so the user knows what got cut. */
const PROMPT_CASE_CAP = 50;

export type SuiteChatState = {
  /** Full case objects fetched from ADO. Null = not loaded yet. */
  cases: TestCase[] | null;
  casesLoading: boolean;
  casesError: AdoError | null;
  /** Honest count from ADO. May exceed cases.length when we hit PROMPT_CASE_CAP. */
  totalCases: number;
  /** True when the case list was clamped to PROMPT_CASE_CAP so the chat
   *  UI can surface a "X cases hidden from the model" banner. */
  truncated: boolean;
  /** Resolved suite display name + parent path so the prompt + tab title
   *  can render the breadcrumb without a separate fetch. */
  suiteName: string | null;
  suitePath: string[];
  planName: string | null;

  messages: SuiteChatMessage[];
  busy: boolean;
  /** Last chat error, surfaced inline. Cleared on the next send. */
  error: string | null;
  /** Run id of the in-flight Claude CLI subprocess (or null on the Vercel
   *  SDK path) so a cancel can target the right child. */
  activeClaudeRunId: string | null;
};

const initialChatState = (): SuiteChatState => ({
  cases: null,
  casesLoading: false,
  casesError: null,
  totalCases: 0,
  truncated: false,
  suiteName: null,
  suitePath: [],
  planName: null,
  messages: [],
  busy: false,
  error: null,
  activeClaudeRunId: null,
});

type Store = {
  byKey: Map<string, SuiteChatState>;
  /** Subscribe to one suite's slice. Components call this with a selector
   *  that reads `state.byKey.get(key)`; we always return a non-null
   *  SuiteChatState so the selector never has to null-check. */
  ensure: (planId: number, suiteId: number) => SuiteChatState;
  loadCases: (planId: number, suiteId: number, force?: boolean) => Promise<void>;
  sendMessage: (planId: number, suiteId: number, q: string) => Promise<void>;
  cancel: (planId: number, suiteId: number) => void;
  clearMessages: (planId: number, suiteId: number) => void;
  dismissError: (planId: number, suiteId: number) => void;
};

const key = (planId: number, suiteId: number) => `${planId}:${suiteId}`;

function patch(
  set: (
    fn: (s: Store) => Partial<Store> | Store,
  ) => void,
  planId: number,
  suiteId: number,
  partial: Partial<SuiteChatState>,
) {
  set((s) => {
    const k = key(planId, suiteId);
    const next = new Map(s.byKey);
    const curr = next.get(k) ?? initialChatState();
    next.set(k, { ...curr, ...partial });
    return { byKey: next };
  });
}

export const useSuiteChat = create<Store>((set, get) => ({
  byKey: new Map(),

  ensure: (planId, suiteId) => {
    const k = key(planId, suiteId);
    const existing = get().byKey.get(k);
    if (existing) return existing;
    const fresh = initialChatState();
    set((s) => {
      const next = new Map(s.byKey);
      next.set(k, fresh);
      return { byKey: next };
    });
    return fresh;
  },

  loadCases: async (planId, suiteId, force = false) => {
    const curr = get().byKey.get(key(planId, suiteId));
    if (curr?.casesLoading) return;
    if (!force && curr?.cases && !curr.casesError) return;

    patch(set, planId, suiteId, { casesLoading: true, casesError: null });

    try {
      const [refs, suites] = await Promise.all([
        listSuiteCases(planId, suiteId),
        // listSuites is cheap and lets us reconstruct the breadcrumb path
        // for the prompt + tab title without a separate fetch elsewhere.
        listSuites(planId).catch<SuiteRef[]>(() => []),
      ]);
      const total = refs.length;
      const trimmed = refs.slice(0, PROMPT_CASE_CAP);
      // Fetch case bodies in parallel. Each getCase is a single ADO call;
      // 50 in parallel is fine — well under any reasonable rate limit.
      const cases: TestCase[] = [];
      const results = await Promise.allSettled(
        trimmed.map((r) => getCase(r.id)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") cases.push(r.value);
      }

      // Resolve suite breadcrumb path from the flat list — same approach
      // the generator's buildTargetContext uses.
      const byId = new Map(suites.map((s) => [s.id, s]));
      const suite = byId.get(suiteId) ?? null;
      const path: string[] = [];
      let cursor = suite?.parentSuiteId ?? null;
      let guard = 0;
      while (cursor != null && guard++ < 64) {
        const parent = byId.get(cursor);
        if (!parent) break;
        // The root suite name is the plan name — we hide it in the tree UI
        // and we hide it here too so the breadcrumb reads cleanly.
        if (parent.parentSuiteId == null) break;
        path.unshift(parent.name);
        cursor = parent.parentSuiteId ?? null;
      }

      patch(set, planId, suiteId, {
        cases,
        casesLoading: false,
        casesError: null,
        totalCases: total,
        truncated: total > PROMPT_CASE_CAP,
        suiteName: suite?.name ?? null,
        suitePath: path,
        // planName resolution is best-effort — leaving null is fine; the
        // pane header reads from the active tab's title when missing.
      });
    } catch (e) {
      patch(set, planId, suiteId, {
        casesLoading: false,
        casesError: toAdoError(e),
      });
    }
  },

  sendMessage: async (planId, suiteId, q) => {
    const text = q.trim();
    if (!text) return;
    const curr = get().byKey.get(key(planId, suiteId));
    if (!curr) return;
    if (curr.busy) return;
    if (!curr.cases) return; // refuse to chat without loaded cases

    const userMsg: SuiteChatMessage = {
      id: newSuiteChatMessageId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    patch(set, planId, suiteId, {
      busy: true,
      error: null,
      messages: [...curr.messages, userMsg],
    });

    const chat = useChatStore.getState();
    const keys = chat.apiKeys;
    const modelId = chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const sourceRoot = prefs.sourceRoot ?? null;
    const priorMessages = curr.messages;

    try {
      let assistantText: string;
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
        const runId = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        patch(set, planId, suiteId, { activeClaudeRunId: runId });
        const res = await runSuiteChatClaude({
          runId,
          suiteName: curr.suiteName,
          suitePath: curr.suitePath,
          planName: curr.planName,
          cases: curr.cases,
          history: priorMessages,
          newQuestion: text,
          modelId: resolveClaudeModelId(modelId) as typeof modelId,
          sourceRoot,
          authMode: engineSel.authMode ?? "api-key",
          bareMode: prefs.claudeBareMode,
        });
        assistantText = res.text;
      } else {
        const res = await runSuiteChat({
          suiteName: curr.suiteName,
          suitePath: curr.suitePath,
          planName: curr.planName,
          cases: curr.cases,
          history: priorMessages,
          newQuestion: text,
          keys,
          modelId,
          sourceRootHint: sourceRoot,
        });
        assistantText = res.text;
      }
      const assistantMsg: SuiteChatMessage = {
        id: newSuiteChatMessageId(),
        role: "assistant",
        content: assistantText || "(empty response)",
        timestamp: new Date().toISOString(),
      };
      const after = get().byKey.get(key(planId, suiteId));
      patch(set, planId, suiteId, {
        busy: false,
        activeClaudeRunId: null,
        messages: [...(after?.messages ?? []), assistantMsg],
      });
    } catch (e) {
      const cancelled =
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: string }).kind === "cancelled";
      if (!cancelled) console.error("[suite-chat] failed:", e);
      patch(set, planId, suiteId, {
        busy: false,
        activeClaudeRunId: null,
        error: cancelled
          ? null
          : typeof e === "object" &&
              e !== null &&
              (e as { kind?: string }).kind
            ? claudeErrorMessage(e) || adoErrorMessage(toAdoError(e))
            : String(e),
      });
    }
  },

  cancel: (planId, suiteId) => {
    const curr = get().byKey.get(key(planId, suiteId));
    if (!curr?.busy) return;
    if (curr.activeClaudeRunId) {
      void cancelClaudeRun(curr.activeClaudeRunId).catch(() => {
        patch(set, planId, suiteId, { busy: false, activeClaudeRunId: null });
      });
    } else {
      // Vercel SDK path can't be cancelled cleanly; flip the UI back so the
      // user can compose another message while the in-flight promise
      // settles harmlessly in the background.
      patch(set, planId, suiteId, { busy: false });
    }
  },

  clearMessages: (planId, suiteId) => {
    patch(set, planId, suiteId, { messages: [], error: null });
  },

  dismissError: (planId, suiteId) => {
    patch(set, planId, suiteId, { error: null });
  },
}));
