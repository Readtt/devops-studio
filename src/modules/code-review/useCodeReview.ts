import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { supportsVision, type ModelId } from "@/modules/ai/config";
import {
  adoDiffBranches,
  adoDiffCommit,
  adoDiffPullRequest,
} from "@/modules/ado";
import { describeSource, type CodeReviewSource } from "./source";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { bugsToContextBlocks } from "@/modules/ado/lib/bugContextBlock";
import type { Attachment } from "@/components/chat/attachments";
import type { AppliedPatchRecord } from "@/components/ChatMarkdown";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import {
  streamCodeReview,
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
  error: string | null;
  /** Stable thread id minted at first send. Used to upsert into the
   *  history store so the Chats sidebar can reopen this conversation
   *  later. Null until the first message goes out. */
  threadId: string | null;
  /** Per-tab model override. Null = inherit the global default model.
   *  Setting this here doesn't touch the global default; it scopes only
   *  to this Code Review tab — same pattern as suite-chat's pin. */
  modelId: ModelId | null;
  /** When set, the diff comes from Azure DevOps (commit/PR/branch) instead of
   *  the local working copy. */
  source: CodeReviewSource | null;
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
    /** Persisted ADO source from the tab. Seeds the slice on first mount /
     *  after a reload so an ADO review doesn't revert to the local diff. */
    source?: CodeReviewSource | null,
    /** Persisted per-tab model pin from the tab. Seeds the slice so the
     *  chosen model survives a reload. */
    modelId?: ModelId | null,
  ) => Promise<void>;
  refreshDiff: (tabId: number) => Promise<void>;
  changeBase: (tabId: number, base: string) => Promise<void>;
  setModel: (tabId: number, modelId: ModelId | null) => void;
  /** Switch the review source (Local ⇄ Azure DevOps). Wipes the diff +
   *  conversation (the prior thread was scoped to a different change) and
   *  reloads. Pass null to return to the local working-copy diff. */
  setSource: (tabId: number, source: CodeReviewSource | null) => Promise<void>;
  send: (
    tabId: number,
    text: string,
    attachments?: Attachment[],
    /** Existing ADO bug ids to attach as read-only context for this turn. */
    bugIds?: number[],
  ) => Promise<void>;
  stop: (tabId: number) => void;
  clear: (tabId: number) => void;
  /** Persist an applied code-review patch onto its message so the Applied
   *  state + before/after diff survive a reload. */
  applyPatch: (
    tabId: number,
    messageId: string,
    blockHash: string,
    record: AppliedPatchRecord,
  ) => void;
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

  ensure: async (tabId, cwd, base, rehydrateThreadId, source, modelId) => {
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
        error: null,
        threadId: hist?.id ?? null,
        modelId: modelId ?? null,
        source: source ?? null,
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
      const src = slice.source;
      let diff: DiffSummary;
      if (src?.kind === "ado") {
        if (src.unit === "commit" && src.commitId) {
          diff = await adoDiffCommit(src.repoId, src.commitId);
        } else if (src.unit === "pr" && src.prId != null) {
          diff = await adoDiffPullRequest(src.repoId, src.prId);
        } else if (src.unit === "branch" && src.baseBranch && src.targetBranch) {
          diff = await adoDiffBranches(src.repoId, src.baseBranch, src.targetBranch);
        } else {
          throw new Error("Pick a commit, pull request, or branch to review.");
        }
      } else {
        // Empty base means "auto-detect" — pass undefined to Rust so it
        // walks the main → master → origin/HEAD fallback chain.
        diff = await invoke<DiffSummary>("git_diff", {
          cwd: slice.cwd,
          base: slice.base ? slice.base : undefined,
        });
      }
      patch(set, tabId, {
        diff,
        diffLoading: false,
        // Mirror the resolved base into the picker ONLY for the local diff —
        // there `diff.base` is a real branch the fallback chain picked. For an
        // ADO source `diff.base` is a synthetic label ("<sha>^", a target ref,
        // etc.); writing it into slice.base would corrupt the local base so
        // switching back to Local fails with "base branch '<sha>^' not found".
        ...(src ? {} : { base: diff.base }),
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
    // Persist onto the tab so the pinned model survives a reload.
    useTabsStore.getState().patchCodeReviewTab(tabId, { modelId });
  },

  setSource: async (tabId, source) => {
    const slice = get().byTab.get(tabId);
    if (!slice) return;
    // Switching back to the local diff re-detects the base — otherwise a base
    // left over from an ADO source (a "<sha>^" label) would break git_diff.
    // Switching to an ADO source leaves base alone (it's hidden + unused).
    const nextBase = source ? slice.base : "";
    // Switching the reviewed change invalidates the prior conversation.
    patch(set, tabId, {
      source,
      base: nextBase,
      messages: [],
      error: null,
      diff: null,
      threadId: null,
    });
    // Mirror onto the persisted tab so reload + Duplicate keep this source.
    useTabsStore.getState().patchCodeReviewTab(tabId, { source, base: nextBase });
    await get().refreshDiff(tabId);
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
    // Persist the chosen base so a reload doesn't snap back to the original.
    useTabsStore.getState().patchCodeReviewTab(tabId, { base });
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

    // Tool activity onto the assistant message, upserting by id (running → done).
    const mergeToolEvent = (e: ActivityEntry) => {
      set((s) => {
        const next = new Map(s.byTab);
        const curr = next.get(tabId);
        if (!curr) return s;
        const messages = curr.messages.map((m) => {
          if (m.id !== assistantId) return m;
          const prior = m.toolEvents ?? [];
          const idx = prior.findIndex((x) => x.id === e.id);
          const toolEvents =
            idx >= 0
              ? prior.map((x, i) => (i === idx ? { ...x, ...e } : x))
              : [...prior, e];
          return { ...m, toolEvents };
        });
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
      // ADO source ⇒ tell the runner the diff (not the local checkout the
      // Read/Grep tools see) is authoritative.
      const adoSourceLabel = slice.source ? describeSource(slice.source) : null;
      await streamCodeReview({
        modelId: effectiveModelId,
        keys: chat.apiKeys,
        sourceRoot: slice.cwd,
        diff: slice.diff,
        history: priorMessages,
        newQuestion: text,
        attachments: atts,
        contextBlocks,
        adoSourceLabel,
        onText: appendDelta,
        onToolEvent: mergeToolEvent,
        signal: abort.signal,
      });
      patch(set, tabId, { busy: false, abort: null });
      persistToHistory(tabId, threadId);
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === "AbortError";
      if (aborted) {
        // Leave the partial assistant message in place — useful for the
        // user to see what the model had drafted before they bailed.
        // Persist what we have so the partial review still shows up in
        // the Chats sidebar.
        patch(set, tabId, { busy: false, abort: null });
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

  applyPatch: (tabId, messageId, blockHash, record) => {
    let threadId: string | null = null;
    set((s) => {
      const next = new Map(s.byTab);
      const curr = next.get(tabId);
      if (!curr) return s;
      threadId = curr.threadId;
      const messages = curr.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              appliedPatches: { ...(m.appliedPatches ?? {}), [blockHash]: record },
            }
          : m,
      );
      next.set(tabId, { ...curr, messages });
      return { byTab: next };
    });
    // Re-snapshot to history so the applied state survives a reload.
    if (threadId) persistToHistory(tabId, threadId);
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
    // For an ADO source the diff.base is a synthetic label — don't persist it
    // as a branch (reopening would feed it to the local base picker). The
    // source carries everything an ADO reopen needs.
    base: slice.source ? "" : slice.diff.base,
    head: slice.diff.head,
    title: deriveCodeReviewTitle(
      slice.messages,
      `Review · ${slice.diff.base} → ${slice.diff.head}`,
    ),
    updatedAt: new Date().toISOString(),
    messages: slice.messages,
    source: slice.source,
  });
}
