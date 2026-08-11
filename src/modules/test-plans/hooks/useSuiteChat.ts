// Per-suite chat threads + case cache. One store, keyed by
// `${planId}:${suiteId}:${threadId}` so the user can have several parallel
// threads on the same suite — "New thread" creates a brand-new thread id
// rather than wiping the existing one. Cases (the prompt context) are
// cached per (planId, suiteId) and shared across every thread on that suite.

import { create } from "zustand";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  adoErrorMessage,
  getBug,
  getCase,
  isRequirementSuite,
  listSuiteCases,
  listSuites,
  toAdoError,
  toTargetRequirement,
  type AdoError,
  type SuiteRef,
  type SuiteType,
  type TargetRequirement,
  type TestCase,
} from "@/modules/ado";
import { isKnownModelId, supportsVision, type ModelId } from "@/modules/ai/config";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import type { Attachment } from "@/components/chat/attachments";
import {
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import {
  newSuiteChatMessageId,
  streamSuiteChatTask,
  type ContextWorkItem,
  type SuiteChatMessage,
} from "../lib/runSuiteChat";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import {
  DEFAULT_THREAD_ID,
  deleteChatThread,
  listChatThreadsForSuite,
  newThreadId,
  saveChatThread,
  type StoredChatThread,
} from "../lib/chatThreadsApi";
import { getConfidenceMany } from "../lib/confidenceApi";
import type { ConfidenceVerdict } from "../lib/confidence";

/** Cap on the number of cases we'll embed in a single chat prompt. Past
 *  this size the system prompt overwhelms most context windows AND the
 *  user is unlikely to be asking suite-wide questions anyway. We surface
 *  the truncation explicitly so the user knows what got cut. */
export const PROMPT_CASE_CAP = 50;

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
  /** Suite's ADO type, so the prompt can say what kind of suite this is and
   *  the create-case action can refuse a read-only (query-based) one. */
  suiteType: SuiteType | null;
  /** The work item a requirement-based suite tracks, loaded alongside the
   *  cases so coverage questions can be answered against its acceptance
   *  criteria. Null for every other suite type, and on a failed fetch. */
  requirement: TargetRequirement | null;
  /** Tracked work-item id off the suite ref. Non-null whenever the suite is
   *  requirement-based, INCLUDING when the `requirement` fetch above failed —
   *  that's the whole point of keeping it separate. */
  requirementId: number | null;
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
  suiteType: null,
  requirement: null,
  requirementId: null,
  filter: "",
});

