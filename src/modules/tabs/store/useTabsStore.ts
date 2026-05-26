import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type {
  AppTab,
  ClosedTabSnapshot,
  PaneNode,
  TabKind,
  TestCaseTab,
} from "./types";
import {
  dropLeaf,
  findLeaf,
  findLeafByTab,
  focusDirectional,
  insertTabIntoLeaf,
  makeLeaf,
  moveTabToLeaf,
  removeTab,
  reorderInLeaf,
  setLeafActive,
  setSplitSizes,
  splitLeaf,
  walkLeaves,
} from "./paneTreeOps";

export const ROOT_LEAF_ID = "root";
const RECENTLY_CLOSED_LIMIT = 10;

export type OpenTabInput =
  | {
      kind: "test-case";
      caseId: number;
      title: string;
      /** Plan + suite the case was opened from, so the Execute bar can target
       *  the right test point. Optional — surfaces without suite context
       *  (search, history) omit them and the pane shows a suite picker. */
      planId?: number | null;
      suiteId?: number | null;
      pinned?: boolean;
    }
  | {
      kind: "generator";
      title?: string;
      initialPlanId?: number | null;
      initialSuiteId?: number | null;
      runId?: string | null;
      pinned?: boolean;
    }
  | {
      kind: "code-viewer";
      path: string;
      title?: string;
      startLine?: number;
      endLine?: number;
      pinned?: boolean;
    }
  | { kind: "bug"; bugId: number; title: string; pinned?: boolean }
  | {
      kind: "suite-chat";
      planId: number;
      suiteId: number;
      title: string;
      /** Pin this tab to one specific thread on the suite. When set,
       *  dedup includes the threadId so the same suite can host
       *  multiple thread-bound tabs side-by-side. Omit (or pass null)
       *  to open the suite's chat without binding to a thread — the
       *  pane will follow whatever thread is active on the suite. */
      threadId?: string | null;
      pinned?: boolean;
    }
  | {
      kind: "terminal";
      title?: string;
      cwd?: string | null;
      shellId?: string | null;
      /** Optional pre-minted session id. Most callers leave this unset and
       *  let openTab generate one; passing it is only useful when an outside
       *  hook needs to subscribe to the PTY event channel before openTab
       *  returns. */
      sessionId?: string;
      pinned?: boolean;
    }
  | {
      kind: "code-review";
      cwd: string;
      base?: string | null;
      /** Which Azure DevOps unit to review (commit/PR/branch). Absent ⇒ the
       *  local working-copy diff. Persisted on the tab so it survives reload
       *  and is carried by Duplicate. */
      source?: import("@/modules/code-review/source").CodeReviewSource | null;
      /** Pre-existing code-review thread to rehydrate. Used by the
       *  Chats sidebar to reopen past reviews. */
      rehydrateThreadId?: string | null;
      title?: string;
      pinned?: boolean;
    };

export type TabsState = {
  tabs: Record<number, AppTab>;
  nextId: number;
  paneTree: PaneNode;
  focusedLeafId: string;
  recentlyClosed: ClosedTabSnapshot[];

  /** Open or activate a tab. Dedups by kind-specific identity. Returns the
   *  tab id (existing if found, fresh otherwise). */
  openTab: (input: OpenTabInput) => number;

  closeTab: (id: number, opts?: { force?: boolean }) => void;
  closeOthers: (leafId: string) => void;
  closeToRight: (leafId: string) => void;
  closeAll: (leafId: string) => void;
  reopenClosed: () => number | null;

  pinTab: (id: number) => void;
  unpinTab: (id: number) => void;
  togglePin: (id: number) => void;
  duplicateTab: (id: number) => number | null;

  renameTab: (id: number, title: string) => void;
  updateGeneratorRunId: (id: number, runId: string | null) => void;
  /** Persist a code-review tab's live source/base so it survives reload and
   *  Duplicate. The runtime store (useCodeReview) owns the in-memory slice;
   *  this mirrors the user's choice onto the persisted tab. */
  patchCodeReviewTab: (
    id: number,
    patch: {
      source?: import("@/modules/code-review/source").CodeReviewSource | null;
      base?: string | null;
    },
  ) => void;

  setActiveInLeaf: (leafId: string, tabId: number | null) => void;
  focusLeaf: (leafId: string) => void;
  focusDirection: (direction: "left" | "right" | "up" | "down") => void;
  focusNextLeaf: () => void;
  focusPrevLeaf: () => void;

  reorderInLeaf: (leafId: string, fromIdx: number, toIdx: number) => void;
  moveTabToLeaf: (tabId: number, targetLeafId: string, index?: number) => void;
  moveTabToNextPane: (tabId: number) => void;
  moveTabToPrevPane: (tabId: number) => void;

  splitLeaf: (
    leafId: string,
    direction: "horizontal" | "vertical",
    side: "before" | "after",
    movedTabId?: number,
  ) => string | null;
  closeLeaf: (leafId: string) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;

  /** Cycle tabs within the focused leaf. */
  nextTabInFocusedLeaf: () => void;
  prevTabInFocusedLeaf: () => void;
  jumpToTabInFocusedLeaf: (oneBasedIndex: number) => void;
};

