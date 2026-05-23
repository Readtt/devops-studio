// Per-suite chat threads + case cache. One store, keyed by
// `${planId}:${suiteId}:${threadId}` so the user can have several parallel
// threads on the same suite — "New thread" creates a brand-new thread id
// rather than wiping the existing one. Cases (the prompt context) are
// cached per (planId, suiteId) and shared across every thread on that suite.

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
  DEFAULT_THREAD_ID,
  deleteChatThread,
  listChatThreadsForSuite,
  newThreadId,
  saveChatThread,
  type StoredChatThread,
} from "../lib/chatThreadsApi";

/** Cap on the number of cases we'll embed in a single chat prompt. Past
 *  this size the system prompt overwhelms most context windows AND the
 *  user is unlikely to be asking suite-wide questions anyway. We surface
 *  the truncation explicitly so the user knows what got cut. */
const PROMPT_CASE_CAP = 50;

export type ThreadSummary = {
  threadId: string;
  title: string | null;
  messageCount: number;
  updatedAt: string;
};

/** Cases + suite metadata cached per (planId, suiteId). Shared by every
 *  thread on that suite — the model sees the same case list regardless of
 *  which thread the user happens to be typing in. */
export type SuiteCaseState = {
  cases: TestCase[] | null;
  casesLoading: boolean;
  casesError: AdoError | null;
  totalCases: number;
  truncated: boolean;
  suiteName: string | null;
  suitePath: string[];
  planName: string | null;
  /** Free-text filter applied client-side to the prompt's CASES IN SCOPE
   *  block. Empty = include every loaded case. */
  filter: string;
};

/** State for ONE thread. */
export type ThreadState = {
  threadId: string;
  /** Optional human title — shown in the thread switcher. Auto-derived
   *  from the first user message when null. */
  title: string | null;
  messages: SuiteChatMessage[];
  busy: boolean;
  error: string | null;
  activeClaudeRunId: string | null;
  modelId: ModelId | null;
  hydrated: boolean;
};

const initialCaseState = (): SuiteCaseState => ({
  cases: null,
  casesLoading: false,
  casesError: null,
  totalCases: 0,
  truncated: false,
  suiteName: null,
  suitePath: [],
  planName: null,
  filter: "",
});

const initialThreadState = (threadId: string): ThreadState => ({
  threadId,
  title: null,
  messages: [],
  busy: false,
  error: null,
  activeClaudeRunId: null,
  modelId: null,
  hydrated: false,
});

type Store = {
  /** Suite-level slice: case cache, filter, suite metadata. */
  bySuite: Map<string, SuiteCaseState>;
  /** Per-thread state. Keyed by `${planId}:${suiteId}:${threadId}`. */
  byThread: Map<string, ThreadState>;
  /** Active thread id selection per (planId, suiteId). Defaults to
   *  DEFAULT_THREAD_ID until a fresh thread is created. */
  activeThreadBySuite: Map<string, string>;
  /** Known thread summaries per (planId, suiteId), most recently updated
   *  first. Loaded from SQLite on first ensure() and refreshed when a
   *  thread is created or deleted. */
  threadListBySuite: Map<string, ThreadSummary[]>;

  ensure: (planId: number, suiteId: number) => void;
  /** Switch the active thread for a suite. If the thread isn't in
   *  byThread yet, a fresh slice is created and hydrate runs in the
   *  background. */
  setActiveThread: (planId: number, suiteId: number, threadId: string) => void;
  /** Create a fresh thread on this suite and switch to it. Returns the
   *  new thread id. */
  newThread: (planId: number, suiteId: number) => string;
  /** Delete a thread (history + current state). If it was the active
   *  thread, falls back to the most recent remaining one — or creates
   *  a fresh default if none are left. */
  deleteThread: (
    planId: number,
    suiteId: number,
    threadId: string,
  ) => Promise<void>;
  /** Update a thread's human title. */
  renameThread: (
    planId: number,
    suiteId: number,
    threadId: string,
    title: string,
  ) => void;

  loadCases: (planId: number, suiteId: number, force?: boolean) => Promise<void>;
  setFilter: (planId: number, suiteId: number, filter: string) => void;

  sendMessage: (planId: number, suiteId: number, q: string) => Promise<void>;
  cancel: (planId: number, suiteId: number) => void;
  clearMessages: (planId: number, suiteId: number) => void;
  dismissError: (planId: number, suiteId: number) => void;
  setModel: (planId: number, suiteId: number, modelId: ModelId | null) => void;

  markEditApplied: (
    planId: number,
    suiteId: number,
    messageId: string,
    blockHash: string,
    record: import("../lib/runSuiteChat").AppliedEditRecord,
  ) => void;
  clearEditApplied: (
    planId: number,
    suiteId: number,
    messageId: string,
    blockHash: string,
  ) => void;
};

