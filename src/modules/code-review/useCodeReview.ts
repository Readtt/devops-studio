import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  streamCodeReview,
  type CodeReviewMessage,
  type DiffSummary,
} from "./runCodeReview";

type TabSlice = {
  /** Resolved by the first ensure() call; persists for the tab lifetime. */
  cwd: string;
  /** Base branch the diff is computed against. User can change it via the
   *  header picker; switching wipes the thread (the conversation context
   *  no longer matches a different baseline). */
  base: string;
  diff: DiffSummary | null;
  diffLoading: boolean;
  diffError: string | null;
  messages: CodeReviewMessage[];
  busy: boolean;
  /** Renderer's cancel button. Aborts the streamText call cooperatively. */
  abort: AbortController | null;
  error: string | null;
};

type State = {
  byTab: Map<number, TabSlice>;
  ensure: (tabId: number, cwd: string, base?: string | null) => Promise<void>;
  refreshDiff: (tabId: number) => Promise<void>;
  changeBase: (tabId: number, base: string) => Promise<void>;
  send: (tabId: number, text: string) => Promise<void>;
  stop: (tabId: number) => void;
  clear: (tabId: number) => void;
};

function newId(): string {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function patch(set: (fn: (s: State) => Partial<State>) => void, tabId: number, partial: Partial<TabSlice>) {
  set((s) => {
    const next = new Map(s.byTab);
    const curr = next.get(tabId);
    if (!curr) return s;
    next.set(tabId, { ...curr, ...partial });
    return { byTab: next };
  });
}

export const useCodeReview = create<State>((set, get) => ({
  byTab: new Map(),

  ensure: async (tabId, cwd, base) => {
    const existing = get().byTab.get(tabId);
    if (existing && existing.cwd === cwd) {
      // Already initialised for this cwd. If the diff is missing (e.g.
      // earlier load errored), nudge a refresh — but don't clobber the
      // message history.
      if (!existing.diff && !existing.diffLoading) {
        await get().refreshDiff(tabId);
      }
      return;
    }
    set((s) => {
      const next = new Map(s.byTab);
      next.set(tabId, {
        cwd,
        base: base ?? "main",
        diff: null,
        diffLoading: false,
        diffError: null,
        messages: [],
        busy: false,
        abort: null,
        error: null,
      });
      return { byTab: next };
    });
    await get().refreshDiff(tabId);
  },

  refreshDiff: async (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    patch(set, tabId, { diffLoading: true, diffError: null });
    try {
      const diff = await invoke<DiffSummary>("git_diff", {
        cwd: slice.cwd,
        base: slice.base,
      });
      patch(set, tabId, {
        diff,
        diffLoading: false,
        // If the Rust side resolved a different base than we requested
        // (fallback chain), reflect it in the picker so the user sees the
        // truth.
        base: diff.base,
      });
    } catch (e) {
      patch(set, tabId, {
        diffLoading: false,
        diffError: typeof e === "string" ? e : (e as Error).message ?? String(e),
      });
    }
  },

  changeBase: async (tabId, base) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    if (slice.base === base) return;
    // Wipe the thread — the prior conversation was scoped to the old
    // baseline, and replaying it against a new diff would confuse the
    // model. The user can always start a fresh review.
    patch(set, tabId, {
      base,
      messages: [],
      error: null,
      diff: null,
    });
    await get().refreshDiff(tabId);
  },

  send: async (tabId, text) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    if (!slice.diff) {
      patch(set, tabId, { error: "Diff hasn't loaded yet — wait a moment and retry." });
      return;
    }

    const userMsg: CodeReviewMessage = {
      id: newId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    const assistantId = newId();
    const assistantMsg: CodeReviewMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    const abort = new AbortController();
    const priorMessages = slice.messages;

    patch(set, tabId, {
      busy: true,
      error: null,
      messages: [...priorMessages, userMsg, assistantMsg],
      abort,
    });

    const appendDelta = (delta: string) => {
      if (!delta) return;
      set((s) => {
        const next = new Map(s.byTab);
        const curr = next.get(tabId);
        if (!curr) return s;
        const messages = curr.messages.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        );
        next.set(tabId, { ...curr, messages });
        return { byTab: next };
      });
    };

    try {
      const chat = useChatStore.getState();
      const prefs = usePreferencesStore.getState();
      await streamCodeReview({
        modelId: prefs.defaultModelId,
        keys: chat.apiKeys,
        sourceRoot: slice.cwd,
        diff: slice.diff,
        history: priorMessages,
        newQuestion: text,
        onText: appendDelta,
        signal: abort.signal,
      });
      patch(set, tabId, { busy: false, abort: null });
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === "AbortError";
      if (aborted) {
        // Leave the partial assistant message in place — useful for the
        // user to see what the model had drafted before they bailed.
        patch(set, tabId, { busy: false, abort: null });
        return;
      }
      console.error("[code-review] stream failed:", e);
      set((s) => {
        const next = new Map(s.byTab);
        const curr = next.get(tabId);
        if (!curr) return s;
        const messages = curr.messages.filter((m) => m.id !== assistantId);
        next.set(tabId, {
          ...curr,
          busy: false,
          abort: null,
          messages,
          error: typeof e === "string" ? e : (e as Error).message ?? String(e),
        });
        return { byTab: next };
      });
    }
  },

  stop: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice?.abort) return;
    slice.abort.abort();
  },

  clear: (tabId) => {
    patch(set, tabId, { messages: [], error: null });
  },
}));