const initialPaneTree = (): PaneNode =>
  makeLeaf({ id: ROOT_LEAF_ID });

function sortPinnedFirst(tabIds: number[], tabs: Record<number, AppTab>): number[] {
  // Stable: pinned keep their relative order, unpinned keep theirs.
  const pinned: number[] = [];
  const rest: number[] = [];
  for (const id of tabIds) {
    const t = tabs[id];
    if (t?.pinned) pinned.push(id);
    else rest.push(id);
  }
  return [...pinned, ...rest];
}

function pickFocusedLeafIdAfterDrop(
  tree: PaneNode,
  previousFocused: string,
): string {
  const leaves = walkLeaves(tree);
  if (leaves.some((l) => l.id === previousFocused)) return previousFocused;
  return leaves[0]?.id ?? ROOT_LEAF_ID;
}

function localStorageOrShim(): PersistStorage<Partial<TabsState>> {
  const isLocalStorageAvailable =
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { localStorage?: Storage }).localStorage !== "undefined";
  return {
    getItem: (name) => {
      if (!isLocalStorageAvailable) return null;
      try {
        const raw = localStorage.getItem(name);
        if (!raw) return null;
        return JSON.parse(raw) as StorageValue<Partial<TabsState>>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (!isLocalStorageAvailable) return;
      try {
        localStorage.setItem(name, JSON.stringify(value));
      } catch {
        // localStorage quota exceeded — silent, this is a UX nicety.
      }
    },
    removeItem: (name) => {
      if (!isLocalStorageAvailable) return;
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: {},
      nextId: 1,
      paneTree: initialPaneTree(),
      focusedLeafId: ROOT_LEAF_ID,
      recentlyClosed: [],

      openTab: (input) => {
        const { tabs, paneTree, focusedLeafId } = get();
        // Dedup by kind identity.
        const existing = Object.values(tabs).find((t) => {
          if (t.kind !== input.kind) return false;
          switch (input.kind) {
            case "test-case":
              return t.kind === "test-case" && t.caseId === input.caseId;
            case "bug":
              return t.kind === "bug" && t.bugId === input.bugId;
            case "code-viewer":
              return (
                t.kind === "code-viewer" &&
                t.path === input.path &&
                t.startLine === input.startLine &&
                t.endLine === input.endLine
              );
            case "suite-chat":
              return (
                t.kind === "suite-chat" &&
                t.planId === input.planId &&
                t.suiteId === input.suiteId &&
                // Thread pin is part of identity now: a no-thread tab
                // and a thread-A tab on the same suite are different
                // tabs. Normalise undefined↔null so callers that pass
                // either dedup the same way.
                (t.threadId ?? null) === (input.threadId ?? null)
              );
            case "generator":
              // Fresh generators don't dedup; bound-to-runId generators do.
              if (!input.runId) return false;
              return t.kind === "generator" && t.runId === input.runId;
            case "terminal":
              // Terminals never dedup. Each tab holds a live PTY session;
              // reopening "Open Terminal" should give you a fresh shell, not
              // surface the existing one. Multi-terminal is a feature.
              return false;
            case "code-review":
              // Never dedup. Each "Review my changes" should be a fresh
              // pane — the user explicitly asked for the ability to keep
              // multiple parallel reviews open (different bases, different
              // questions, side-by-side comparison). Same model as the
              // terminal: opening N times yields N tabs.
              return false;
          }
          return false;
        });
        if (existing) {
          const owner = findLeafByTab(paneTree, existing.id);
          const leafId = owner?.id ?? focusedLeafId;
          // Retarget a reused test-case tab to the suite it was just opened
          // from. Dedup keeps one tab per case, but the user may open the
          // same case from a different suite to run it there — honour the
          // newer execution context when the caller supplies one.
          const retarget =
            input.kind === "test-case" &&
            existing.kind === "test-case" &&
            (input.planId != null || input.suiteId != null) &&
            (existing.planId !== input.planId ||
              existing.suiteId !== input.suiteId);
          set((s) => ({
            tabs: retarget
              ? {
                  ...s.tabs,
                  [existing.id]: {
                    ...(s.tabs[existing.id] as TestCaseTab),
                    planId: input.planId ?? null,
                    suiteId: input.suiteId ?? null,
                  },
                }
              : s.tabs,
            paneTree: setLeafActive(s.paneTree, leafId, existing.id),
            focusedLeafId: leafId,
          }));
          return existing.id;
        }

        const id = get().nextId;
        let tab: AppTab;
        switch (input.kind) {
          case "test-case":
            tab = {
              id,
              kind: "test-case",
              title: input.title,
              caseId: input.caseId,
              planId: input.planId ?? null,
              suiteId: input.suiteId ?? null,
              pinned: input.pinned ?? false,
            };
            break;
          case "generator":
            tab = {
              id,
              kind: "generator",
              title: input.title ?? "Generate Cases",
              initialPlanId: input.initialPlanId ?? null,
              initialSuiteId: input.initialSuiteId ?? null,
              runId: input.runId ?? null,
              pinned: input.pinned ?? false,
            };
            break;
          case "code-viewer":
            tab = {
              id,
              kind: "code-viewer",
              title: input.title ?? input.path.split(/[\\/]/).pop() ?? input.path,
              path: input.path,
              startLine: input.startLine,
              endLine: input.endLine,
              pinned: input.pinned ?? false,
            };
            break;
          case "bug":
            tab = {
              id,
              kind: "bug",
              title: input.title,
              bugId: input.bugId,
              pinned: input.pinned ?? false,
            };
            break;
          case "suite-chat":
            tab = {
              id,
              kind: "suite-chat",
              title: input.title,
              planId: input.planId,
              suiteId: input.suiteId,
              threadId: input.threadId ?? null,
              pinned: input.pinned ?? false,
            };
            break;
          case "terminal":
            tab = {
              id,
              kind: "terminal",
              title: input.title ?? "Terminal",
              cwd: input.cwd ?? null,
              shellId: input.shellId ?? null,
              sessionId: input.sessionId ?? crypto.randomUUID(),
              pinned: input.pinned ?? false,
            };
            break;
          case "code-review":
            tab = {
              id,
              kind: "code-review",
              title: input.title ?? "Code review",
              cwd: input.cwd,
              base: input.base ?? null,
              source: input.source ?? null,
              rehydrateThreadId: input.rehydrateThreadId ?? null,
              pinned: input.pinned ?? false,
            };
            break;
        }
        set((s) => ({
          tabs: { ...s.tabs, [id]: tab },
          nextId: id + 1,
          paneTree: insertTabIntoLeaf(s.paneTree, focusedLeafId, id),
        }));
        return id;
      },

      closeTab: (id, opts) => {
        const { tabs, paneTree } = get();
        const tab = tabs[id];
        if (!tab) return;
        if (tab.pinned && !opts?.force) return;
        const owner = findLeafByTab(paneTree, id);
        const idx = owner ? owner.tabIds.indexOf(id) : -1;
        const snapshot: ClosedTabSnapshot | null =
          owner && idx >= 0
            ? { tab, leafId: owner.id, index: idx, closedAt: Date.now() }
            : null;

        set((s) => {
          const nextTree = removeTab(s.paneTree, id);
          const nextTabs = { ...s.tabs };
          delete nextTabs[id];
          const nextClosed = snapshot
            ? [snapshot, ...s.recentlyClosed].slice(0, RECENTLY_CLOSED_LIMIT)
            : s.recentlyClosed;
          return {
            tabs: nextTabs,
            paneTree: nextTree,
            focusedLeafId: pickFocusedLeafIdAfterDrop(nextTree, s.focusedLeafId),
            recentlyClosed: nextClosed,
          };
        });
      },

      closeOthers: (leafId) => {
        const { paneTree, tabs } = get();
        const leaf = findLeaf(paneTree, leafId);
        if (!leaf) return;
        const keepId = leaf.activeTabId;
        const closable = leaf.tabIds.filter(
          (id) => id !== keepId && !tabs[id]?.pinned,
        );
        for (const id of closable) get().closeTab(id);
      },

      closeToRight: (leafId) => {
        const { paneTree, tabs } = get();
        const leaf = findLeaf(paneTree, leafId);
        if (!leaf || leaf.activeTabId == null) return;
        const sorted = sortPinnedFirst(leaf.tabIds, tabs);
        const anchor = sorted.indexOf(leaf.activeTabId);
        if (anchor < 0) return;
        const closable = sorted
          .slice(anchor + 1)
          .filter((id) => !tabs[id]?.pinned);
        for (const id of closable) get().closeTab(id);
      },

      closeAll: (leafId) => {
        const { paneTree, tabs } = get();
        const leaf = findLeaf(paneTree, leafId);
        if (!leaf) return;
        const closable = leaf.tabIds.filter((id) => !tabs[id]?.pinned);
        for (const id of closable) get().closeTab(id);
      },

      reopenClosed: () => {
        const { recentlyClosed, paneTree } = get();
        const snap = recentlyClosed[0];
        if (!snap) return null;
        // If the leaf still exists, reopen there; else focused leaf.
        const targetLeaf = findLeaf(paneTree, snap.leafId)
          ? snap.leafId
          : get().focusedLeafId;
        const id = snap.tab.id;
        set((s) => ({
          tabs: { ...s.tabs, [id]: snap.tab },
          nextId: Math.max(s.nextId, id + 1),
          paneTree: insertTabIntoLeaf(s.paneTree, targetLeaf, id, snap.index),
          recentlyClosed: s.recentlyClosed.slice(1),
          focusedLeafId: targetLeaf,
        }));
        return id;
      },

      pinTab: (id) =>
        set((s) => {
          const t = s.tabs[id];
          if (!t || t.pinned) return s;
          return { tabs: { ...s.tabs, [id]: { ...t, pinned: true } } };
        }),
      unpinTab: (id) =>
        set((s) => {
          const t = s.tabs[id];
          if (!t || !t.pinned) return s;
          return { tabs: { ...s.tabs, [id]: { ...t, pinned: false } } };
        }),
      togglePin: (id) => {
        const t = get().tabs[id];
        if (!t) return;
        if (t.pinned) get().unpinTab(id);
        else get().pinTab(id);
      },

      duplicateTab: (id) => {
        const { tabs, paneTree, focusedLeafId } = get();
        const t = tabs[id];
        if (!t) return null;

        // Kinds that need fresh per-tab resources can't be cloned by copying
        // the tab object — they open a brand-new tab instead:
        //  - terminal: a new PTY session (cloning the sessionId would attach
        //    two tabs to the same shell).
        //  - generator: a cloned session store + fresh runId (store-aware,
        //    handled at the App level; the context menu routes there. This is
        //    just the ctrl-drag fallback — a fresh seeded generator).
        //  - code-review: a fresh review thread.
        if (t.kind === "terminal") {
          return get().openTab({
            kind: "terminal",
            title: t.title,
            cwd: t.cwd,
            shellId: t.shellId,
          });
        }
        if (t.kind === "generator") {
          return get().openTab({
            kind: "generator",
            title: `${t.title} (copy)`,
            initialPlanId: t.initialPlanId,
            initialSuiteId: t.initialSuiteId,
          });
        }
        if (t.kind === "code-review") {
          return get().openTab({
            kind: "code-review",
            cwd: t.cwd,
            base: t.base,
            // Carry the ADO source so a duplicated review keeps reviewing the
            // same commit/PR/branch instead of silently reverting to local.
            source: t.source ?? null,
            title: `${t.title} (copy)`,
          });
        }

        // test-case / bug / code-viewer / suite-chat DEDUP in openTab, so
        // re-opening the same identity would just reactivate the original —
        // a no-op, which is the "Duplicate does nothing" bug. Duplicate is an
        // explicit request for a SECOND independent view (e.g. the same case
        // in a split, or the same file scrolled to two places), so clone the
        // tab object directly with a fresh id and insert it next to the
        // original, bypassing dedup entirely.
        const owner = findLeafByTab(paneTree, id);
        const leafId = owner?.id ?? focusedLeafId;
        const insertIndex = owner ? owner.tabIds.indexOf(id) + 1 : undefined;
        const newId = get().nextId;
        const clone = { ...t, id: newId, pinned: false } as AppTab;
        set((s) => ({
          tabs: { ...s.tabs, [newId]: clone },
          nextId: newId + 1,
          paneTree: insertTabIntoLeaf(s.paneTree, leafId, newId, insertIndex),
          focusedLeafId: leafId,
        }));
        return newId;
      },

      renameTab: (id, title) =>
        set((s) => {
          const t = s.tabs[id];
          if (!t || t.title === title) return s;
          return { tabs: { ...s.tabs, [id]: { ...t, title } } };
        }),

      updateGeneratorRunId: (id, runId) =>
        set((s) => {
          const t = s.tabs[id];
          if (!t || t.kind !== "generator" || t.runId === runId) return s;
          return { tabs: { ...s.tabs, [id]: { ...t, runId } } };
        }),

      patchCodeReviewTab: (id, patch) =>
        set((s) => {
          const t = s.tabs[id];
          if (!t || t.kind !== "code-review") return s;
          const next = { ...t };
          if ("source" in patch) next.source = patch.source ?? null;
          if ("base" in patch) next.base = patch.base ?? null;
          return { tabs: { ...s.tabs, [id]: next } };
        }),

      setActiveInLeaf: (leafId, tabId) =>
        set((s) => ({
          paneTree: setLeafActive(s.paneTree, leafId, tabId),
          focusedLeafId: leafId,
        })),

      focusLeaf: (leafId) =>
        set((s) =>
          findLeaf(s.paneTree, leafId) ? { focusedLeafId: leafId } : s,
        ),

      focusDirection: (direction) => {
        const { paneTree, focusedLeafId } = get();
        const next = focusDirectional(paneTree, focusedLeafId, direction);
        if (next) set({ focusedLeafId: next });
      },

      focusNextLeaf: () => {
        const { paneTree, focusedLeafId } = get();
        const leaves = walkLeaves(paneTree);
        const idx = leaves.findIndex((l) => l.id === focusedLeafId);
        if (idx < 0 || leaves.length < 2) return;
        const next = leaves[(idx + 1) % leaves.length];
        set({ focusedLeafId: next.id });
      },
      focusPrevLeaf: () => {
        const { paneTree, focusedLeafId } = get();
        const leaves = walkLeaves(paneTree);
        const idx = leaves.findIndex((l) => l.id === focusedLeafId);
        if (idx < 0 || leaves.length < 2) return;
        const prev = leaves[(idx - 1 + leaves.length) % leaves.length];
        set({ focusedLeafId: prev.id });
      },

      reorderInLeaf: (leafId, fromIdx, toIdx) =>
        set((s) => ({
          paneTree: reorderInLeaf(s.paneTree, leafId, fromIdx, toIdx),
        })),

      moveTabToLeaf: (tabId, targetLeafId, index) =>
        set((s) => ({
          paneTree: moveTabToLeaf(s.paneTree, tabId, targetLeafId, index),
          focusedLeafId: findLeaf(s.paneTree, targetLeafId)
            ? targetLeafId
            : s.focusedLeafId,
        })),

      moveTabToNextPane: (tabId) => {
        const { paneTree } = get();
        const owner = findLeafByTab(paneTree, tabId);
        if (!owner) return;
        const leaves = walkLeaves(paneTree);
        const idx = leaves.findIndex((l) => l.id === owner.id);
        if (idx < 0 || leaves.length < 2) return;
        const target = leaves[(idx + 1) % leaves.length];
        get().moveTabToLeaf(tabId, target.id);
      },
      moveTabToPrevPane: (tabId) => {
        const { paneTree } = get();
        const owner = findLeafByTab(paneTree, tabId);
        if (!owner) return;
        const leaves = walkLeaves(paneTree);
        const idx = leaves.findIndex((l) => l.id === owner.id);
        if (idx < 0 || leaves.length < 2) return;
        const target = leaves[(idx - 1 + leaves.length) % leaves.length];
        get().moveTabToLeaf(tabId, target.id);
      },

      splitLeaf: (leafId, direction, side, movedTabId) => {
        const { paneTree } = get();
        if (!findLeaf(paneTree, leafId)) return null;
        const { tree, newLeafId } = splitLeaf(
          paneTree,
          leafId,
          direction,
          side,
          movedTabId,
        );
        set({ paneTree: tree, focusedLeafId: newLeafId });
        return newLeafId;
      },

      closeLeaf: (leafId) => {
        const { paneTree, tabs } = get();
        const leaf = findLeaf(paneTree, leafId);
        if (!leaf) return;
        // Closing a leaf closes every tab in it (skip pinned).
        for (const id of leaf.tabIds) {
          if (!tabs[id]?.pinned) get().closeTab(id);
        }
        // If the leaf still has only pinned tabs, leave it; user must unpin.
        const after = findLeaf(get().paneTree, leafId);
        if (after && after.tabIds.length === 0) {
          set((s) => {
            const nextTree = dropLeaf(s.paneTree, leafId);
            return {
              paneTree: nextTree,
              focusedLeafId: pickFocusedLeafIdAfterDrop(nextTree, s.focusedLeafId),
            };
          });
        }
      },

      setSplitSizes: (splitId, sizes) =>
        set((s) => ({ paneTree: setSplitSizes(s.paneTree, splitId, sizes) })),

      nextTabInFocusedLeaf: () => {
        const { tabs, paneTree, focusedLeafId } = get();
        const leaf = findLeaf(paneTree, focusedLeafId);
        if (!leaf) return;
        const ordered = sortPinnedFirst(leaf.tabIds, tabs);
        if (ordered.length < 2) return;
        const cur =
          leaf.activeTabId == null ? -1 : ordered.indexOf(leaf.activeTabId);
        const nextId = ordered[(cur + 1) % ordered.length];
        get().setActiveInLeaf(focusedLeafId, nextId);
      },
      prevTabInFocusedLeaf: () => {
        const { tabs, paneTree, focusedLeafId } = get();
        const leaf = findLeaf(paneTree, focusedLeafId);
        if (!leaf) return;
        const ordered = sortPinnedFirst(leaf.tabIds, tabs);
        if (ordered.length < 2) return;
        const cur =
          leaf.activeTabId == null ? 0 : ordered.indexOf(leaf.activeTabId);
        const prevId = ordered[(cur - 1 + ordered.length) % ordered.length];
        get().setActiveInLeaf(focusedLeafId, prevId);
      },
      jumpToTabInFocusedLeaf: (oneBasedIndex) => {
        const { tabs, paneTree, focusedLeafId } = get();
        const leaf = findLeaf(paneTree, focusedLeafId);
        if (!leaf) return;
        const ordered = sortPinnedFirst(leaf.tabIds, tabs);
        if (ordered.length === 0) return;
        // Index 9 always lands on the last tab (VS Code convention).
        const idx =
          oneBasedIndex >= 9
            ? ordered.length - 1
            : Math.max(0, Math.min(oneBasedIndex - 1, ordered.length - 1));
        const id = ordered[idx];
        get().setActiveInLeaf(focusedLeafId, id);
      },
    }),
    {
      name: "devops-studio.tabs.v1",
      version: 1,
      storage: localStorageOrShim(),
      partialize: (s) =>
        ({
          tabs: s.tabs,
          nextId: s.nextId,
          paneTree: s.paneTree,
          focusedLeafId: s.focusedLeafId,
        }) as Partial<TabsState>,
      // Drop tabs that can't be restored from a cold start:
      //   * generator tabs with no runId — no draft to load
      //   * terminal tabs — the PTY died with the previous process
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<TabsState>) };
        if (!merged.tabs || !merged.paneTree) return current;
        const ghostIds = new Set<number>();
        for (const t of Object.values(merged.tabs) as AppTab[]) {
          if (t.kind === "generator" && !t.runId) ghostIds.add(t.id);
          else if (t.kind === "terminal") ghostIds.add(t.id);
        }
        if (ghostIds.size > 0) {
          let tree = merged.paneTree;
          for (const id of ghostIds) {
            tree = removeTab(tree, id);
            delete merged.tabs[id];
          }
          merged.paneTree = tree;
        }
        // Ensure the focused leaf still exists.
        if (!findLeaf(merged.paneTree, merged.focusedLeafId ?? "")) {
          const leaves = walkLeaves(merged.paneTree);
          merged.focusedLeafId = leaves[0]?.id ?? ROOT_LEAF_ID;
        }
        return merged;
      },
    },
  ),
);

