import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type {
  EditorThemeId,
  ThemePref,
} from "@/modules/settings/store";
import {
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  EDITOR_THEMES,
  EDITOR_THEME_LABELS,
  setAutostart,
  setEditorFontSize,
  setEditorHighlightActiveLine,
  setEditorLineNumbers,
  setEditorTabSize,
  setEditorTheme,
  setEditorWordWrap,
  setRestoreWindowState,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const editorTheme = usePreferencesStore((s) => s.editorTheme);
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorLineNumbers = usePreferencesStore((s) => s.editorLineNumbers);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const editorHighlightActiveLine = usePreferencesStore(
    (s) => s.editorHighlightActiveLine,
  );
  const editorTabSize = usePreferencesStore((s) => s.editorTabSize);

  // Reconcile autostart pref with the actual OS state on mount — the user may
  // have toggled it from System Settings.
  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="General"
        description="Appearance and startup behavior."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setTheme(o.id)}
              className={cn(
                "group flex h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border bg-card transition-all",
                theme === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={16} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open DevOps Studio automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>

      {/* Code editor preferences — applied to the read-only code viewer
          (`fs_read_file` source previews + bug code-ref jumps). */}
      <div className="flex flex-col gap-2">
        <Label>Code editor</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Theme"
            description="Each theme is a pair — picking it once covers both light and dark mode. DevOps Studio blends into the app chrome; the rest are battle-tested favorites that fall back to a paired light variant when the app flips to light mode."
          >
            <Select
              value={editorTheme}
              onValueChange={(v) => void setEditorTheme(v as EditorThemeId)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITOR_THEMES.map((id) => (
                  <SelectItem key={id} value={id}>
                    {EDITOR_THEME_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title="Font size"
            description="Editor font size in pixels."
          >
            <Select
              value={String(editorFontSize)}
              onValueChange={(v) => void setEditorFontSize(Number(v))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITOR_FONT_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title="Tab size"
            description="Width of a tab character in the gutter and on indentation."
          >
            <Select
              value={String(editorTabSize)}
              onValueChange={(v) => void setEditorTabSize(Number(v))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITOR_TAB_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} spaces
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title="Show line numbers"
            description="Toggle the gutter that displays line numbers and the fold controls."
          >
            <Switch
              checked={editorLineNumbers}
              onCheckedChange={(v) => void setEditorLineNumbers(v)}
            />
          </SettingRow>
          <SettingRow
            title="Soft-wrap long lines"
            description="Wrap long lines at the viewport edge instead of scrolling horizontally."
          >
            <Switch
              checked={editorWordWrap}
              onCheckedChange={(v) => void setEditorWordWrap(v)}
            />
          </SettingRow>
          <SettingRow
            title="Highlight the active line"
            description="Tint the row containing the cursor (or the highlighted range from a bug code link)."
          >
            <Switch
              checked={editorHighlightActiveLine}
              onCheckedChange={(v) => void setEditorHighlightActiveLine(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
