import { create } from "zustand";

export type ActionToastTone = "info" | "ok" | "error";

export type ActionToastState = {
  id: number;
  tone: ActionToastTone;
  message: string;
  /** Show a spinner instead of an icon while an async action is in flight. */
  busy: boolean;
};

type Store = {
  toast: ActionToastState | null;
  /** Show a toast; returns its id so an async caller can update it in place
   *  (e.g. "Copying…" → "Copied 4 bugs"). A non-busy toast auto-dismisses. */
  show: (input: {
    tone?: ActionToastTone;
    message: string;
    busy?: boolean;
  }) => number;
  /** Patch the toast with the given id. No-op if it's already been replaced. */
  update: (
    id: number,
    patch: { tone?: ActionToastTone; message?: string; busy?: boolean },
  ) => void;
  /** Dismiss (optionally only if the current toast still matches `id`). */
  dismiss: (id?: number) => void;
};

const AUTO_DISMISS_MS = 2800;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * One-at-a-time transient toast for a discrete action result (e.g. a copy).
 * Rendered by {@link ActionToast} in the App.tsx bottom-left capsule stack
 * alongside the branch/updater toasts.
 */
export const useActionToast = create<Store>((set, get) => {
  const armDismiss = (id: number) => {
    clearTimer();
    timer = setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  };
  return {
    toast: null,
    show: ({ tone = "info", message, busy = false }) => {
      clearTimer();
      const id = nextId++;
      set({ toast: { id, tone, message, busy } });
      if (!busy) armDismiss(id);
      return id;
    },
    update: (id, patch) => {
      const cur = get().toast;
      if (!cur || cur.id !== id) return;
      const next = { ...cur, ...patch };
      set({ toast: next });
      if (!next.busy) armDismiss(id);
    },
    dismiss: (id) => {
      const cur = get().toast;
      if (id != null && (!cur || cur.id !== id)) return;
      clearTimer();
      set({ toast: null });
    },
  };
});
