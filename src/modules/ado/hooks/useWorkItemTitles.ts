// In-memory cache + batched fetcher for work-item titles. Callers pass a
// list of ids; the hook fans out exactly one batch request per render to
// fill any cache misses, debouncing rapid changes. Returns a stable
// id → title map so render code can do `titles.get(id)` synchronously.

import { useEffect, useState } from "react";
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
}));

export function useWorkItemTitles(ids: number[]): {
  titleFor: (id: number) => string | null;
  loadingFor: (id: number) => boolean;
} {
  const titles = useTitleCache((s) => s.titles);
  const pending = useTitleCache((s) => s.pending);
  const request = useTitleCache((s) => s.request);
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

  return {
    titleFor: (id: number) => titles.get(id) ?? null,
    loadingFor: (id: number) => pending.has(id),
  };
}
