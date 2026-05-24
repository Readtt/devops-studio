import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { installContextMenuGuard } from "@/lib/contextMenuGuard";
import { useZoom } from "@/lib/useZoom";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CommandPalette } from "@/modules/command-palette";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import {
  emitGenerationBusy,
  setSourceRoot,
  setTheme,
  type GenerationBusyReason,
} from "@/modules/settings/store";
import {
  ChatHistoryPanel,
  StaleQueuePanel,
  TestPlansPanel,
  useStaleCases,
} from "@/modules/test-plans";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  GeneratorStoresProvider,
  GenerationHistoryPane,
  useGeneratorStoresApi,
} from "@/modules/generator";
import { GeneratorCallbacksProvider } from "@/modules/generator/callbacksContext";
import { PaneTreeRenderer } from "@/modules/tabs/PaneTreeRenderer";
import { DndProvider as TabsDndProvider } from "@/modules/tabs/dnd/DndProvider";
import { resolveSourcePath } from "@/modules/code-viewer/resolveSourcePath";
import { ThemeProvider } from "@/modules/theme";
import { UpdaterStatusPill, UpdaterToast, useUpdater } from "@/modules/updater";
import {
  createGenerationSessionStore,
  type SessionState,
} from "@/modules/generator/store/useGenerationSession";
import { useSourceDirGitInfo } from "@/modules/git";
import { getConnection } from "@/modules/ado";
import { AzureDevOpsBrand } from "@/components/AzureDevOpsBrand";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { getModel } from "@/modules/ai/config";
import { useModelAvailability } from "@/modules/ai/lib/modelAvailability";
import {
  useFocusedActiveTabId,
  useTab,
  useTabsStore,
} from "@/modules/tabs/store/useTabsStore";
import { findLeaf, findLeafByTab } from "@/modules/tabs/store/paneTreeOps";
import type { GenerationSessionStore } from "@/modules/generator/store/useGenerationSession";

/** Read the active tab id of the currently-focused leaf without subscribing.
 *  Lives at module scope so shortcut handlers can use it without grabbing
 *  React state every call. */
function focusedActiveId(): number | null {
  const s = useTabsStore.getState();
  const leaf = findLeaf(s.paneTree, s.focusedLeafId);
  return leaf?.activeTabId ?? null;
}

/** Run `fn` against the live terminal session for the focused tab, when
 *  that tab is a terminal. Quiet no-op otherwise. Used by the terminal
 *  shortcuts so they're context-aware (no "paste into your generator"
 *  surprises). */
function withFocusedTerminal(
  fn: (session: import("@/modules/terminal/terminalRegistry").TerminalSession) => void,
): void {
  const s = useTabsStore.getState();
  const id = focusedActiveId();
  if (id == null) return;
  const tab = s.tabs[id];
  if (!tab || tab.kind !== "terminal") return;
  void import("@/modules/terminal/terminalRegistry").then(({ getSession }) => {
    const session = getSession(tab.sessionId);
    if (session) fn(session);
  });
}
import { LaunchMenu } from "@/modules/tabs/LaunchMenu";
import {
  launchCodeReview,
  launchGenerator,
  launchTerminal,
} from "@/modules/tabs/launchActions";
import {
  AlertCircleIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusSignIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "devops-studio.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "devops-studio.sidebar.view";
/** Remember the version of an update the user closed so we don't keep
 *  re-popping the toast every launch. Cleared when the toast is re-opened
 *  from the status-bar pill. */
const UPDATER_DISMISS_KEY = "devops-studio.updater.dismissed-version";

/** Derive a short, scannable tab title from the current generator session.
 *  Identifies the session by its target (plan / suite) rather than draft
 *  content so the label is stable across edits. GeneratorPane mirrors
 *  this logic in its rename effect.
 */
function deriveGeneratorTabTitle(state: SessionState): string {
  const plan = state.planName?.trim() || "";
  const suite = state.suiteName?.trim() || "";
  if (plan && suite) return ellipsize(`${plan} · ${suite}`, 48);
  if (suite) return ellipsize(suite, 48);
  if (plan) return ellipsize(plan, 48);
  if (state.suiteId) return `Suite #${state.suiteId}`;
  if (state.planId) return `Plan #${state.planId}`;
  const firstLine = state.requirements.trim().split("\n")[0];
  if (firstLine.length > 0) return ellipsize(firstLine, 48);
  return "Generate cases";
}

function ellipsize(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Trim a long absolute path to "…/parent/dir" so it fits in the header. */
function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (
      stored === "test-plans" ||
      stored === "stale-queue" ||
      stored === "history" ||
      stored === "chat-history"
    ) {
      return stored;
    }
  } catch {
    // ignore
  }
  return "test-plans";
}

// AppTab shape lives in src/modules/tabs/store/types.ts and is consumed
// here as `Tab` (re-exported from src/modules/tabs/lib/useTabs).

