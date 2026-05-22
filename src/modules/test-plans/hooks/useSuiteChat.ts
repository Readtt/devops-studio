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
import type { ModelId } from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  newSuiteChatMessageId,
  streamSuiteChat,
  streamSuiteChatClaude,
  type SuiteChatMessage,
} from "../lib/runSuiteChat";
import {
  deleteChatThread,
  getChatThread,
  saveChatThread,
} from "../lib/chatThreadsApi";

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
  /** Per-chat model override. Null = inherit the user's current global
   *  default (useChatStore.selectedModelId). Set this per-thread so a user
   *  can run one chat on Sonnet for code-grounded review and another on
   *  Haiku for quick lookups without flipping the global picker. */
  modelId: ModelId | null;
  /** True once the persisted thread (if any) has been loaded from SQLite,
   *  so we don't overwrite an in-memory thread with stale on-disk content
   *  on a re-mount. */
  hydrated: boolean;
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
  modelId: null,
  hydrated: false,
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
  /** Set the model used for this specific chat thread. `null` reverts to
   *  inheriting the global default. */
  setModel: (planId: number, suiteId: number, modelId: ModelId | null) => void;
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

/** One-shot async hydrate from SQLite. Marks the slice as hydrated even
 *  when no on-disk row exists so we don't re-attempt the fetch on every
 *  re-render. Failures are swallowed — chat still works in-memory. */
async function hydrateFromDisk(
  planId: number,
  suiteId: number,
  set: (fn: (s: Store) => Partial<Store> | Store) => void,
  get: () => Store,
) {
  try {
    const stored = await getChatThread({ planId, suiteId });
    const k = key(planId, suiteId);
    const curr = get().byKey.get(k);
    // Skip the restore if a message has already been added in-memory
    // between ensure() and the async fetch resolving — the in-memory
    // thread takes precedence so we don't clobber an edit-in-flight.
    if (curr && curr.messages.length > 0) {
      patch(set, planId, suiteId, { hydrated: true });
      return;
    }
    if (stored) {
      patch(set, planId, suiteId, {
        hydrated: true,
        messages: stored.messages,
        modelId: stored.modelId,
      });
    } else {
      patch(set, planId, suiteId, { hydrated: true });
    }
  } catch {
    // Hydration is best-effort; chat continues in memory-only mode.
    patch(set, planId, suiteId, { hydrated: true });
  }
}