const initialThreadState = (threadId: string): ThreadState => ({
  threadId,
  title: null,
  messages: [],
  busy: false,
  error: null,
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
  /** Cheap freshness pass before a send: re-list the suite's cases (one call)
   *  and reconcile the cached snapshot — drop cases deleted in ADO, pull
   *  details only for newly-added ones. Stops the chat answering about cases
   *  that no longer exist after an external delete + explorer refresh. */
  reconcileCases: (planId: number, suiteId: number) => Promise<void>;
  setFilter: (planId: number, suiteId: number, filter: string) => void;

  sendMessage: (
    planId: number,
    suiteId: number,
    q: string,
    attachments?: Attachment[],
    /** Work items the user #mentioned this turn, attached as read-only
     *  context. Carries title + type so the context chip can list them. */
    workItems?: ContextWorkItem[],
  ) => Promise<void>;
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
        // A model retired since this thread was saved would crash the picker
        // and runner (both call the throwing getModel) — fall back to "use the
        // global default" rather than pinning a ghost.
        modelId:
          stored.modelId && isKnownModelId(stored.modelId)
            ? stored.modelId
            : null,
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
// In-flight stream abort handles, keyed by threadKey. cancel() aborts the entry
// so Stop actually tears down the upstream request (and stops billing) instead
// of letting the stream run to completion behind a flipped busy flag.
const streamControllers = new Map<string, AbortController>();
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

/** Persist immediately (no throttle window). Used right after an edit is
 *  applied or undone so closing the tab a beat later can't drop the applied
 *  state — a throttled write could still be pending when the pane unmounts. */
function flushPersist(
  planId: number,
  suiteId: number,
  threadId: string,
  get: () => Store,
) {
  const k = threadKey(planId, suiteId, threadId);
  const existing = persistTimers.get(k);
  if (existing) {
    clearTimeout(existing);
    persistTimers.delete(k);
  }
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
    console.warn("[suite-chat] eager persist failed:", e);
  });
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
    // Resolve the new active thread synchronously so we can guarantee a
    // slice for it exists in byThread before the store update lands —
    // without that guarantee SuiteChatPane reads `byThread.get(...)` as
    // undefined and renders the skeleton forever.
    const currState = get();
    const priorList = (currState.threadListBySuite.get(sk) ?? []).filter(
      (t) => t.threadId !== threadId,
    );
    const wasActive = currState.activeThreadBySuite.get(sk) === threadId;
    const nextActiveId = wasActive
      ? priorList[0]?.threadId ?? DEFAULT_THREAD_ID
      : currState.activeThreadBySuite.get(sk) ?? DEFAULT_THREAD_ID;
    const nextActiveKey = threadKey(planId, suiteId, nextActiveId);
    const needsFreshSlice =
      wasActive && !currState.byThread.has(nextActiveKey);

    set((curr) => {
      const nextByThread = new Map(curr.byThread);
      nextByThread.delete(tk);
      if (needsFreshSlice) {
        // Seed the fallback with `hydrated: false` so hydrateThread (below)
        // can run and either load persisted messages or finalise an empty
        // thread. Either way the skeleton clears once this slice lands.
        nextByThread.set(nextActiveKey, initialThreadState(nextActiveId));
      }
      const nextList = new Map(curr.threadListBySuite);
      nextList.set(sk, priorList);
      const nextActive = new Map(curr.activeThreadBySuite);
      if (wasActive) nextActive.set(sk, nextActiveId);
      return {
        byThread: nextByThread,
        threadListBySuite: nextList,
        activeThreadBySuite: nextActive,
      };
    });
    if (needsFreshSlice) {
      void hydrateThread(planId, suiteId, nextActiveId, set, get);
    }
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

      // The suite object is already in hand from the listSuites above, so the
      // type costs nothing. Only the requirement needs a fetch, and only for
      // the one suite type that has one.
      let requirement: TargetRequirement | null = null;
      if (suite && isRequirementSuite(suite) && suite.requirementId != null) {
        // Best-effort, matching how this loader treats every other optional
        // input: a chat without the requirement is degraded, not broken.
        requirement = await getBug(suite.requirementId)
          .then(toTargetRequirement)
          .catch(() => null);
      }

      patchSuite(set, planId, suiteId, {
        cases,
        casesLoading: false,
        casesError: null,
        totalCases: total,
        truncated: total > PROMPT_CASE_CAP,
        suiteName: suite?.name ?? null,
        suitePath: path,
        suiteType: suite?.suiteType ?? null,
        requirement,
        // Off the suite ref, so a failed body fetch still leaves the chat able
        // to name the requirement it couldn't read.
        requirementId:
          suite && isRequirementSuite(suite) ? suite.requirementId ?? null : null,
      });
    } catch (e) {
      patchSuite(set, planId, suiteId, {
        casesLoading: false,
        casesError: toAdoError(e),
      });
    }
  },

  reconcileCases: async (planId, suiteId) => {
    const sk = suiteKey(planId, suiteId);
    const curr = get().bySuite.get(sk);
    // Only meaningful once an initial load populated the snapshot; otherwise
    // the send path's own guard / loadCases handles it.
    if (!curr?.cases || curr.casesLoading) return;
    try {
      const refs = await listSuiteCases(planId, suiteId);
      const cachedById = new Map(curr.cases.map((c) => [c.id, c]));
      const trimmed = refs.slice(0, PROMPT_CASE_CAP);
      // Fetch details only for cases we don't already have cached.
      const missingIds = trimmed
        .map((r) => r.id)
        .filter((id) => !cachedById.has(id));
      const fetched = new Map<number, TestCase>();
      if (missingIds.length > 0) {
        const results = await Promise.allSettled(
          missingIds.map((id) => getCase(id)),
        );
        for (const r of results) {
          if (r.status === "fulfilled") fetched.set(r.value.id, r.value);
        }
      }
      // Rebuild in ADO order: keep cached detail for present cases, splice in
      // freshly-fetched new ones, and naturally drop any deleted case (it's no
      // longer in `refs`).
      const next: TestCase[] = [];
      for (const r of trimmed) {
        const existing = cachedById.get(r.id) ?? fetched.get(r.id);
        if (existing) next.push(existing);
      }
      patchSuite(set, planId, suiteId, {
        cases: next,
        totalCases: refs.length,
        truncated: refs.length > PROMPT_CASE_CAP,
      });
    } catch {
      // Non-fatal — fall back to the cached snapshot rather than block the send.
    }
  },

  setFilter: (planId, suiteId, filter) => {
    patchSuite(set, planId, suiteId, { filter });
  },

  sendMessage: async (planId, suiteId, q, attachments, workItems) => {
    const text = q.trim();
    const bugIds =
      workItems && workItems.length > 0 ? workItems.map((w) => w.id) : undefined;
    const atts = attachments && attachments.length > 0 ? attachments : undefined;
    if (!text && !atts) return;
    const sk = suiteKey(planId, suiteId);
    let suite = get().bySuite.get(sk);
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
    // Reconcile the cached cases against ADO so a case deleted or added
    // externally (then an explorer refresh) is reflected in THIS turn's
    // context — the stale snapshot was a reported bug. One list call; details
    // are fetched only for genuinely new cases.
    await get().reconcileCases(planId, suiteId);
    suite = get().bySuite.get(sk) ?? suite;
    if (!suite.cases) return;

    const promptCases = applyCaseFilter(suite.cases, suite.filter);

    const userMsg: SuiteChatMessage = {
      id: newSuiteChatMessageId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: atts,
      bugContext: bugIds && bugIds.length > 0 ? bugIds : undefined,
      contextWorkItems:
        workItems && workItems.length > 0 ? workItems : undefined,
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
        ? (text || "Image attachment").replace(/\s+/g, " ").trim().slice(0, 60)
        : curr.title;

    // Register the abort handle BEFORE flipping busy (which makes Stop live)
    // and before the pre-stream prep awaits below (ensureApiKeys, best-practice
    // load, bug/confidence fetches). If it were created only just before the
    // stream call, a Stop during that prep window would find no controller and
    // the run would continue — and bill — to completion. cancel() aborts this
    // signal; the stream call is passed it and rejects (AbortError) at once.
    const ac = new AbortController();
    streamControllers.set(tk, ac);
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

    // Tool activity (Read/Glob/Grep) → accumulate onto the assistant message,
    // upserting by id so a tool_use (running) is later completed in place by
    // its tool_result. Persisted with the thread so the strip survives reload.
    const mergeToolEvent = (e: ActivityEntry) => {
      set((s) => {
        const next = new Map(s.byThread);
        const slice = next.get(tk);
        if (!slice) return s;
        let found = false;
        const messages = slice.messages.map((m) => {
          if (m.id !== assistantId) return m;
          found = true;
          const prior = m.toolEvents ?? [];
          const idx = prior.findIndex((x) => x.id === e.id);
          const toolEvents =
            idx >= 0
              ? prior.map((x, i) => (i === idx ? { ...x, ...e } : x))
              : [...prior, e];
          return { ...m, toolEvents };
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
    const keys = await chat.ensureApiKeys();
    const modelId = curr.modelId ?? chat.selectedModelId;
    const prefs = usePreferencesStore.getState();
    // Global code-search toggle gates source access for every surface.
    const sourceRoot = prefs.codeSearchEnabled ? (prefs.sourceRoot ?? null) : null;
    const priorMessages = curr.messages;
    // Best-practices standards injected as context; vision support depends on
    // the chosen model.
    const { blocks: bpBlocks } = await loadBestPracticeBlocks(
      prefs.bestPracticeFiles,
      { visionCapable: supportsVision(modelId) },
    );
    // Bugs LINKED to the in-scope cases are auto-injected as context the same
    // way the cases themselves are — the model sees the open defects without
    // the user attaching anything. Merged with any work items the user
    // mentioned with #id, deduped, and capped so a huge suite can't blow the
    // prompt budget.
    const linkedBugIds = collectLinkedBugIds(promptCases, LINKED_BUG_CAP);
    const mergedBugIds = Array.from(
      new Set([...(bugIds ?? []), ...linkedBugIds]),
    );
    const bugBlocks =
      mergedBugIds.length > 0 ? await bugsToContextBlocks(mergedBugIds) : [];
    const contextBlocks = [...bpBlocks, ...bugBlocks];

    // Stored AI confidence verdicts for the in-scope cases, surfaced per case
    // so the model can cite pass-readiness without re-evaluating. Best-effort;
    // most cases won't have one until they've been evaluated somewhere.
    const confidenceById = await getConfidenceMany(
      promptCases.map((c) => c.id),
    ).catch(() => new Map<number, ConfidenceVerdict>());
    const confidence: Record<
      number,
      { passLikelihood: number; predictedOutcome: string }
    > = {};
    for (const [id, v] of confidenceById) {
      confidence[id] = {
        passLikelihood: v.passLikelihood,
        predictedOutcome: v.predictedOutcome,
      };
    }

    try {
      await streamSuiteChatTask({
        suiteName: suite.suiteName,
        suitePath: suite.suitePath,
        planName: suite.planName,
        suiteType: suite.suiteType,
        requirement: suite.requirement,
        requirementId: suite.requirementId,
        cases: promptCases,
        history: priorMessages,
        newQuestion: text,
        attachments: atts,
        contextBlocks,
        confidence,
        keys,
        modelId,
        local: localProviderConfig(prefs),
        sourceRoot,
        customInstructions: prefs.customInstructions || undefined,
        onText: appendDelta,
        onToolEvent: mergeToolEvent,
        signal: ac.signal,
      });
      // If Stop fired while the stream was resolving (the same-tick race the
      // AbortError catch can't catch, or a Stop during pre-stream prep that let
      // an already-aborted signal slip through), this run was cancelled. Drop
      // the empty placeholder and bail so a "stopped" answer can't land in a
      // thread the user believes is idle. A newer send for this thread replacing
      // the controller is treated the same way.
      if (ac.signal.aborted || streamControllers.get(tk) !== ac) {
        set((s) => {
          const next = new Map(s.byThread);
          const slice = next.get(tk);
          if (!slice) return s;
          next.set(tk, {
            ...slice,
            messages: slice.messages.filter((m) => m.id !== assistantId),
          });
          return { byThread: next };
        });
        flushPersist(planId, suiteId, threadId, get);
        return;
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
        });
        return { byThread: next };
      });
      schedulePersist(planId, suiteId, threadId, get, 50);
      // Bump this thread to the top of the switcher list.
      void refreshThreadList(planId, suiteId, set);
    } catch (e) {
      // Treat both our tagged cancel and an aborted-stream AbortError as the
      // cancelled path (drop the placeholder, no error toast).
      const name = (e as { name?: string } | null)?.name;
      const cancelled =
        (typeof e === "object" &&
          e !== null &&
          (e as { kind?: string }).kind === "cancelled") ||
        name === "AbortError";
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
          error: cancelled
            ? null
            : typeof e === "object" &&
                e !== null &&
                (e as { kind?: string }).kind
              ? adoErrorMessage(toAdoError(e))
              : // Strip the JS "Error: " prefix so a thrown Error (e.g. the
                // missing-key message) reads as guidance, not a leaked stack.
                e instanceof Error
                ? e.message
                : String(e),
        });
        return { byThread: next };
      });
      // Reconcile disk with memory. The initial send eagerly persisted
      // [user, emptyAssistant] (so a fast cancel can't drop the question),
      // and a mid-stream throttled write may have saved a partial assistant.
      // We just dropped that assistant from state — without this flush the
      // stale row survives in SQLite and reappears, broken, on the next
      // reload. Flush (not schedule) so a reload a beat later sees the truth.
      flushPersist(planId, suiteId, threadId, get);
    } finally {
      // Only clear our own handle — a newer send for this thread may have
      // already replaced it, and cancel() may have removed it already.
      if (streamControllers.get(tk) === ac) streamControllers.delete(tk);
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
    // Eager flush — an applied edit must survive an immediate tab close.
    flushPersist(planId, suiteId, threadId, get);
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
    // Eager flush — an undo must survive an immediate tab close too.
    flushPersist(planId, suiteId, threadId, get);
  },

  cancel: (planId, suiteId) => {
    const threadId =
      get().activeThreadBySuite.get(suiteKey(planId, suiteId)) ??
      DEFAULT_THREAD_ID;
    const tk = threadKey(planId, suiteId, threadId);
    const curr = get().byThread.get(tk);
    if (!curr?.busy) return;
    // Abort the in-flight stream — this tears down the upstream request (the
    // Rust proxy drops the connection) so the model actually stops generating
    // (and billing), not just visually. The catch path drops the placeholder
    // and clears busy; we also flip busy here so the UI unsticks immediately.
    streamControllers.get(tk)?.abort();
    streamControllers.delete(tk);
    patchThread(set, planId, suiteId, threadId, { busy: false });
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

/** Bug-shaped link kinds on a test case. ADO surfaces a case↔bug link as
 *  "Tested by" (the case tests this bug) or "Tests" (inverse); both mean a
 *  defect related to the case, which is what we want to auto-inject. */
const BUG_LINK_KINDS = new Set(["Tested by", "Tests"]);

/** Cap on how many linked bugs auto-inject into suite-chat context. Exported
 *  so the context chip can show the same number the runner uses. */
export const LINKED_BUG_CAP = 25;

/** Collect unique bug ids linked to the given cases, capped. Drives the
 *  auto-injection of linked bugs into suite-chat context. */
export function collectLinkedBugIds(cases: TestCase[], cap: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of cases) {
    for (const lwi of c.linkedWorkItems) {
      if (!BUG_LINK_KINDS.has(lwi.kind) || seen.has(lwi.id)) continue;
      seen.add(lwi.id);
      out.push(lwi.id);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Apply the suite's free-text filter to the case list before it's
 *  serialized into the prompt. Matches against id, title, tags, and step
 *  text so users can scope to "auth" or "#15310" or "rate-limit". Empty
 *  filter = pass through unchanged. */
export function applyCaseFilter(cases: TestCase[], filter: string): TestCase[] {
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