const suiteKey = (planId: number, suiteId: number) => `${planId}:${suiteId}`;
const threadKey = (planId: number, suiteId: number, threadId: string) =>
  `${planId}:${suiteId}:${threadId}`;

/** Mutate the bySuite slice for a (planId, suiteId). */
function patchSuite(
  set: (fn: (s: Store) => Partial<Store> | Store) => void,
  planId: number,
  suiteId: number,
  partial: Partial<SuiteCaseState>,
) {
  set((s) => {
    const k = suiteKey(planId, suiteId);
    const next = new Map(s.bySuite);
    const curr = next.get(k) ?? initialCaseState();
    next.set(k, { ...curr, ...partial });
    return { bySuite: next };
  });
}

/** Mutate one thread slice. */
function patchThread(
  set: (fn: (s: Store) => Partial<Store> | Store) => void,
  planId: number,
  suiteId: number,
  threadId: string,
  partial: Partial<ThreadState>,
) {
  set((s) => {
    const k = threadKey(planId, suiteId, threadId);
    const next = new Map(s.byThread);
    const curr = next.get(k) ?? initialThreadState(threadId);
    next.set(k, { ...curr, ...partial });
    return { byThread: next };
  });
}

function summarize(thread: ThreadState | StoredChatThread): ThreadSummary {
  const firstUser =
    (thread as StoredChatThread).messages?.find?.((m) => m.role === "user") ??
    (thread as ThreadState).messages.find((m) => m.role === "user");
  const fallback = firstUser
    ? firstUser.content.replace(/\s+/g, " ").trim().slice(0, 60)
    : null;
  const stored = thread as StoredChatThread;
  return {
    threadId: thread.threadId,
    title: (thread as StoredChatThread).title ?? fallback,
    messageCount: stored.messages?.length ?? (thread as ThreadState).messages.length,
    updatedAt:
      (stored.updatedAt as string | undefined) ?? new Date().toISOString(),
  };
}

/** Refresh the thread summary list for a suite from SQLite. Used after
 *  thread creation/deletion. */
async function refreshThreadList(
  planId: number,
  suiteId: number,
  set: (fn: (s: Store) => Partial<Store> | Store) => void,
) {
  try {
    const list = await listChatThreadsForSuite({ planId, suiteId });
    set((s) => {
      const next = new Map(s.threadListBySuite);
      next.set(
        suiteKey(planId, suiteId),
        list.map(summarize),
      );
      return { threadListBySuite: next };
    });
  } catch (e) {
    console.warn("[suite-chat] thread list refresh failed:", e);
  }
}

/** Hydrate one thread from SQLite. Marks hydrated even when no row exists
 *  so we don't re-fetch on every re-render. Skips overwriting if there's
 *  already an in-memory message (concurrent send in flight). */
async function hydrateThread(
  planId: number,
  suiteId: number,
  threadId: string,
  set: (fn: (s: Store) => Partial<Store> | Store) => void,
  get: () => Store,
) {
  try {
    const { getChatThread } = await import("../lib/chatThreadsApi");
    const stored = await getChatThread({ planId, suiteId, threadId });
    const curr = get().byThread.get(threadKey(planId, suiteId, threadId));
    if (curr && curr.messages.length > 0) {
      patchThread(set, planId, suiteId, threadId, { hydrated: true });
      return;
    }
    if (stored) {
      patchThread(set, planId, suiteId, threadId, {
        hydrated: true,
        title: stored.title,
        messages: stored.messages,
        modelId: stored.modelId,
      });
    } else {
      patchThread(set, planId, suiteId, threadId, { hydrated: true });
    }
  } catch (e) {
    console.warn("[suite-chat] hydrate thread failed:", e);
    patchThread(set, planId, suiteId, threadId, { hydrated: true });
  }
}