export default function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <GeneratorStoresProvider>
          <AppShell />
        </GeneratorStoresProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function AppShell() {
  const initPrefs = usePreferencesStore((s) => s.init);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);

  // Subscribe per-cell: the activeId selector emits a single number, the
  // active tab selector emits one object. Unrelated tab churn (closing a
  // tab in another pane, renaming, dragging) doesn't re-render AppShell.
  const activeId = useFocusedActiveTabId();
  const activeTab = useTab(activeId);
  const genStoresApi = useGeneratorStoresApi();
  const setActiveId = useCallback((id: number | null) => {
    const tabs = useTabsStore.getState();
    // Activate the tab in the leaf it actually lives in. Hard-coding
    // ROOT_LEAF_ID here is the single root-cause behind every "this command
    // doesn't focus my tab when it's in a split / second pane" bug — the
    // store happily wrote `paneTree[root].activeTabId = id` to a leaf that
    // didn't contain `id`, so nothing visible changed. When clearing (id =
    // null) just keep the user's current focus.
    if (id == null) {
      tabs.setActiveInLeaf(tabs.focusedLeafId, null);
      return;
    }
    const owner = findLeafByTab(tabs.paneTree, id);
    const leafId = owner?.id ?? tabs.focusedLeafId;
    tabs.setActiveInLeaf(leafId, id);
  }, []);

  // Per-generator-tab Zustand stores. Each generator tab owns its own
  // session state — no more singleton-store trampling when the user has
  // two drafts in flight. The map lives in GeneratorStoresProvider so it
  // survives tab moves between panes (each store keyed by tabId, not pane).

  // Mirror of each generator tab's current phase + isRefining, so the
  // status-bar model picker (outside Provider scope) can lock when the
  // *active* tab is in a draft state. GeneratorPane reports its phase up
  // via an effect; App.tsx aggregates by tabId.
  const [genSessionPhases, setGenSessionPhases] = useState<
    Record<number, { phase: SessionState["phase"]; isRefining: boolean }>
  >({});
  const reportGenSession = useCallback(
    (
      tabId: number,
      next: {
        phase: SessionState["phase"];
        isRefining: boolean;
        runId: string | null;
      },
    ) => {
      setGenSessionPhases((curr) => {
        const prev = curr[tabId];
        if (
          prev &&
          prev.phase === next.phase &&
          prev.isRefining === next.isRefining
        ) {
          return curr; // no-op churn suppressor — keeps tab-switch perf snappy
        }
        return {
          ...curr,
          [tabId]: { phase: next.phase, isRefining: next.isRefining },
        };
      });
      // Sync the tab's stored runId so "Open in review" dedup works once
      // the live session has actually committed to a runId (set on first
      // analyze). No-op when the value hasn't changed.
      useTabsStore.getState().updateGeneratorRunId(tabId, next.runId);
    },
    [],
  );

  const renameGeneratorTab = useCallback((tabId: number, title: string) => {
    useTabsStore.getState().renameTab(tabId, title);
  }, []);

  // Clear the local phase mirror whenever a tab disappears from the store.
  // The store itself does the actual close; this just keeps the auxiliary
  // status-bar phase map from leaking entries for closed tabs.
  useEffect(() => {
    const unsub = useTabsStore.subscribe((state, prev) => {
      if (state.tabs === prev.tabs) return;
      setGenSessionPhases((curr) => {
        let mutated = false;
        const next: typeof curr = {};
        for (const [k, v] of Object.entries(curr)) {
          const id = Number(k);
          if (state.tabs[id]) next[id] = v;
          else mutated = true;
        }
        return mutated ? next : curr;
      });
    });
    return unsub;
  }, []);

  const openTestCaseTab = useCallback(
    (input: { caseId: number; title: string }) => {
      const id = useTabsStore.getState().openTab({
        kind: "test-case",
        caseId: input.caseId,
        title: input.title,
      });
      // Refresh the title on re-open (ADO title may have changed).
      useTabsStore.getState().renameTab(id, input.title);
      return id;
    },
    [],
  );

  const openBugTab = useCallback(
    (input: { bugId: number; title: string }) => {
      const id = useTabsStore.getState().openTab({
        kind: "bug",
        bugId: input.bugId,
        title: input.title,
      });
      useTabsStore.getState().renameTab(id, input.title);
      return id;
    },
    [],
  );

  const openSuiteChatTab = useCallback(
    (input: {
      planId: number;
      suiteId: number;
      title: string;
      /** Bind the tab to a specific thread. When passed (e.g. from the
       *  chat-history sidebar clicking a past conversation), the tab
       *  dedups against other tabs with the same threadId — so two
       *  threads on the same suite open as TWO tabs, not one.
       *  Omit to open the suite chat without binding to a thread
       *  (e.g. from the suite-tree context menu); the pane will follow
       *  whatever thread is active on that suite. */
      threadId?: string;
    }) => {
      const id = useTabsStore.getState().openTab({
        kind: "suite-chat",
        planId: input.planId,
        suiteId: input.suiteId,
        title: input.title,
        threadId: input.threadId ?? null,
      });
      useTabsStore.getState().renameTab(id, input.title);
      if (input.threadId) {
        // Defer to next microtask so the SuiteChatPane has been mounted
        // and its ensure() has registered the suite entry by then.
        void Promise.resolve().then(() => {
          void import("@/modules/test-plans/hooks/useSuiteChat").then(
            ({ useSuiteChat }) => {
              useSuiteChat
                .getState()
                .setActiveThread(input.planId, input.suiteId, input.threadId!);
            },
          );
        });
      }
      return id;
    },
    [],
  );

  const openCodeViewerTab = useCallback(
    (input: {
      path: string;
      startLine?: number;
      endLine?: number;
      title?: string;
    }) => {
      // Bug code refs and analyst Read entries arrive as relative paths
      // (e.g. "src/auth/sms.ts"). The Rust fs_read_file handler treats
      // whatever it gets literally, so resolving against the user's
      // sourceRoot here is the single point that fixes every dispatcher.
      const liveSourceRoot = usePreferencesStore.getState().sourceRoot;
      const absPath = resolveSourcePath(liveSourceRoot, input.path) ?? input.path;
      const titleFor = (p: string) => {
        const base = p.replace(/\\/g, "/").split("/").pop() || p;
        return input.startLine
          ? `${base}:${input.startLine}${input.endLine && input.endLine !== input.startLine ? `–${input.endLine}` : ""}`
          : base;
      };
      const existingTabs = useTabsStore.getState().tabs;
      const reused = Object.values(existingTabs).some(
        (t) =>
          t.kind === "code-viewer" &&
          t.path === absPath &&
          t.startLine === input.startLine &&
          t.endLine === input.endLine,
      );
      const id = useTabsStore.getState().openTab({
        kind: "code-viewer",
        path: absPath,
        startLine: input.startLine,
        endLine: input.endLine,
        title: input.title ?? titleFor(absPath),
      });
      // When the tab is reused, props don't change so React's effect won't
      // re-run the scroll + pulse. Nudge the pane via a window event so
      // re-clicking the same chip still lands the user on the right line.
      if (reused) {
        window.dispatchEvent(
          new CustomEvent("devops-studio:re-pulse-code-range", {
            detail: {
              path: absPath,
              startLine: input.startLine,
              endLine: input.endLine,
            },
          }),
        );
      }
      return id;
    },
    [],
  );

  const openCodeReviewTab = useCallback(
    (input?: {
      cwd?: string;
      base?: string | null;
      rehydrateThreadId?: string;
      title?: string;
    }) => {
      const liveSourceRoot = usePreferencesStore.getState().sourceRoot;
      const cwd = input?.cwd ?? liveSourceRoot;
      if (!cwd) {
        void openSettingsWindow("general");
        return null;
      }
      return useTabsStore.getState().openTab({
        kind: "code-review",
        cwd,
        base: input?.base ?? null,
        rehydrateThreadId: input?.rehydrateThreadId ?? null,
        title: input?.title,
      });
    },
    [],
  );

  const openTerminalTab = useCallback(
    (input?: { cwd?: string | null; shellId?: string | null }) => {
      // Resolve cwd at call time. If the caller didn't pass one, fall back
      // to the user's source root — terminals you open from the palette
      // almost always want to land in your project, not the app's process
      // cwd. Passing null explicitly lets a caller opt out and use whatever
      // Rust's default cwd resolution gives back.
      const liveSourceRoot = usePreferencesStore.getState().sourceRoot;
      const cwd =
        input?.cwd === undefined ? liveSourceRoot ?? null : input.cwd;
      return useTabsStore.getState().openTab({
        kind: "terminal",
        cwd,
        shellId: input?.shellId ?? null,
      });
    },
    [],
  );

  const openGeneratorTab = useCallback(
    (input?: {
      planId?: number | null;
      suiteId?: number | null;
      /** Optional: hydrate the new tab's session from this store BEFORE
       *  mounting (used by the history pane's "open draft" action so the
       *  pane lands directly in review instead of flashing input). */
      hydrateFrom?: GenerationSessionStore;
      /** History runId backing this tab. When present and a generator
       *  tab is already open against that runId, activate it instead of
       *  stacking a duplicate. */
      runId?: string | null;
    }) => {
      const requestedPlanId = input?.planId ?? null;
      const requestedSuiteId = input?.suiteId ?? null;
      const requestedRunId = input?.runId ?? null;

      // Dedup by runId is handled by the store's openTab when runId is set.
      // For un-bound tabs we always create a fresh one (per the original
      // contract — multiple drafts in parallel is intentional).
      if (requestedRunId) {
        const tabsState = useTabsStore.getState();
        const existing = Object.values(tabsState.tabs).find(
          (t) => t.kind === "generator" && t.runId === requestedRunId,
        );
        if (existing) {
          // Activate the tab in the leaf it actually lives in — earlier
          // versions hard-coded ROOT_LEAF_ID, which silently no-op'd when
          // the existing generator tab was in any other pane (after a
          // split, or any leaf the user has dragged it to). That made
          // "Open in review" look broken on the second invocation.
          const owner = findLeafByTab(tabsState.paneTree, existing.id);
          const leafId = owner?.id ?? tabsState.focusedLeafId;
          tabsState.setActiveInLeaf(leafId, existing.id);
          return existing.id;
        }
      }

      // Build the per-tab Zustand store BEFORE registering the tab so its
      // initial state can already reflect the hydrate target.
      const store = input?.hydrateFrom ?? createGenerationSessionStore();
      if (!input?.hydrateFrom && requestedPlanId !== null) {
        store.getState().setTarget(requestedPlanId, requestedSuiteId);
      }

      const id = useTabsStore.getState().openTab({
        kind: "generator",
        title: deriveGeneratorTabTitle(store.getState()),
        initialPlanId: requestedPlanId,
        initialSuiteId: requestedSuiteId,
        runId: requestedRunId ?? store.getState().runId ?? null,
      });
      // Bind the store to the new tab id (or refresh if the runId-dedup
      // path above didn't already activate an existing one).
      genStoresApi.attach(id, store);
      return id;
    },
    [genStoresApi],
  );

  const [sidebarView, setSidebarView] = useState<SidebarViewId>(readSidebarView);
  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarView(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // ignore
    }
  }, []);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);

  // Cross-pane sidebar nav. The thread switcher's "See all chats" footer
  // dispatches this so the user lands in the Chats sidebar view in one
  // click. Any other pane that wants to do the same can fire the event.
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const detail = (e as CustomEvent<{ view: SidebarViewId }>).detail;
      if (detail?.view) {
        persistSidebarView(detail.view);
        // Make sure the sidebar panel is actually expanded — collapsed
        // sidebar would land the user on a hidden view.
        sidebarRef.current?.expand?.();
      }
    };
    window.addEventListener("devops-studio:switch-sidebar-view", onSwitch);
    return () =>
      window.removeEventListener("devops-studio:switch-sidebar-view", onSwitch);
  }, [persistSidebarView]);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const staleCount = useStaleCases((s) => s.cases.length);
  useEffect(() => {
    const id = window.setTimeout(() => {
      void useStaleCases.getState().scan();
    }, 5000);
    return () => window.clearTimeout(id);
  }, []);

  // Side channel: any component (BugPane / TestCasePane / CommandPalette)
  // can dispatch this event to open a CodeViewer tab without prop-drilling.
  useEffect(() => {
    type Detail = {
      path: string;
      startLine?: number;
      endLine?: number;
      title?: string;
    };
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<Detail>;
      if (!ce.detail?.path) return;
      openCodeViewerTab(ce.detail);
    };
    window.addEventListener("devops-studio:open-code-viewer", onOpen);
    return () =>
      window.removeEventListener("devops-studio:open-code-viewer", onOpen);
  }, [openCodeViewerTab]);

  // Side channel: open a BugPane by id. Used by the linked-work-items
  // section in TestCasePane (Phase 6B follow-up) and from the command palette.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<{ bugId: number; title?: string }>;
      if (!ce.detail?.bugId) return;
      openBugTab({
        bugId: ce.detail.bugId,
        title: ce.detail.title ?? `Bug #${ce.detail.bugId}`,
      });
    };
    window.addEventListener("devops-studio:open-bug", onOpen);
    return () => window.removeEventListener("devops-studio:open-bug", onOpen);
  }, [openBugTab]);

  // Side channel: open a TestCasePane by id. Symmetric counterpart of
  // devops-studio:open-bug — fired from BugPane's linked-work-items list
  // so the user can drill from a bug into its test cases without leaving
  // the app.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<{ caseId: number; title?: string }>;
      if (!ce.detail?.caseId) return;
      openTestCaseTab({
        caseId: ce.detail.caseId,
        title: ce.detail.title ?? `#${ce.detail.caseId}`,
      });
    };
    window.addEventListener("devops-studio:open-test-case", onOpen);
    return () =>
      window.removeEventListener("devops-studio:open-test-case", onOpen);
  }, [openTestCaseTab]);

  // Source-directory picker. Persists to preferences so the BugPane's code-link
  // rows can resolve relative paths the next time the user opens the app.
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const pickSourceDir = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your source-code directory",
        defaultPath: sourceRoot ?? undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        await setSourceRoot(picked);
      }
    } catch {
      // User cancelled or no permission — nothing to do.
    }
  }, [sourceRoot]);

  const { zoomIn, zoomOut, zoomReset } = useZoom();

  const [paletteOpen, setPaletteOpen] = useState(false);
  // Global keyboard shortcuts. Wired through useGlobalShortcuts so the
  // Settings → Shortcuts page can customize bindings — declaring them
  // there but not handling them here would let users "rebind" keys that
  // never fired. The isDisabled guard suppresses our shortcuts inside text
  // inputs so they don't shadow typing.
  useGlobalShortcuts(
    {
      "palette.open": () => setPaletteOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": () => {
        const ref = sidebarRef.current;
        if (!ref) return;
        if (ref.isCollapsed()) ref.expand();
        else ref.collapse();
      },
      "theme.cycle": () => {
        const order: Array<"system" | "light" | "dark"> = ["system", "light", "dark"];
        const curr = usePreferencesStore.getState().theme;
        const next = order[(order.indexOf(curr) + 1) % order.length];
        void setTheme(next);
      },
      "generator.new": () => openGeneratorTab(),
      "terminal.new": () => openTerminalTab(),
      "codeReview.new": () => {
        openCodeReviewTab();
      },
      "terminal.copy": () => withFocusedTerminal((session) => {
        if (!session.term.hasSelection()) return;
        void navigator.clipboard
          .writeText(session.term.getSelection())
          .catch(() => undefined);
      }),
      "terminal.paste": () => withFocusedTerminal((session) => {
        void (async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const { writePty, encodeForPty } = await import(
              "@/modules/terminal/usePtySession"
            );
            await writePty(session.sessionId, encodeForPty(text));
          } catch {
            // ignore — clipboard read may be blocked
          }
        })();
      }),
      "terminal.clear": () => withFocusedTerminal((s) => s.term.clear()),
      "terminal.fontSizeUp": () => {
        const cur = usePreferencesStore.getState().terminalFontSize;
        void import("@/modules/settings/store").then(({ setTerminalFontSize }) =>
          setTerminalFontSize(cur + 1),
        );
      },
      "terminal.fontSizeDown": () => {
        const cur = usePreferencesStore.getState().terminalFontSize;
        void import("@/modules/settings/store").then(({ setTerminalFontSize }) =>
          setTerminalFontSize(cur - 1),
        );
      },
      "tab.close": () => {
        const target = focusedActiveId();
        if (target != null) useTabsStore.getState().closeTab(target);
      },
      "tab.next": () => useTabsStore.getState().nextTabInFocusedLeaf(),
      "tab.prev": () => useTabsStore.getState().prevTabInFocusedLeaf(),
      "tab.pin": () => {
        const target = focusedActiveId();
        if (target != null) useTabsStore.getState().togglePin(target);
      },
      "tab.duplicate": () => {
        const target = focusedActiveId();
        if (target != null) useTabsStore.getState().duplicateTab(target);
      },
      "tab.closeOthers": () =>
        useTabsStore
          .getState()
          .closeOthers(useTabsStore.getState().focusedLeafId),
      "tab.closeToRight": () =>
        useTabsStore
          .getState()
          .closeToRight(useTabsStore.getState().focusedLeafId),
      "tab.closeAll": () =>
        useTabsStore
          .getState()
          .closeAll(useTabsStore.getState().focusedLeafId),
      "tab.reopenClosed": () => useTabsStore.getState().reopenClosed(),
      "tab.jumpTo1": () => useTabsStore.getState().jumpToTabInFocusedLeaf(1),
      "tab.jumpTo2": () => useTabsStore.getState().jumpToTabInFocusedLeaf(2),
      "tab.jumpTo3": () => useTabsStore.getState().jumpToTabInFocusedLeaf(3),
      "tab.jumpTo4": () => useTabsStore.getState().jumpToTabInFocusedLeaf(4),
      "tab.jumpTo5": () => useTabsStore.getState().jumpToTabInFocusedLeaf(5),
      "tab.jumpTo6": () => useTabsStore.getState().jumpToTabInFocusedLeaf(6),
      "tab.jumpTo7": () => useTabsStore.getState().jumpToTabInFocusedLeaf(7),
      "tab.jumpTo8": () => useTabsStore.getState().jumpToTabInFocusedLeaf(8),
      "tab.jumpTo9": () => useTabsStore.getState().jumpToTabInFocusedLeaf(9),
      "tab.moveToNextPane": () => {
        const target = focusedActiveId();
        if (target != null) useTabsStore.getState().moveTabToNextPane(target);
      },
      "tab.moveToPrevPane": () => {
        const target = focusedActiveId();
        if (target != null) useTabsStore.getState().moveTabToPrevPane(target);
      },
      "pane.splitRight": () => {
        const focusedLeaf = useTabsStore.getState().focusedLeafId;
        const target = focusedActiveId();
        useTabsStore
          .getState()
          .splitLeaf(focusedLeaf, "horizontal", "after", target ?? undefined);
      },
      "pane.splitDown": () => {
        const focusedLeaf = useTabsStore.getState().focusedLeafId;
        const target = focusedActiveId();
        useTabsStore
          .getState()
          .splitLeaf(focusedLeaf, "vertical", "after", target ?? undefined);
      },
      "pane.close": () =>
        useTabsStore
          .getState()
          .closeLeaf(useTabsStore.getState().focusedLeafId),
      "pane.focusLeft": () => useTabsStore.getState().focusDirection("left"),
      "pane.focusRight": () => useTabsStore.getState().focusDirection("right"),
      "pane.focusUp": () => useTabsStore.getState().focusDirection("up"),
      "pane.focusDown": () => useTabsStore.getState().focusDirection("down"),
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
    },
    {
      // Don't hijack keystrokes while the user is typing — but the global
      // mod-prefixed shortcuts (palette, settings) are explicit chord keys
      // that won't conflict with text input. Only filter out PLAIN-key
      // shortcuts that would interfere with typing.
      isDisabled: (_id, e) => {
        const tag =
          (document.activeElement as HTMLElement | null)?.tagName ?? "";
        const isText = tag === "INPUT" || tag === "TEXTAREA";
        // Anything with a primary modifier is safe to fire even inside
        // text inputs (Ctrl+K, Ctrl+, etc.) — that's the standard editor
        // contract. Plain keys are not currently used by these shortcuts
        // but the guard future-proofs against accidentally adding one.
        const hasMod = e.ctrlKey || e.metaKey || e.altKey;
        return isText && !hasMod;
      },
    },
  );

  // Currently-selected case id (derived from active tab), so the test-plans
  // panel can highlight the row matching what's on screen.
  const activeCaseId =
    activeTab && activeTab.kind === "test-case" ? activeTab.caseId : null;

  // Keep-in-view of the active tab is handled inside TabStrip now (each
  // leaf scrolls its own active chip into view on change).

  // What the active generator tab is doing right now (if the active tab IS
  // a generator). Used by StatusBarModelPicker to lock the model when the
  // user is in a draft / refining — outside any GenerationSessionProvider,
  // so we read from the lifted phase map by activeId.
  const activeGenSessionInfo =
    activeTab && activeTab.kind === "generator" && activeId !== null
      ? (genSessionPhases[activeId] ?? null)
      : null;

  const [adoConfigured, setAdoConfigured] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const c = await getConnection();
        if (!cancelled) setAdoConfigured(c.configured);
      } catch {
        if (!cancelled) setAdoConfigured(false);
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Install the production-only right-click guard. Lives in a shared helper
  // so settings/main.tsx can call the same thing.
  useEffect(() => installContextMenuGuard(), []);

  // Broadcast a "generation busy" signal to other windows (settings) so the
  // default-model picker over there can lock while ANY generator tab is
  // mid-run / has an open draft. The status-bar picker in this window does
  // the same check locally via activeGenSessionInfo — the event is the
  // cross-window equivalent.
  useEffect(() => {
    let busy = false;
    let reason: GenerationBusyReason = "idle";
    for (const info of Object.values(genSessionPhases)) {
      if (!info) continue;
      const running =
        info.phase === "analyzing" || info.phase === "publishing";
      const inDraft = info.phase === "review" || info.phase === "done";
      if (running) {
        busy = true;
        reason = "running";
        break; // strongest signal, no need to keep scanning
      }
      if (info.isRefining) {
        busy = true;
        if (reason === "idle") reason = "refining";
      } else if (inDraft) {
        busy = true;
        if (reason === "idle") reason = "in-draft";
      }
    }
    void emitGenerationBusy({ busy, reason });
  }, [genSessionPhases]);

  // ------ Updater wiring -----------------------------------------------
  // Single useUpdater instance shared between the status-bar pill and the
  // bottom-left toast. AboutSection keeps its own instance because manual
  // checks from settings shouldn't trip a notification toast.
  const updater = useUpdater();
  const updaterAvailableVersion =
    updater.status.kind === "available"
      ? updater.status.update.version
      : null;
  // Per-version dismiss: closing the toast hides it for THIS release but
  // keeps the status-bar pill so the user can find it again. When a newer
  // release lands the toast comes back on its own.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    () => {
      try {
        return window.localStorage.getItem(UPDATER_DISMISS_KEY);
      } catch {
        return null;
      }
    },
  );
  const toastSuppressed =
    updaterAvailableVersion !== null &&
    dismissedVersion === updaterAvailableVersion;
  const dismissToast = useCallback(() => {
    if (!updaterAvailableVersion) {
      updater.dismiss();
      return;
    }
    try {
      window.localStorage.setItem(UPDATER_DISMISS_KEY, updaterAvailableVersion);
    } catch {
      // ignore — falls back to in-memory dismissal for this session
    }
    setDismissedVersion(updaterAvailableVersion);
  }, [updater, updaterAvailableVersion]);
  const reopenToast = useCallback(() => {
    // Clicking the pill un-dismisses the toast for the current version so
    // the user can re-read the changelog without re-opening Settings.
    if (updaterAvailableVersion) {
      try {
        window.localStorage.removeItem(UPDATER_DISMISS_KEY);
      } catch {
        // ignore
      }
      setDismissedVersion(null);
    }
  }, [updaterAvailableVersion]);
  const showUpdaterToast =
    !toastSuppressed &&
    (updater.status.kind === "available" ||
      updater.status.kind === "downloading" ||
      updater.status.kind === "ready");

  // Tab strip per-leaf now lives inside the workspace area; the header
  // shrinks to drag region + source-dir + settings + window controls.
  // Generator pane callbacks live in a context so TabContent can find them
  // without prop-drilling through the recursive renderer.
  const generatorCallbacks = useMemo(
    () => ({
      onOpenCase: openTestCaseTab,
      onRenameTab: renameGeneratorTab,
      onReportSession: reportGenSession,
    }),
    [openTestCaseTab, renameGeneratorTab, reportGenSession],
  );

  const workspaceEmptyState = useMemo(
    () => (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[13px] font-medium">
          Pick a test case or open something new.
        </p>
        <p className="max-w-md text-[11.5px] text-muted-foreground">
          Open a case from the Plans tree on the left, or use the launcher
          below to start a generation, terminal, or code review.
        </p>
        <LaunchMenu
          actions={{
            onGenerator: launchGenerator,
            onTerminal: launchTerminal,
            onCodeReview: launchCodeReview,
            sourceRoot,
          }}
          align="center"
          side="bottom"
        >
          <Button size="sm" className="mt-2 gap-1.5">
            <HugeiconsIcon
              icon={PlusSignIcon}
              size={12}
              strokeWidth={1.75}
            />
            Open something
          </Button>
        </LaunchMenu>
      </div>
    ),
    [sourceRoot],
  );

  const paneTree = useTabsStore((s) => s.paneTree);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {/* Top bar: drag region + source dir + settings + window controls.
              Tabs moved into the workspace (per-leaf strips) in the
              tab/pane UX upgrade — gives each pane its own strip and
              opens the room needed for drag-to-split. */}
          <header
            data-tauri-drag-region
            className={cn(
              "flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-card/60 select-none",
              // macOS keeps the native traffic lights at the left via the
              // overlay title bar — leave room. Otherwise pad normally.
              IS_MAC ? "pl-20 pr-2" : "px-2",
            )}
          >
            <div
              data-tauri-drag-region
              className="min-w-0 flex-1 px-2 text-[11px] text-muted-foreground"
            >
              DevOps Studio
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 max-w-[260px] gap-1.5 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => void pickSourceDir()}
                  aria-label="Source directory"
                >
                  <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {sourceRoot
                      ? compactPath(sourceRoot)
                      : "Pick source directory…"}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[420px] text-[11px]">
                {sourceRoot
                  ? `Source: ${sourceRoot} — click to change`
                  : "Click to choose a source directory. Code links in bugs open from here."}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => void openSettingsWindow()}
                  aria-label="Settings"
                >
                  <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Settings
              </TooltipContent>
            </Tooltip>
            {USE_CUSTOM_WINDOW_CONTROLS ? <WindowControls /> : null}
          </header>

          <main className="flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={`${sidebarWidthRef.current}px`}
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div className="min-h-0 flex-1 relative">
                    {/* All three panels stay mounted so expanded test-plan
                        suites and loaded case lists survive a tab switch — the
                        old conditional render reset local state every flip. */}
                    <div
                      className="absolute inset-0 flex flex-col"
                      style={{ display: sidebarView === "test-plans" ? "flex" : "none" }}
                    >
                      <TestPlansPanel
                        onOpenCase={openTestCaseTab}
                        onStartGenerator={openGeneratorTab}
                        onChatWithSuite={(input) => {
                          const title = `Chat: ${input.suiteName ?? `#${input.suiteId}`}`;
                          openSuiteChatTab({
                            planId: input.planId,
                            suiteId: input.suiteId,
                            title,
                          });
                        }}
                        activeCaseId={activeCaseId}
                      />
                    </div>
                    <div
                      className="absolute inset-0 flex flex-col"
                      style={{ display: sidebarView === "stale-queue" ? "flex" : "none" }}
                    >
                      <StaleQueuePanel onOpenCase={openTestCaseTab} />
                    </div>
                    <div
                      className="absolute inset-0 flex flex-col"
                      style={{ display: sidebarView === "history" ? "flex" : "none" }}
                    >
                      <GenerationHistoryPane
                        onOpenCase={openTestCaseTab}
                        onOpenBug={openBugTab}
                        onOpenDraft={(run) => {
                          // Dedup first: if a generator tab is already open
                          // for this draft, openGeneratorTab activates it
                          // and we never spin up a second store.
                          const existing = Object.values(
                            useTabsStore.getState().tabs,
                          ).find(
                            (t) =>
                              t.kind === "generator" && t.runId === run.id,
                          );
                          if (existing) {
                            setActiveId(existing.id);
                            return;
                          }
                          // Create a fresh session store for the restored draft
                          // and hydrate it BEFORE opening the tab — landing
                          // directly in review without flashing input.
                          const store = createGenerationSessionStore();
                          const ok = store.getState().loadDraft(run);
                          if (!ok) return;
                          openGeneratorTab({
                            planId: run.planId,
                            suiteId: run.suiteId,
                            hydrateFrom: store,
                            runId: run.id,
                          });
                        }}
                        onOpenPublished={(run) => {
                          // Same dedup as draft re-open. If the user has the
                          // session for this run already open, just activate
                          // it instead of spinning up a parallel done-view.
                          const existing = Object.values(
                            useTabsStore.getState().tabs,
                          ).find(
                            (t) =>
                              t.kind === "generator" && t.runId === run.id,
                          );
                          if (existing) {
                            setActiveId(existing.id);
                            return;
                          }
                          const store = createGenerationSessionStore();
                          const ok = store.getState().loadPublishedRun(run);
                          if (!ok) return;
                          openGeneratorTab({
                            planId: run.planId,
                            suiteId: run.suiteId,
                            hydrateFrom: store,
                            runId: run.id,
                          });
                        }}
                      />
                    </div>
                    <div
                      className="absolute inset-0 flex flex-col"
                      style={{
                        display:
                          sidebarView === "chat-history" ? "flex" : "none",
                      }}
                    >
                      <ChatHistoryPanel
                        onOpenChat={(input) =>
                          openSuiteChatTab(input)
                        }
                        onOpenCodeReview={(input) => {
                          openCodeReviewTab({
                            cwd: input.cwd,
                            base: input.base,
                            rehydrateThreadId: input.threadId,
                            title: input.title,
                          });
                        }}
                      />
                    </div>
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    staleCount={staleCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="relative h-full min-h-0">
                  {showUpdaterToast && (
                    <UpdaterToast
                      status={updater.status}
                      onInstall={() => void updater.install()}
                      onDismiss={dismissToast}
                    />
                  )}
                  <GeneratorCallbacksProvider value={generatorCallbacks}>
                    <TabsDndProvider>
                      <PaneTreeRenderer
                        node={paneTree}
                        sourceRoot={sourceRoot}
                        emptyState={workspaceEmptyState}
                      />
                    </TabsDndProvider>
                  </GeneratorCallbacksProvider>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {/* Status bar — git branch & source dir on the left, ADO + stale
              indicators pinned to the right. */}
          <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px] text-muted-foreground">
            <StatusBarBranch sourceRoot={sourceRoot} onPick={() => void pickSourceDir()} />
            <div className="ml-auto flex items-center gap-2">
              <StatusBarModelPicker activeSession={activeGenSessionInfo} />
              <UpdaterStatusPill
                status={updater.status}
                onReopenToast={reopenToast}
              />
              {staleCount > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => persistSidebarView("stale-queue")}
                      className="flex h-5 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
                    >
                      <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={1.75} />
                      <span>Stale: {staleCount}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    {staleCount} test case{staleCount === 1 ? "" : "s"} need review.
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void openSettingsWindow("azure-devops")}
                    className="flex h-5 items-center gap-1.5 rounded-md border border-border/60 bg-card px-1.5 transition-colors hover:text-foreground"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full transition-colors duration-200",
                        adoConfigured
                          ? "bg-primary shadow-[0_0_6px_-1px] shadow-primary/70"
                          : "bg-muted-foreground/40",
                      )}
                    />
                    <AzureDevOpsBrand
                      size={11}
                      className={cn(!adoConfigured && "opacity-50 grayscale")}
                    />
                    <span>{adoConfigured ? "Azure DevOps" : "Not connected"}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  {adoConfigured
                    ? "Connected to Azure DevOps. Click to open settings."
                    : "Not connected. Click to configure."}
                </TooltipContent>
              </Tooltip>
            </div>
          </footer>

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onOpenCase={openTestCaseTab}
            onOpenBug={openBugTab}
            onStartGenerator={(input) =>
              openGeneratorTab({
                planId: input?.planId ?? null,
                suiteId: input?.suiteId ?? null,
              })
            }
            onOpenStaleQueue={() => persistSidebarView("stale-queue")}
            onOpenTestPlansSidebar={() => persistSidebarView("test-plans")}
            onOpenHistory={() => persistSidebarView("history")}
            onOpenTerminal={(input) => openTerminalTab(input)}
            onOpenCodeReview={() => {
              openCodeReviewTab();
            }}
            sourceRoot={sourceRoot}
          />

    </div>
  );
}

