// In-memory cache + batched fetcher for work-item titles. Callers pass a
// list of ids; the hook fans out exactly one batch request per render to
// fill any cache misses, debouncing rapid changes. Returns a stable
// id → title map so render code can do `titles.get(id)` synchronously.

import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { getWorkItemTitles } from "@/modules/ado";

type TitleCache = {
  titles: Map<number, string>;
  pending: Set<number>;
  failed: Set<number>;
  /** Resolve a list of ids: synchronously schedules a batch fetch for any
   *  ids we haven't seen. Hook callers re-render via local state when the
   *  store updates. */
  request: (ids: number[]) => void;
  /** Re-fetch the given ids even if they're already cached. Used to pick up
   *  renames made outside the app (e.g. directly in the ADO web UI) when
   *  our window regains focus. */
  forceRefresh: (ids: number[]) => void;
};

const useTitleCache = create<TitleCache>((set, get) => ({
  titles: new Map(),
  pending: new Set(),
  failed: new Set(),
  request: (ids) => {
    const { titles, pending, failed } = get();
    const missing = ids.filter(
      (id) => !titles.has(id) && !pending.has(id) && !failed.has(id),
    );
    if (missing.length === 0) return;
    set((s) => ({
      pending: new Set([...s.pending, ...missing]),
    }));
    void getWorkItemTitles(missing)
      .then((rows) => {
        set((s) => {
          const titlesNext = new Map(s.titles);
          for (const row of rows) titlesNext.set(row.id, row.title);
          const pendingNext = new Set(s.pending);
          const failedNext = new Set(s.failed);
          for (const id of missing) {
            pendingNext.delete(id);
            // Mark as failed if the batch came back without this id — ADO
            // returns the items it could resolve and silently drops the rest.
            if (!titlesNext.has(id)) failedNext.add(id);
          }
          return {
            titles: titlesNext,
            pending: pendingNext,
            failed: failedNext,
          };
        });
      })
      .catch(() => {
        set((s) => {
          const pendingNext = new Set(s.pending);
          const failedNext = new Set(s.failed);
          for (const id of missing) {
            pendingNext.delete(id);
            failedNext.add(id);
          }
          return { pending: pendingNext, failed: failedNext };
        });
      });
  },
  forceRefresh: (ids) => {
    if (ids.length === 0) return;
    set((s) => ({
      pending: new Set([...s.pending, ...ids]),
    }));
    void getWorkItemTitles(ids)
      .then((rows) => {
        set((s) => {
          const titlesNext = new Map(s.titles);
          for (const row of rows) titlesNext.set(row.id, row.title);
          const pendingNext = new Set(s.pending);
          const failedNext = new Set(s.failed);
          for (const id of ids) {
            pendingNext.delete(id);
            // A successful refresh resets the failed bit — the id may have
            // come back alive (permission fix, link repaired, etc).
            failedNext.delete(id);
            if (!titlesNext.has(id)) failedNext.add(id);
          }
          return {
            titles: titlesNext,
            pending: pendingNext,
            failed: failedNext,
          };
        });
      })
      .catch(() => {
        set((s) => {
          const pendingNext = new Set(s.pending);
          for (const id of ids) pendingNext.delete(id);
          return { pending: pendingNext };
        });
      });
  },
}));

export function useWorkItemTitles(ids: number[]): {
  titleFor: (id: number) => string | null;
  loadingFor: (id: number) => boolean;
  /** Re-fetch the current ids regardless of cache state. Wire to focus
   *  events when the caller wants to catch renames made outside the app. */
  refresh: () => void;
} {
  const titles = useTitleCache((s) => s.titles);
  const pending = useTitleCache((s) => s.pending);
  const request = useTitleCache((s) => s.request);
  const forceRefresh = useTitleCache((s) => s.forceRefresh);
  // Stable key so the effect doesn't refire on every render with the same
  // ids in the same order.
  const [keyState, setKeyState] = useState<string>("");
  useEffect(() => {
    const next = ids.slice().sort((a, b) => a - b).join(",");
    if (next !== keyState) setKeyState(next);
  }, [ids, keyState]);
  useEffect(() => {
    if (ids.length > 0) request(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyState]);

  // Snapshot the latest id set in a closure so callers don't need to pass
  // them back in — refresh() always operates on whatever the hook is
  // currently watching.
  const refresh = useCallback(() => {
    if (ids.length > 0) forceRefresh(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyState, forceRefresh]);

  return {
    titleFor: (id: number) => titles.get(id) ?? null,
    loadingFor: (id: number) => pending.has(id),
    refresh,
  };
}
