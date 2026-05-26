import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { supportsVision, type ModelId } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import { resolveClaudeModelId, selectEngine } from "@/modules/ai/lib/engine";
import { cancelClaudeRun } from "@/modules/ai/lib/claude";
import type { Attachment } from "@/components/chat/attachments";
import {
  streamCodeReview,
  streamCodeReviewClaude,
  type CodeReviewMessage,
  type DiffSummary,
} from "./runCodeReview";
import {
  deriveCodeReviewTitle,
  useCodeReviewHistory,
} from "./useCodeReviewHistory";

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
  /** Renderer's cancel button. Aborts the streamText call cooperatively
   *  (Vercel path). */
  abort: AbortController | null;
  /** Active Claude CLI run id, set while the CLI engine is streaming so Stop
   *  can cancel the subprocess. Null on the Vercel path. */
  activeClaudeRunId: string | null;
  error: string | null;
  /** Stable thread id minted at first send. Used to upsert into the
   *  history store so the Chats sidebar can reopen this conversation
   *  later. Null until the first message goes out. */
  threadId: string | null;
  /** Per-tab model override. Null = inherit the global default model.
   *  Setting this here doesn't touch the global default; it scopes only
   *  to this Code Review tab — same pattern as suite-chat's pin. */
  modelId: ModelId | null;
};

