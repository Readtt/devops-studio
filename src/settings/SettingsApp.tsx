import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WindowControls } from "@/components/WindowControls";
import { AzureDevOpsLogo } from "@/components/AzureDevOpsLogo";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { useZoom } from "@/lib/useZoom";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  InformationCircleIcon,
  Settings01Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { JSX, ReactNode, useEffect, useState } from "react";
import { AboutSection } from "./sections/AboutSection";
import { AzureDevOpsSection } from "./sections/AzureDevOpsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { ModelsSection } from "./sections/ModelsSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";

type TabDef = {
  id: SettingsTab;
  label: string;
  /** Rendered before the label inside the tab trigger. */
  glyph: ReactNode;
  component: () => JSX.Element;
};

const TABS: TabDef[] = [
  {
    id: "general",
    label: "General",
    glyph: <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />,
    component: GeneralSection,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    glyph: <HugeiconsIcon icon={KeyboardIcon} size={12} strokeWidth={1.75} />,
    component: ShortcutsSection,
  },
  {
    id: "azure-devops",
    label: "Azure DevOps",
    glyph: <AzureDevOpsLogo size={12} />,
    component: AzureDevOpsSection,
  },
  {
    id: "models",
    label: "Models",
    glyph: <HugeiconsIcon icon={AiScanIcon} size={12} strokeWidth={1.75} />,
    component: ModelsSection,
  },
  {
    id: "about",
    label: "About",
    glyph: <HugeiconsIcon icon={InformationCircleIcon} size={12} strokeWidth={1.75} />,
    component: AboutSection,
  },
];

const VALID_TABS: SettingsTab[] = [
  "general",
  "shortcuts",
  "azure-devops",
  "models",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  // Back-compat: legacy "ai" / "connections" → "models".
  if (t === "ai" || t === "connections") return "models";
  if (t && (VALID_TABS as string[]).includes(t)) return t as SettingsTab;
  return "general";
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find(t => t.id === active)?.component;

  // Settings deliberately does NOT zoom itself — adjusting the UI scale
  // slider while the Settings window also rescaled was making the
  // slider jump under the cursor. The keybinds still write to prefs so
  // the main window scales live; Settings stays at 100%.
  const { zoomIn, zoomOut, zoomReset } = useZoom({ apply: false });
  useGlobalShortcuts({
    "view.zoomIn": zoomIn,
    "view.zoomOut": zoomOut,
    "view.zoomReset": zoomReset,
  });

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const apply = (detail: string) => {
      if (detail === "ai" || detail === "connections") {
        setActive("models");
        return;
      }
      // Legacy "agents" requests land on Models — the Agents tab is gone.
      if (detail === "agents") {
        setActive("models");
        return;
      }
      if ((VALID_TABS as string[]).includes(detail)) {
        setActive(detail as SettingsTab);
      }
    };
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(
      "devops-studio:settings-tab",
      (e) => apply(e.payload),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 ${IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
      >
        <Tabs
          value={active}
          onValueChange={(v) => setActive(v as SettingsTab)}
          orientation="horizontal"
          className="flex-1 items-center"
          data-tauri-drag-region
        >
          <TabsList className="mx-auto h-7 bg-muted/40 px-2">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-6 gap-1.5 px-2.5 text-[11.5px]"
              >
                {t.glyph}
                <span>{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          {ActiveSection && <ActiveSection />}
        </div>
      </main>
    </div>
  );
}