/** Throttle per (planId, suiteId, threadId) so a streaming response doesn't
 *  fire dozens of IO writes a second. The latest snapshot always wins
 *  within the throttle window. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(
  planId: number,
  suiteId: number,
  threadId: string,
  get: () => Store,
  delay = 300,
) {
  const k = threadKey(planId, suiteId, threadId);
  const existing = persistTimers.get(k);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistTimers.delete(k);
    const slice = get().byThread.get(k);
    if (!slice) return;
    if (slice.messages.length === 0 && slice.modelId === null && !slice.title)
      return;
    void saveChatThread({
      planId,
      suiteId,
      threadId,
      title: slice.title,
      modelId: slice.modelId,
      messages: slice.messages,
    }).catch((e) => {
      console.warn("[suite-chat] persist failed:", e);
    });
  }, delay);
  persistTimers.set(k, timer);
}

export const useSuiteChat = create<Store>((set, get) => ({
  bySuite: new Map(),
  byThread: new Map(),
  activeThreadBySuite: new Map(),
  threadListBySuite: new Map(),

  ensure: (planId, suiteId) => {
    const sk = suiteKey(planId, suiteId);
    const s = get();
    if (!s.bySuite.has(sk)) {
      set((curr) => {
        const next = new Map(curr.bySuite);
        next.set(sk, initialCaseState());
        return { bySuite: next };
      });
    }
    // Pick an active thread:
    //  - if we already chose one, keep it
    //  - otherwise, see what's on disk; if there's a default thread,
    //    use it; if there are other threads, pick the most-recent
    //  - if nothing is on disk yet, start with the legacy "default" id so
    //    new and migrated v1 stores both land in the same slot
    if (!s.activeThreadBySuite.has(sk)) {
      set((curr) => {
        const next = new Map(curr.activeThreadBySuite);
        next.set(sk, DEFAULT_THREAD_ID);
        return { activeThreadBySuite: next };
      });
      // Async load the actual thread list; if there's a more recent
      // thread than the default, switch to it once it's known.
      void (async () => {
        try {
          const list = await listChatThreadsForSuite({ planId, suiteId });
          set((curr) => {
            const next = new Map(curr.threadListBySuite);
            next.set(sk, list.map(summarize));
            return { threadListBySuite: next };
          });
          const top = list[0];
          if (top && top.threadId !== DEFAULT_THREAD_ID) {
            // Only switch automatically when the default has nothing in it
            // — otherwise respect the user's most recent active thread.
            const defaultExists = list.some(
              (t) => t.threadId === DEFAULT_THREAD_ID && t.messages.length > 0,
            );
            if (!defaultExists) {
              set((curr) => {
                const next = new Map(curr.activeThreadBySuite);
                next.set(sk, top.threadId);
                return { activeThreadBySuite: next };
              });
            }
          }
        } catch (e) {
          console.warn("[suite-chat] initial thread-list fetch failed:", e);
        }
      })();
    }
    // Hydrate the currently-active thread.
    const active = get().activeThreadBySuite.get(sk) ?? DEFAULT_THREAD_ID;
    const tk = threadKey(planId, suiteId, active);
    const existingThread = get().byThread.get(tk);
    if (!existingThread) {
      set((curr) => {
        const next = new Map(curr.byThread);
        next.set(tk, initialThreadState(active));
        return { byThread: next };
      });
      void hydrateThread(planId, suiteId, active, set, get);
    } else if (!existingThread.hydrated) {
      void hydrateThread(planId, suiteId, active, set, get);
    }
  },

  setActiveThread: (planId, suiteId, threadId) => {
    const sk = suiteKey(planId, suiteId);
    set((curr) => {
      const next = new Map(curr.activeThreadBySuite);
      next.set(sk, threadId);
      return { activeThreadBySuite: next };
    });
    const tk = threadKey(planId, suiteId, threadId);
    if (!get().byThread.get(tk)) {
      set((curr) => {
        const next = new Map(curr.byThread);
        next.set(tk, initialThreadState(threadId));
        return { byThread: next };
      });
      void hydrateThread(planId, suiteId, threadId, set, get);
    } else if (!get().byThread.get(tk)!.hydrated) {
      void hydrateThread(planId, suiteId, threadId, set, get);
    }
  },

  newThread: (planId, suiteId) => {
    const id = newThreadId();
    const sk = suiteKey(planId, suiteId);
    const tk = threadKey(planId, suiteId, id);
    set((curr) => {
      const nextByThread = new Map(curr.byThread);
      nextByThread.set(tk, {
        ...initialThreadState(id),
        hydrated: true, // brand new — nothing to hydrate
      });
      const nextActive = new Map(curr.activeThreadBySuite);
      nextActive.set(sk, id);
      const nextList = new Map(curr.threadListBySuite);
      const prior = nextList.get(sk) ?? [];
      nextList.set(sk, [
        {
          threadId: id,
          title: null,
          messageCount: 0,
          updatedAt: new Date().toISOString(),
        },
        ...prior,
      ]);
      return {
        byThread: nextByThread,
        activeThreadBySuite: nextActive,
        threadListBySuite: nextList,
      };
    });
    return id;
  },

  deleteThread: async (planId, suiteId, threadId) => {
    const sk = suiteKey(planId, suiteId);
    const tk = threadKey(planId, suiteId, threadId);
    try {
      await deleteChatThread({ planId, suiteId, threadId });
    } catch (e) {
      console.warn("[suite-chat] delete thread failed:", e);
    }
    set((curr) => {
      const nextByThread = new Map(curr.byThread);
      nextByThread.delete(tk);
      const nextList = new Map(curr.threadListBySuite);
      const prior = (nextList.get(sk) ?? []).filter(
        (t) => t.threadId !== threadId,
      );
      nextList.set(sk, prior);
      const nextActive = new Map(curr.activeThreadBySuite);
      const currentActive = nextActive.get(sk);
      if (currentActive === threadId) {
        // Fall back to the newest remaining thread, or a fresh default.
        const next = prior[0]?.threadId ?? DEFAULT_THREAD_ID;
        nextActive.set(sk, next);
      }
      return {
        byThread: nextByThread,
        threadListBySuite: nextList,
        activeThreadBySuite: nextActive,
      };
    });
    void refreshThreadList(planId, suiteId, set);
  },

  renameThread: (planId, suiteId, threadId, title) => {
    const trimmed = title.trim().slice(0, 120) || null;
    patchThread(set, planId, suiteId, threadId, { title: trimmed });
    // Reflect in the summary list so the switcher updates immediately.
    set((curr) => {
      const next = new Map(curr.threadListBySuite);
      const sk = suiteKey(planId, suiteId);
      const prior = next.get(sk);
      if (prior) {
        next.set(
          sk,
          prior.map((t) =>
            t.threadId === threadId ? { ...t, title: trimmed } : t,
          ),
        );
      }
      return { threadListBySuite: next };
    });
    schedulePersist(planId, suiteId, threadId, get, 50);
  },

  loadCases: async (planId, suiteId, force = false) => {
    const sk = suiteKey(planId, suiteId);
    const curr = get().bySuite.get(sk);
    if (curr?.casesLoading) return;
    if (!force && curr?.cases && !curr.casesError) return;

    patchSuite(set, planId, suiteId, { casesLoading: true, casesError: null });

    try {
      const [refs, suites] = await Promise.all([
        listSuiteCases(planId, suiteId),
        listSuites(planId).catch<SuiteRef[]>(() => []),
      ]);
      const total = refs.length;
      const trimmed = refs.slice(0, PROMPT_CASE_CAP);
      const cases: TestCase[] = [];
      const results = await Promise.allSettled(
        trimmed.map((r) => getCase(r.id)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") cases.push(r.value);
      }

      const byId = new Map(suites.map((s) => [s.id, s]));
      const suite = byId.get(suiteId) ?? null;
      const path: string[] = [];
      let cursor = suite?.parentSuiteId ?? null;
      let guard = 0;
      while (cursor != null && guard++ < 64) {
        const parent = byId.get(cursor);
        if (!parent) break;
        if (parent.parentSuiteId == null) break;
        path.unshift(parent.name);
        cursor = parent.parentSuiteId ?? null;
      }

      patchSuite(set, planId, suiteId, {
        cases,
        casesLoading: false,
        casesError: null,
        totalCases: total,
        truncated: total > PROMPT_CASE_CAP,
        suiteName: suite?.name ?? null,
        suitePath: path,
      });
    } catch (e) {
      patchSuite(set, planId, suiteId, {
        casesLoading: false,
        casesError: toAdoError(e),
      });
    }
  },

  setFilter: (planId, suiteId, filter) => {
    patchSuite(set, planId, suiteId, { filter });
  },

  sendMessage: async (planId, suiteId, q) => {
    const text = q.trim();
    if (!text) return;
    const sk = suiteKey(planId, suiteId);
    const suite = get().bySuite.get(sk);
    if (!suite) return;
    if (!suite.cases) return;

    const threadId = get().activeThreadBySuite.get(sk) ?? DEFAULT_THREAD_ID;
    const tk = threadKey(planId, suiteId, threadId);
    const curr = get().byThread.get(tk);
    if (!curr) return;
    if (curr.busy) return;

    // Apply the client-side filter to the prompt context. Bug-shaped
    // filters ("auth", "#123", "totp") narrow what the model sees so
    // suites with hundreds of cases stay tractable.
    const promptCases = applyCaseFilter(suite.cases, suite.filter);

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
    // First user message? Use it as the auto-title.
    const autoTitle =
      curr.messages.length === 0 && !curr.title
        ? text.replace(/\s+/g, " ").trim().slice(0, 60)
        : curr.title;

    patchThread(set, planId, suiteId, threadId, {
      busy: true,
      error: null,
      title: autoTitle,
      messages: [...curr.messages, userMsg, assistantMsg],
    });

    const appendDelta = (delta: string) => {
      if (!delta) return;
      set((s) => {
        const next = new Map(s.byThread);
        const slice = next.get(tk);
        if (!slice) return s;
        let found = false;
        const messages = slice.messages.map((m) => {
          if (m.id !== assistantId) return m;
          found = true;
          return { ...m, content: m.content + delta };
        });
        if (!found) return s;
        next.set(tk, { ...slice, messages });
        return { byThread: next };
      });
      schedulePersist(planId, suiteId, threadId, get);
    };

    // Persist the user message IMMEDIATELY so a quick cancel can't drop it.
    void saveChatThread({
      planId,
      suiteId,
      threadId,
      title: autoTitle,
      modelId: curr.modelId,
      messages: [...curr.messages, userMsg, assistantMsg],
    }).catch((e) => {
      console.warn("[suite-chat] initial-send persist failed:", e);
    });

    const chat = useChatStore.getState();
    const keys = chat.apiKeys;
    const modelId = curr.modelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    const engineSel = selectEngine(modelId);
    const sourceRoot = prefs.sourceRoot ?? null;
    const priorMessages = curr.messages;

    try {
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
        const runId = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        patchThread(set, planId, suiteId, threadId, {
          activeClaudeRunId: runId,
        });
        await streamSuiteChatClaude({
          runId,
          suiteName: suite.suiteName,
          suitePath: suite.suitePath,
          planName: suite.planName,
          cases: promptCases,
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
          suiteName: suite.suiteName,
          suitePath: suite.suitePath,
          planName: suite.planName,
          cases: promptCases,
          history: priorMessages,
          newQuestion: text,
          keys,
          modelId,
          sourceRoot,
          onText: appendDelta,
        });
      }
      set((s) => {
        const next = new Map(s.byThread);
        const slice = next.get(tk);
        if (!slice) return s;
        const messages = slice.messages.map((m) =>
          m.id === assistantId && m.content.length === 0
            ? { ...m, content: "(empty response)" }
            : m,
        );
        next.set(tk, {
          ...slice,
          messages,
          busy: false,
          activeClaudeRunId: null,
        });
        return { byThread: next };
      });
      schedulePersist(planId, suiteId, threadId, get, 50);
      // Bump this thread to the top of the switcher list.
      void refreshThreadList(planId, suiteId, set);
    } catch (e) {
      const cancelled =
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: string }).kind === "cancelled";
      if (!cancelled) console.error("[suite-chat] failed:", e);
      set((s) => {
        const next = new Map(s.byThread);
        const slice = next.get(tk);
        if (!slice) return s;
        const messages = slice.messages.filter((m) => m.id !== assistantId);
        next.set(tk, {
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
        return { byThread: next };
      });
    }
  },

  setModel: (planId, suiteId, modelId) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    patchThread(set, planId, suiteId, threadId, { modelId });
    schedulePersist(planId, suiteId, threadId, get, 50);
  },

  markEditApplied: (planId, suiteId, messageId, blockHash, record) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    const tk = threadKey(planId, suiteId, threadId);
    set((s) => {
      const next = new Map(s.byThread);
      const slice = next.get(tk);
      if (!slice) return s;
      let touched = false;
      const messages = slice.messages.map((m) => {
        if (m.id !== messageId) return m;
        touched = true;
        const prior = m.appliedEdits ?? {};
        return {
          ...m,
          appliedEdits: { ...prior, [blockHash]: record },
        };
      });
      if (!touched) return s;
      next.set(tk, { ...slice, messages });
      return { byThread: next };
    });
    schedulePersist(planId, suiteId, threadId, get, 50);
  },

  clearEditApplied: (planId, suiteId, messageId, blockHash) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    const tk = threadKey(planId, suiteId, threadId);
    set((s) => {
      const next = new Map(s.byThread);
      const slice = next.get(tk);
      if (!slice) return s;
      let touched = false;
      const messages = slice.messages.map((m) => {
        if (m.id !== messageId) return m;
        const prior = m.appliedEdits;
        if (!prior || !(blockHash in prior)) return m;
        touched = true;
        const updated = { ...prior };
        delete updated[blockHash];
        const isEmpty = Object.keys(updated).length === 0;
        return {
          ...m,
          appliedEdits: isEmpty ? undefined : updated,
        };
      });
      if (!touched) return s;
      next.set(tk, { ...slice, messages });
      return { byThread: next };
    });
    schedulePersist(planId, suiteId, threadId, get, 50);
  },

  cancel: (planId, suiteId) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    const curr = get().byThread.get(threadKey(planId, suiteId, threadId));
    if (!curr?.busy) return;
    if (curr.activeClaudeRunId) {
      void cancelClaudeRun(curr.activeClaudeRunId).catch(() => {
        patchThread(set, planId, suiteId, threadId, {
          busy: false,
          activeClaudeRunId: null,
        });
      });
    } else {
      patchThread(set, planId, suiteId, threadId, { busy: false });
    }
  },

  clearMessages: (planId, suiteId) => {
    // "Clear" the active thread — wipes its messages but keeps the slot.
    // The "New thread" button (newThread) is the right call when the user
    // wants to preserve history. This path is left for explicit clears.
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    patchThread(set, planId, suiteId, threadId, {
      messages: [],
      error: null,
      title: null,
    });
    void deleteChatThread({ planId, suiteId, threadId }).catch(() => {});
    void refreshThreadList(planId, suiteId, set);
  },

  dismissError: (planId, suiteId) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    patchThread(set, planId, suiteId, threadId, { error: null });
  },
}));

/** Apply the suite's free-text filter to the case list before it's
 *  serialized into the prompt. Matches against id, title, tags, and step
 *  text so users can scope to "auth" or "#15310" or "rate-limit". Empty
 *  filter = pass through unchanged. */
function applyCaseFilter(cases: TestCase[], filter: string): TestCase[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return cases;
  // Support `#123` as a hard id match.
  const idMatch = needle.match(/^#(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    return cases.filter((c) => c.id === id);
  }
  return cases.filter((c) => {
    if (String(c.id).includes(needle)) return true;
    if (c.title.toLowerCase().includes(needle)) return true;
    if (c.tags.some((t) => t.toLowerCase().includes(needle))) return true;
    for (const step of c.steps) {
      if (step.action.toLowerCase().includes(needle)) return true;
      if (step.expected.toLowerCase().includes(needle)) return true;
    }
    return false;
  });
}