/** Snapshot the current slice and persist. Throttled per (planId,suiteId)
 *  so a streaming response that mutates the assistant message on every
 *  chunk doesn't fire dozens of IO writes a second — the latest snapshot
 *  always wins within the throttle window. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(
  planId: number,
  suiteId: number,
  get: () => Store,
  delay = 300,
) {
  const k = key(planId, suiteId);
  const existing = persistTimers.get(k);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistTimers.delete(k);
    const slice = get().byKey.get(k);
    if (!slice) return;
    // Empty + no-model rows aren't worth persisting — saves disk on
    // ephemeral panes the user opens and never sends a message in.
    if (slice.messages.length === 0 && slice.modelId === null) return;
    void saveChatThread({
      planId,
      suiteId,
      modelId: slice.modelId,
      messages: slice.messages,
    }).catch(() => {
      // Best-effort persistence — failures are silent so the chat itself
      // keeps working. A real disk error would surface on the next read.
    });
  }, delay);
  persistTimers.set(k, timer);
}

export const useSuiteChat = create<Store>((set, get) => ({
  byKey: new Map(),

  ensure: (planId, suiteId) => {
    const k = key(planId, suiteId);
    const existing = get().byKey.get(k);
    if (existing) {
      // Lazy hydrate: re-mounting the same pane shouldn't refetch from
      // disk, but a fresh slice should pull the persisted thread once.
      if (!existing.hydrated) {
        void hydrateFromDisk(planId, suiteId, set, get);
      }
      return existing;
    }
    const fresh = initialChatState();
    set((s) => {
      const next = new Map(s.byKey);
      next.set(k, fresh);
      return { byKey: next };
    });
    void hydrateFromDisk(planId, suiteId, set, get);
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

    // Push the user message AND an empty assistant message in the same
    // commit. The empty one is the streaming buffer — we append chunks to
    // it as the model produces text so the UI renders incrementally
    // instead of waiting for the full reply.
    const userMsg: SuiteChatMessage = {
      id: newSuiteChatMessageId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    const assistantId = newSuiteChatMessageId();
    const assistantMsg: SuiteChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    patch(set, planId, suiteId, {
      busy: true,
      error: null,
      messages: [...curr.messages, userMsg, assistantMsg],
    });

    // Appends a chunk to whichever message in the slice has id===assistantId.
    // Re-reading from get() each call lets concurrent patches (cancel,
    // clear) survive: if the assistant message was removed (e.g. user
    // cleared mid-stream), we silently drop the chunk.
    const appendDelta = (delta: string) => {
      if (!delta) return;
      set((s) => {
        const k = key(planId, suiteId);
        const next = new Map(s.byKey);
        const slice = next.get(k);
        if (!slice) return s;
        let found = false;
        const messages = slice.messages.map((m) => {
          if (m.id !== assistantId) return m;
          found = true;
          return { ...m, content: m.content + delta };
        });
        if (!found) return s;
        next.set(k, { ...slice, messages });
        return { byKey: next };
      });
      // Persist progressively while the stream runs. Throttled so a
      // chunk-per-token CLI doesn't hammer SQLite.
      schedulePersist(planId, suiteId, get);
    };

    // Persist the user message right away so a crash mid-response doesn't
    // lose what the user typed. The streaming throttle handles updates.
    schedulePersist(planId, suiteId, get, 50);

    const chat = useChatStore.getState();
    const keys = chat.apiKeys;
    // Per-thread model override wins over the user's global pick. Lets a
    // user run different chats on different models without churning the
    // status-bar picker.
    const modelId = curr.modelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const sourceRoot = prefs.sourceRoot ?? null;
    // Snapshot messages WITHOUT the newly-pushed user + placeholder
    // assistant — the runner builds the prompt from "history + newQuestion"
    // and we don't want the placeholder feeding back into the prompt.
    const priorMessages = curr.messages;

    try {
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
        const runId = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        patch(set, planId, suiteId, { activeClaudeRunId: runId });
        await streamSuiteChatClaude({
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
          onText: appendDelta,
        });
      } else {
        await streamSuiteChat({
          suiteName: curr.suiteName,
          suitePath: curr.suitePath,
          planName: curr.planName,
          cases: curr.cases,
          history: priorMessages,
          newQuestion: text,
          keys,
          modelId,
          sourceRootHint: sourceRoot,
          onText: appendDelta,
        });
      }
      // Empty-stream guard: if the model returned nothing, leave a clear
      // placeholder rather than a blank bubble.
      set((s) => {
        const k = key(planId, suiteId);
        const next = new Map(s.byKey);
        const slice = next.get(k);
        if (!slice) return s;
        const messages = slice.messages.map((m) =>
          m.id === assistantId && m.content.length === 0
            ? { ...m, content: "(empty response)" }
            : m,
        );
        next.set(k, { ...slice, messages, busy: false, activeClaudeRunId: null });
        return { byKey: next };
      });
      // Final persist on stream complete — guarantees the latest content
      // hits disk even if the throttle was holding pending writes.
      schedulePersist(planId, suiteId, get, 50);
    } catch (e) {
      const cancelled =
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: string }).kind === "cancelled";
      if (!cancelled) console.error("[suite-chat] failed:", e);
      // On error: drop the placeholder assistant message and surface the
      // error banner so the user can resend after fixing the cause. The
      // user's message stays in the thread.
      set((s) => {
        const k = key(planId, suiteId);
        const next = new Map(s.byKey);
        const slice = next.get(k);
        if (!slice) return s;
        const messages = slice.messages.filter((m) => m.id !== assistantId);
        next.set(k, {
          ...slice,
          messages,
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
        return { byKey: next };
      });
    }
  },

  setModel: (planId, suiteId, modelId) => {
    patch(set, planId, suiteId, { modelId });
    schedulePersist(planId, suiteId, get, 50);
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
    // Hard-delete the persisted row when the user clears — leaving an
    // empty row behind would just bloat the table and show up in any
    // future "recent threads" view as a ghost entry.
    void deleteChatThread({ planId, suiteId }).catch(() => {});
  },

  dismissError: (planId, suiteId) => {
    patch(set, planId, suiteId, { error: null });
  },
}));