type State = {
  byTab: Map<number, TabSlice>;
  ensure: (
    tabId: number,
    cwd: string,
    base?: string | null,
    /** Optional thread to rehydrate from. Used when the Chats sidebar
     *  reopens a past review. */
    rehydrateThreadId?: string | null,
  ) => Promise<void>;
  refreshDiff: (tabId: number) => Promise<void>;
  changeBase: (tabId: number, base: string) => Promise<void>;
  setModel: (tabId: number, modelId: ModelId | null) => void;
  send: (
    tabId: number,
    text: string,
    attachments?: Attachment[],
    /** Existing ADO bug ids to attach as read-only context for this turn. */
    bugIds?: number[],
  ) => Promise<void>;
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

  ensure: async (tabId, cwd, base, rehydrateThreadId) => {
    const existing = get().byTab.get(tabId);
    if (existing && existing.cwd === cwd) {
      if (!existing.diff && !existing.diffLoading) {
        await get().refreshDiff(tabId);
      }
      return;
    }
    // Optional rehydration from history. Chats sidebar passes a threadId
    // when the user clicks a past review row — we preload the messages
    // so the conversation is visible while the (current!) diff loads
    // alongside.
    const hist = rehydrateThreadId
      ? useCodeReviewHistory.getState().get(rehydrateThreadId)
      : undefined;
    // Don't default to "main" eagerly — the repo may not have main
    // (master, develop, or an entirely different convention). Empty
    // string means "auto-detect", which makes refreshDiff hand
    // `base: undefined` to Rust so its fallback chain runs (main →
    // master → origin/HEAD → user error). Once git_diff resolves we
    // patch the real base into the slice.
    const initialBase = hist?.base ?? base ?? "";
    set((s) => {
      const next = new Map(s.byTab);
      next.set(tabId, {
        cwd,
        base: initialBase,
        diff: null,
        diffLoading: false,
        diffError: null,
        messages: hist?.messages ?? [],
        busy: false,
        abort: null,
        activeClaudeRunId: null,
        error: null,
        threadId: hist?.id ?? null,
        modelId: null,
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
      // Empty base means "auto-detect" — pass undefined to Rust so it
      // walks the main → master → origin/HEAD fallback chain.
      const diff = await invoke<DiffSummary>("git_diff", {
        cwd: slice.cwd,
        base: slice.base ? slice.base : undefined,
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

  setModel: (tabId, modelId) => {
    patch(set, tabId, { modelId });
  },

  changeBase: async (tabId, base) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    if (slice.base === base) return;
    // Wipe the thread — the prior conversation was scoped to the old
    // baseline. Mint a fresh thread id on the next send so the new
    // conversation lands as a separate history entry.
    patch(set, tabId, {
      base,
      messages: [],
      error: null,
      diff: null,
      threadId: null,
    });
    await get().refreshDiff(tabId);
  },

  send: async (tabId, text, attachments, bugIds) => {
    const slice = get().byTab.get(tabId);
    if (!slice || slice.busy) return;
    if (!slice.diff) {
      patch(set, tabId, { error: "Diff hasn't loaded yet — wait a moment and retry." });
      return;
    }

    const atts = attachments && attachments.length > 0 ? attachments : undefined;
    const userMsg: CodeReviewMessage = {
      id: newId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: atts,
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
    // Mint a stable thread id at first send so history snapshots line up
    // across refreshes. Keep the same id once we've got one.
    const threadId = slice.threadId ?? newId();

    patch(set, tabId, {
      busy: true,
      error: null,
      messages: [...priorMessages, userMsg, assistantMsg],
      abort,
      threadId,
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
      // Per-tab pinned model wins; otherwise inherit the global default.
      const effectiveModelId = slice.modelId ?? prefs.defaultModelId;
      const { blocks: bpBlocks, warnings } = await loadBestPracticeBlocks(
        prefs.bestPracticeFiles,
        { visionCapable: supportsVision(effectiveModelId) },
      );
      if (warnings.length > 0) {
        console.warn("[code-review] best-practices skipped:", warnings);
      }
      const bugBlocks =
        bugIds && bugIds.length > 0 ? await bugsToContextBlocks(bugIds) : [];
      const contextBlocks = [...bpBlocks, ...bugBlocks];
      const engineSel = selectEngine(effectiveModelId);
      if (engineSel.engine === "claude-agent-sdk" && engineSel.active) {
        // Claude Code (OAuth) path — works without a BYOK API key.
        const runId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        patch(set, tabId, { activeClaudeRunId: runId });
        await streamCodeReviewClaude({
          modelId: resolveClaudeModelId(effectiveModelId) as typeof effectiveModelId,
          keys: chat.apiKeys,
          sourceRoot: slice.cwd,
          diff: slice.diff,
          history: priorMessages,
          newQuestion: text,
          attachments: atts,
          contextBlocks,
          onText: appendDelta,
          authMode: engineSel.authMode ?? "api-key",
          bareMode: prefs.claudeBareMode,
          runId,
        });
      } else {
        await streamCodeReview({
          modelId: effectiveModelId,
          keys: chat.apiKeys,
          sourceRoot: slice.cwd,
          diff: slice.diff,
          history: priorMessages,
          newQuestion: text,
          attachments: atts,
          contextBlocks,
          onText: appendDelta,
          signal: abort.signal,
        });
      }
      patch(set, tabId, { busy: false, abort: null, activeClaudeRunId: null });
      persistToHistory(tabId, threadId);
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === "AbortError";
      if (aborted) {
        // Leave the partial assistant message in place — useful for the
        // user to see what the model had drafted before they bailed.
        // Persist what we have so the partial review still shows up in
        // the Chats sidebar.
        patch(set, tabId, { busy: false, abort: null, activeClaudeRunId: null });
        persistToHistory(tabId, threadId);
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
          activeClaudeRunId: null,
          messages,
          error: typeof e === "string" ? e : (e as Error).message ?? String(e),
        });
        return { byTab: next };
      });
    }
  },

  stop: (tabId) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    // Claude CLI path cancels the subprocess by run id; the Vercel path aborts
    // the streamText controller.
    if (slice.activeClaudeRunId) {
      void cancelClaudeRun(slice.activeClaudeRunId).catch(() => undefined);
      patch(set, tabId, { activeClaudeRunId: null });
      return;
    }
    if (slice.abort) slice.abort.abort();
  },

  clear: (tabId) => {
    // Don't blow away the threadId — clear() also wipes the persisted
    // history entry for it so the Chats sidebar follows along. If the
    // user types again, a fresh threadId mints on the next send.
    const slice = get().byTab.get(tabId);
    if (slice?.threadId) {
      useCodeReviewHistory.getState().remove(slice.threadId);
    }
    patch(set, tabId, { messages: [], error: null, threadId: null });
  },
}));

/** Snapshot the tab's current state into the persisted history store.
 *  Called after every successful send and after a user-cancelled send so
 *  partial reviews still surface in the Chats sidebar. */
function persistToHistory(tabId: number, threadId: string): void {
  const slice = useCodeReview.getState().byTab.get(tabId);
  if (!slice || !slice.diff) return;
  if (slice.messages.length === 0) return;
  useCodeReviewHistory.getState().upsert({
    id: threadId,
    cwd: slice.cwd,
    base: slice.diff.base,
    head: slice.diff.head,
    title: deriveCodeReviewTitle(
      slice.messages,
      `Review · ${slice.diff.base} → ${slice.diff.head}`,
    ),
    updatedAt: new Date().toISOString(),
    messages: slice.messages,
  });
}
