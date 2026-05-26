// Local selection state for "attach existing ADO bugs as context". Mirrors the
// shape of useAttachments so a composer can hold a per-turn set of bugs and
// hand the ids to its send() call. The selected BugRefs are lightweight (the
// full bodies are fetched at send time via bugsToContextBlocks).

import { useCallback, useState } from "react";
import type { BugRef } from "@/modules/ado";

export function useBugContext() {
  const [selected, setSelected] = useState<BugRef[]>([]);

  const add = useCallback((bug: BugRef) => {
    setSelected((s) => (s.some((b) => b.id === bug.id) ? s : [...s, bug]));
  }, []);

  const remove = useCallback((id: number) => {
    setSelected((s) => s.filter((b) => b.id !== id));
  }, []);

  const clear = useCallback(() => setSelected([]), []);

  return { selected, add, remove, clear, setSelected };
}
