// What went wrong the last time the user's best-practices files were loaded for
// a run: a path that's gone, an empty file, one too big to inject whole.
//
// These used to be returned by `loadBestPracticeBlocks` and console.warn'd at
// every call site, which meant a standards file the AI silently stopped
// following was invisible to the person who could fix it. They describe global
// Settings state, not one run, so they live in one place and every AI surface
// renders the same notice next to its context meter.
//
// Published by the loader itself rather than by its callers — the same reason
// the tool-result cap wraps the whole tool map: a call site added later can't
// forget to report.

import { create } from "zustand";

type StoreState = {
  /** Human-readable lines, already prefixed with the file's label. */
  warnings: string[];
  /** The user dismissed THIS set. A different set clears it, so a newly-broken
   *  file resurfaces instead of inheriting a dismissal it was never part of. */
  dismissed: boolean;
  report: (warnings: string[]) => void;
  dismiss: () => void;
};

export const useBestPracticeWarnings = create<StoreState>((set, get) => ({
  warnings: [],
  dismissed: false,
  report: (warnings) => {
    const prev = get().warnings;
    const same =
      prev.length === warnings.length && prev.every((w, i) => w === warnings[i]);
    // Re-reporting the identical set on every run must not re-open a notice the
    // user already dismissed, and must not churn the store into a render loop.
    if (same) return;
    set({ warnings, dismissed: false });
  },
  dismiss: () => set({ dismissed: true }),
}));
