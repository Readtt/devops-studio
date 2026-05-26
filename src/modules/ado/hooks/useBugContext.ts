// Local selection state for "attach existing ADO work items as context".
// Mirrors the shape of useAttachments so a composer can hold a per-turn set of
// work items and hand the ids to its send() call. The selected WorkItemRefs are
// lightweight (full bodies are fetched at send time via bugsToContextBlocks,
// which works for any work-item type).

import { useCallback, useState } from "react";
import type { WorkItemRef } from "@/modules/ado";

export function useBugContext() {
  const [selected, setSelected] = useState<WorkItemRef[]>([]);

  const add = useCallback((item: WorkItemRef) => {
    setSelected((s) => (s.some((b) => b.id === item.id) ? s : [...s, item]));
  }, []);

  const remove = useCallback((id: number) => {
    setSelected((s) => s.filter((b) => b.id !== id));
  }, []);

  const clear = useCallback(() => setSelected([]), []);

  return { selected, add, remove, clear, setSelected };
}
