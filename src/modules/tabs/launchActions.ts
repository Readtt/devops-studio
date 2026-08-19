import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { getRepos } from "@/modules/settings/preferences";
import { primaryRepoRoot } from "@/modules/settings/store";
import { useTabsStore } from "./store/useTabsStore";

/**
 * Module-level launcher actions consumed by every surface that opens a
 * new tab — the top-bar "+", the tab-strip "+", the workspace empty
 * state, and the command palette. Keeping these as plain functions (not
 * a hook) lets non-React consumers like the global shortcuts handler
 * call them with the same semantics.
 *
 * They wrap `useTabsStore.getState().openTab` plus the small "no source
 * root → bounce to Settings" routing that the Commit Review surface needs.
 */

export function launchGenerator(): void {
  useTabsStore.getState().openTab({
    kind: "generator",
    initialPlanId: null,
    initialSuiteId: null,
  });
}

/** `cwd` omitted ⇒ the first configured repo (some default is needed and no
 *  repo is special); pass one explicitly to open the shell in that repo, or
 *  `null` for the app's own process cwd. */
export function launchTerminal(cwd?: string | null): void {
  const fallback = primaryRepoRoot(getRepos());
  useTabsStore.getState().openTab({
    kind: "terminal",
    cwd: cwd === undefined ? fallback ?? null : cwd,
  });
}

export function launchCommitReview(): void {
  if (getRepos().length === 0) {
    // No commits are reviewable with an empty workspace — send the user to set
    // one up rather than opening a useless empty pane.
    void openSettingsWindow("general");
    return;
  }
  useTabsStore.getState().openTab({ kind: "commit-review" });
}
