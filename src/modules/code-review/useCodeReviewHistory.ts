import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodeReviewMessage } from "./runCodeReview";
import type { CodeReviewSource } from "./source";

/**
 * Persistent list of past code-review conversations, surfaced in the
 * Chats sidebar alongside suite-chat history. localStorage-backed via
 * zustand/persist — same store-shape pattern the tabs store uses.
 *
 * Why not SQLite (like chat_threads): code-review threads don't share
 * the suite-chat schema (no planId/suiteId — they're keyed by cwd +
 * base + minted threadId). Rolling our own JSON store keeps the
 * surface narrow without polluting chat_threads with a discriminator
 * column. Migration is trivial later if it makes sense.
 */

export type CodeReviewThread = {
  /** UUID-v4-ish id minted at first message. Stable across sessions. */
  id: string;
  /** Source-root the diff was computed against. */
  cwd: string;
  /** Base branch this thread was compared against. */
  base: string;
  /** HEAD branch at the time of the last update. May be stale by the
   *  time the user reopens. */
  head: string;
  /** Auto-derived from the first user message — first ~60 chars. */
  title: string;
  /** ISO timestamp of last activity. Used for sort + display. */
  updatedAt: string;
  /** Full message log. */
  messages: CodeReviewMessage[];
  /** ADO source (commit/PR/branch) this thread reviewed, if any. Persisted so
   *  reopening from the Chats sidebar restores the same source instead of
   *  snapping back to the local working-copy diff. Absent ⇒ local. */
  source?: CodeReviewSource | null;
};

const MAX_THREADS = 200;

type State = {
  threads: CodeReviewThread[];
  upsert: (thread: CodeReviewThread) => void;
  remove: (id: string) => void;
  get: (id: string) => CodeReviewThread | undefined;
};

export const useCodeReviewHistory = create<State>()(
  persist(
    (set, get) => ({
      threads: [],
      upsert: (thread) => {
        set((s) => {
          const filtered = s.threads.filter((t) => t.id !== thread.id);
          // Newest first; cap so localStorage doesn't grow without bound.
          const next = [thread, ...filtered].slice(0, MAX_THREADS);
          return { threads: next };
        });
      },
      remove: (id) => {
        set((s) => ({ threads: s.threads.filter((t) => t.id !== id) }));
      },
      get: (id) => get().threads.find((t) => t.id === id),
    }),
    {
      name: "devops-studio.code-review-history.v1",
      version: 1,
      // Keep only the threads array in storage — methods are re-bound on
      // hydration via zustand.
      partialize: (s) => ({ threads: s.threads }),
    },
  ),
);

/** Helper: derive a thread title from the first user message. Same shape
 *  the suite-chat auto-titler uses, so the Chats list reads consistently. */
export function deriveCodeReviewTitle(
  messages: CodeReviewMessage[],
  fallback: string,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return fallback;
  const text = firstUser.content.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}
