import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CommandPalette } from "@/modules/command-palette";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";
import {
  BugStack,
  StaleQueuePanel,
  TestCaseStack,
  TestPlansPanel,
  useStaleCases,
} from "@/modules/test-plans";
import { setSourceRoot } from "@/modules/settings/store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { GeneratorStack, GenerationHistoryPane } from "@/modules/generator";
import { CodeViewerStack } from "@/modules/code-viewer";
import { ThemeProvider } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import { useGenerationSession } from "@/modules/generator/store/useGenerationSession";
import { getConnection } from "@/modules/ado";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CloudServerIcon,
  FolderOpenIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "devops-studio.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "devops-studio.sidebar.view";

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
    if (stored === "test-plans" || stored === "stale-queue" || stored === "history") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "test-plans";
}

type AppTab =
  | {
      id: number;
      kind: "test-case";
      title: string;
      caseId: number;
    }
  | {
      id: number;
      kind: "generator";
      title: string;
      initialPlanId: number | null;
      initialSuiteId: number | null;
    }
  | {
      id: number;
      kind: "code-viewer";
      title: string;
      path: string;
      startLine?: number;
      endLine?: number;
    }
  | {
      id: number;
      kind: "bug";
      title: string;
      bugId: number;
    };

export default function App() {
  const initPrefs = usePreferencesStore((s) => s.init);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);

  const [tabs, setTabs] = useState<AppTab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const nextIdRef = useRef(1);

  const closeTab = useCallback((id: number) => {
    setTabs((curr) => {
      const idx = curr.findIndex((t) => t.id === id);
      if (idx < 0) return curr;
      const next = curr.filter((t) => t.id !== id);
      setActiveId((a) => {
        if (a !== id) return a;
        if (next.length === 0) return null;
        const replacement = next[Math.max(0, idx - 1)];
        return replacement.id;
      });
      return next;
    });
  }, []);

  const openTestCaseTab = useCallback(
    (input: { caseId: number; title: string }) => {
      let target: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "test-case" && t.caseId === input.caseId,
        );
        if (existing) {
          target = existing.id;
          return curr.map((t) =>
            t.id === existing.id ? { ...t, title: input.title } : t,
          );
        }
        const id = nextIdRef.current++;
        target = id;
        return [
          ...curr,
          { id, kind: "test-case", title: input.title, caseId: input.caseId },
        ];
      });
      if (target !== null) setActiveId(target);
      return target as number | null;
    },
    [],
  );

  const openBugTab = useCallback(
    (input: { bugId: number; title: string }) => {
      let target: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "bug" && t.bugId === input.bugId,
        );
        if (existing) {
          target = existing.id;
          return curr.map((t) =>
            t.id === existing.id ? { ...t, title: input.title } : t,
          );
        }
        const id = nextIdRef.current++;
        target = id;
        return [
          ...curr,
          { id, kind: "bug", title: input.title, bugId: input.bugId },
        ];
      });
      if (target !== null) setActiveId(target);
      return target as number | null;
    },
    [],
  );

  const openCodeViewerTab = useCallback(
    (input: { path: string; startLine?: number; endLine?: number; title?: string }) => {
      const titleFor = (p: string) => {
        const base = p.replace(/\\/g, "/").split("/").pop() || p;
        return input.startLine
          ? `${base}:${input.startLine}${input.endLine && input.endLine !== input.startLine ? `–${input.endLine}` : ""}`
          : base;
      };
      let target: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) =>
            t.kind === "code-viewer" &&
            t.path === input.path &&
            t.startLine === input.startLine &&
            t.endLine === input.endLine,
        );
        if (existing) {
          target = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        target = id;
        return [
          ...curr,
          {
            id,
            kind: "code-viewer",
            title: input.title ?? titleFor(input.path),
            path: input.path,
            startLine: input.startLine,
            endLine: input.endLine,
          },
        ];
      });
      if (target !== null) setActiveId(target);
      return target as number | null;
    },
    [],
  );

  const openGeneratorTab = useCallback(
    (input?: { planId?: number | null; suiteId?: number | null }) => {
      const requestedPlanId = input?.planId ?? null;
      const requestedSuiteId = input?.suiteId ?? null;
      let target: number | null = null;
      let reused = false;
      setTabs((curr) => {
        const existing = curr.find((t) => t.kind === "generator");
        if (existing) {
          target = existing.id;
          reused = true;
          return curr;
        }
        const id = nextIdRef.current++;
        target = id;
        return [
          ...curr,
          {
            id,
            kind: "generator",
            title: "Generate cases",
            initialPlanId: requestedPlanId,
            initialSuiteId: requestedSuiteId,
          },
        ];
      });

      // If we're reusing an existing tab and the caller asked to target a
      // different plan/suite, push it into the session directly — the
      // GeneratorPane's hydrate-from-props useEffect only fires on mount,
      // so it'd otherwise sit on the originally-targeted plan.
      if (reused && (requestedPlanId !== null || requestedSuiteId !== null)) {
        const session = useGenerationSession.getState();
        const planChanged = requestedPlanId !== null && requestedPlanId !== session.planId;
        const suiteChanged = requestedSuiteId !== null && requestedSuiteId !== session.suiteId;
        if (planChanged || suiteChanged) {
          // Reset back to the input phase so the new target is editable —
          // bringing someone into a half-published session against a
          // different plan would be confusing.
          if (session.phase !== "input") session.startNew();
          session.setTarget(
            requestedPlanId ?? session.planId,
            requestedSuiteId ?? session.suiteId,
          );
        }
      }

      if (target !== null) setActiveId(target);
      return target as number | null;
    },
    [],
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

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // Adapt the inline tab shape to the legacy `Tab` union so we can hand it
  // to TestCaseStack / GeneratorStack unchanged. The structural shape on the
  // kinds we use is identical; we just don't have terminal/editor/etc here.
  const compatTabs = tabs as unknown as Tab[];

  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {/* Top bar: drag region + tabs + settings + window controls */}
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
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            >
              {tabs.length === 0 ? (
                <span
                  data-tauri-drag-region
                  className="px-2 text-[11px] text-muted-foreground"
                >
                  DevOps Studio
                </span>
              ) : (
                tabs.map((t) => {
                  const active = t.id === activeId;
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "group flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors",
                        active
                          ? "bg-foreground/[0.08] text-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveId(t.id)}
                        className="max-w-[200px] truncate"
                      >
                        {t.title}
                      </button>
                      <button
                        type="button"
                        aria-label="Close tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.id);
                        }}
                        className="ml-1 inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                      </button>
                    </div>
                  );
                })
              )}
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
                  <div className="min-h-0 flex-1">
                    {sidebarView === "test-plans" ? (
                      <TestPlansPanel
                        onOpenCase={openTestCaseTab}
                        onStartGenerator={openGeneratorTab}
                      />
                    ) : sidebarView === "stale-queue" ? (
                      <StaleQueuePanel onOpenCase={openTestCaseTab} />
                    ) : (
                      <GenerationHistoryPane
                        onOpenCase={openTestCaseTab}
                        onOpenBug={openBugTab}
                      />
                    )}
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
                  {tabs.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                      <p className="text-[13px] font-medium">Pick a test case or start a generation.</p>
                      <p className="max-w-md text-[11.5px] text-muted-foreground">
                        Open a case from the Plans tree on the left, or click <em>Generate</em> at the
                        top of the panel to draft new cases from your spec.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="absolute inset-0">
                        <TestCaseStack tabs={compatTabs} activeId={activeId ?? -1} />
                      </div>
                      <div className="absolute inset-0">
                        <GeneratorStack
                          tabs={compatTabs}
                          activeId={activeId ?? -1}
                          onOpenCase={openTestCaseTab}
                        />
                      </div>
                      <div className="absolute inset-0">
                        <CodeViewerStack
                          tabs={compatTabs}
                          activeId={activeId ?? -1}
                        />
                      </div>
                      <div className="absolute inset-0">
                        <BugStack
                          tabs={compatTabs}
                          activeId={activeId ?? -1}
                          sourceRoot={sourceRoot}
                        />
                      </div>
                    </>
                  )}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {/* Minimal status bar */}
          <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void openSettingsWindow("azure-devops")}
                    className="flex h-5 items-center gap-1.5 rounded-md border border-border/60 bg-card px-1.5 transition-colors hover:text-foreground"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        adoConfigured ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                    <HugeiconsIcon icon={CloudServerIcon} size={11} strokeWidth={1.75} />
                    <span>ADO</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  {adoConfigured
                    ? "Connected to Azure DevOps. Click to open settings."
                    : "Not connected. Click to configure."}
                </TooltipContent>
              </Tooltip>
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
          />

          <UpdaterDialog />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