/* -------------------------------------------------------------------------
   Selectors (memoized, shallow) — pick these instead of the raw store to
   keep re-renders tight. The pane tree changes on every drag, but most
   components only care about their leaf or their own tab.
   ------------------------------------------------------------------------- */

export const useTabsArray = (): AppTab[] =>
  useTabsStore(
    useShallow((s) =>
      Object.values(s.tabs).sort((a, b) => a.id - b.id),
    ),
  );

export const useTab = (id: number | null | undefined): AppTab | undefined =>
  useTabsStore((s) => (id == null ? undefined : s.tabs[id]));

export const useFocusedLeafId = (): string =>
  useTabsStore((s) => s.focusedLeafId);

export const useFocusedActiveTabId = (): number | null =>
  useTabsStore((s) => {
    const leaf = findLeaf(s.paneTree, s.focusedLeafId);
    return leaf?.activeTabId ?? null;
  });

export const useLeafByIdShallow = (leafId: string | null) =>
  useTabsStore(
    useShallow((s) => {
      if (!leafId) return null;
      return findLeaf(s.paneTree, leafId);
    }),
  );

export const useLeafTabs = (leafId: string): AppTab[] =>
  useTabsStore(
    useShallow((s) => {
      const leaf = findLeaf(s.paneTree, leafId);
      if (!leaf) return [];
      const ordered = sortPinnedFirst(leaf.tabIds, s.tabs);
      return ordered.map((id) => s.tabs[id]).filter(Boolean);
    }),
  );

export const useHasRecentlyClosed = (): boolean =>
  useTabsStore((s) => s.recentlyClosed.length > 0);

/** True when more than one leaf exists. Used to gate UI that only helps
 *  the user disambiguate (focus ring, drag overlays for cross-leaf drops). */
export const useHasMultiplePanes = (): boolean =>
  useTabsStore((s) => {
    let count = 0;
    const walk = (node: PaneNode) => {
      if (node.kind === "leaf") {
        count += 1;
        return;
      }
      for (const c of node.children) {
        walk(c);
        if (count > 1) return;
      }
    };
    walk(s.paneTree);
    return count > 1;
  });

/** Convenience: read state from outside React without subscribing. */
export const tabsStoreApi = {
  getState: useTabsStore.getState,
  setState: useTabsStore.setState,
  subscribe: useTabsStore.subscribe,
};

/** Internal helpers exposed for tests. */
export const __internal = {
  sortPinnedFirst,
  ROOT_LEAF_ID,
};

export type { TabKind };
