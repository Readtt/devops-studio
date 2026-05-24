import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTabsStore } from "./store/useTabsStore";

/**
 * Module-level launcher actions consumed by every surface that opens a
 * new tab — the top-bar "+", the tab-strip "+", the workspace empty
 * state, and the command palette. Keeping these as plain functions (not
 * a hook) lets non-React consumers like the global shortcuts handler
 * call them with the same semantics.
 *
 * They wrap `useTabsStore.getState().openTab` plus the small "no source
 * root → bounce to Settings" routing that the Code Review surface needs.
 */

export function launchGenerator(): void {
  useTabsStore.getState().openTab({
    kind: "generator",
    initialPlanId: null,
    initialSuiteId: null,
  });
}

export function launchTerminal(): void {
  const liveSourceRoot = usePreferencesStore.getState().sourceRoot;
  useTabsStore.getState().openTab({
    kind: "terminal",
    cwd: liveSourceRoot ?? null,
  });
}

export function launchCodeReview(): void {
  const liveSourceRoot = usePreferencesStore.getState().sourceRoot;
  if (!liveSourceRoot) {
    // No diff is possible without a source dir — send the user to set
    // one up rather than opening a useless empty pane.
    void openSettingsWindow("general");
    return;
  }
  useTabsStore.getState().openTab({
    kind: "code-review",
    cwd: liveSourceRoot,
    base: null,
  });
}