/**
 * Bottom status bar's left segment: source directory + live git branch.
 * Clicking opens the directory picker (matches the title-bar source-dir
 * button). Hidden until the user has picked a source dir.
 */
function StatusBarBranch({
  sourceRoot,
  onPick,
}: {
  sourceRoot: string | null;
  onPick: () => void;
}) {
  const git = useSourceDirGitInfo();
  if (!sourceRoot) return null;

  const last = sourceRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  const tooltipPath = sourceRoot;
  const branchLabel = git.isRepo
    ? git.branch ?? (git.commit ? `(${git.commit})` : "(detached)")
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onPick}
          className="group flex h-5 items-center gap-2 rounded-md border border-border/60 bg-card px-1.5 transition-colors hover:border-border hover:text-foreground"
          aria-label="Source directory and git branch"
        >
          <span className="flex min-w-0 items-center gap-1">
            <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={1.75} />
            <span className="max-w-[180px] truncate text-[10.5px]">
              {last || sourceRoot}
            </span>
          </span>
          {branchLabel ? (
            <>
              <span aria-hidden className="h-3 w-px bg-border/70" />
              <span className="flex min-w-0 items-center gap-1">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={11}
                  strokeWidth={1.75}
                />
                <span className="max-w-[160px] truncate font-mono text-[10.5px]">
                  {branchLabel}
                </span>
              </span>
            </>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={6}
        variant="panel"
        className="max-w-[420px] px-3 py-2 text-[11px] leading-relaxed"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
              source
            </span>
            <span className="min-w-0 break-all font-mono text-[10.5px] text-foreground/90">
              {tooltipPath}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
              git
            </span>
            {git.isRepo && git.branch ? (
              <span className="font-mono text-[10.5px] text-foreground/85">
                {git.branch}
                {git.commit ? (
                  <span className="ml-1 text-muted-foreground/70">
                    · {git.commit}
                  </span>
                ) : null}
              </span>
            ) : git.isRepo ? (
              <span className="font-mono text-[10.5px] text-muted-foreground">
                detached HEAD
                {git.commit ? (
                  <span className="ml-1 text-muted-foreground/70">
                    · {git.commit}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[10.5px] italic text-muted-foreground">
                not a git repository
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            Click to change the source directory.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact status-bar model switcher. This is the *default* model — picking
 * here mutates the persisted preference, so the choice survives restarts.
 * For a one-off swap (this run only) the user picks from the generator's
 * action-row picker instead. Disabled while a generation is mid-flight.
 */
function StatusBarModelPicker({
  activeSession,
}: {
  /** Phase + isRefining for the currently-active generator tab (if any).
   *  null when no generator tab is active or open. App.tsx aggregates this
   *  from per-tab Provider scopes since the status bar lives outside any
   *  GenerationSessionProvider. */
  activeSession: { phase: SessionState["phase"]; isRefining: boolean } | null;
}) {
  const selectedModelId = useChatStore((s) => s.selectedModelId);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const availability = useModelAvailability();
  const generationPhase = activeSession?.phase ?? "input";
  const isRefining = activeSession?.isRefining ?? false;
  const isRunning =
    generationPhase === "analyzing" || generationPhase === "publishing";
  // Once a draft exists (review/done) the conversation has an established
  // model — flipping it mid-thread strands follow-ups against a model that
  // never saw the prior turns. Lock until the user explicitly starts new.
  const isInDraft = generationPhase === "review" || generationPhase === "done";
  const isLocked = isRunning || isRefining || isInDraft;
  const model = getModel(selectedModelId);
  return (
    <ModelPicker
      value={selectedModelId}
      onChange={setSelectedModelId}
      filter={availability.isAvailable}
      disabled={isLocked}
      disabledReason={
        isRunning
          ? "A generation is running — model swap takes effect on the next run."
          : isRefining
            ? "Refining the current draft — the model is locked for this thread."
            : "A draft is open. Start a new session to switch models."
      }
      side="top"
      align="end"
      emptyMessage={
        <>No providers connected. Open Settings → Models to add one.</>
      }
      trigger={({ label, provider, disabled }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                // Matches the source-dir + ADO status pills next to it.
                // Adds a "default" tag at the front so the user is never
                // confused about whether they're staring at the persisted
                // default or a one-off override — overrides only live on
                // the generator page.
                "flex h-5 items-center gap-1.5 rounded-md border border-border/60 bg-card px-1.5 transition-colors hover:text-foreground",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <span className="font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
                default
              </span>
              <span className="text-muted-foreground/30">·</span>
              <ProviderIcon provider={provider} size={11} />
              <span className="max-w-[160px] truncate">{label}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {model.hint.toLowerCase()}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] text-[11px]">
            {disabled
              ? isRunning
                ? "Generation in progress — change applies next run."
                : isRefining
                  ? "Refining the current draft — model is locked for this thread."
                  : "A draft is open. Start a new session to switch models."
              : "Default model for all generations. Set once here (or in Settings → Models) — pick a different model for a single run from the generator's action row."}
          </TooltipContent>
        </Tooltip>
      )}
    />
  );
}
