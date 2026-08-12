import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  setExternalEditorCommand,
  setRestoreWindowState,
  setZoomLevel,
} from "@/modules/settings/store";
import {
  getPrimaryBinding,
  getBindingTokens,
} from "@/modules/shortcuts";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  MinusSignIcon,
  Moon02Icon,
  PlusSignIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { SourceReposPanel } from "./SourceReposSection";

// Lower bound is 80% — below that, the app's 11-12 px UI density starts
// clipping (test-plan tree, generator review grid). Mirrors lib/useZoom.ts.
const UI_ZOOM_MIN = 0.8;
const UI_ZOOM_MAX = 2.0;
const UI_ZOOM_STEP = 0.1;

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
  const externalEditorCommand = usePreferencesStore(
    (s) => s.externalEditorCommand,
  );
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

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
        description="Appearance, startup behavior, and the repositories you work in."
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
        <Label>Display</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="UI scale"
            description="Scales the entire app — useful for accessibility or scaling up on high-DPI displays. Affects both windows."
          >
            <UiScaleControl
              zoomLevel={zoomLevel}
              zoomInBinding={getBindingTokens(
                getPrimaryBinding("view.zoomIn", userShortcuts),
              )}
              zoomOutBinding={getBindingTokens(
                getPrimaryBinding("view.zoomOut", userShortcuts),
              )}
              zoomResetBinding={getBindingTokens(
                getPrimaryBinding("view.zoomReset", userShortcuts),
              )}
            />
          </SettingRow>
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
            description="Tint the row your cursor sits on in the code viewer. (Jumping to a code link always scrolls to and highlights its line, regardless of this toggle.)"
          >
            <Switch
              checked={editorHighlightActiveLine}
              onCheckedChange={(v) => void setEditorHighlightActiveLine(v)}
            />
          </SettingRow>
        </div>
      </div>

      {/* External editor — gives the code viewer's Reveal action a real
          "open in my editor" affordance with line-jump support. */}
      <div className="flex flex-col gap-2">
        <Label>External editor</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Editor command"
            description={
              <>
                Command DevOps Studio runs when you pick &ldquo;Open
                externally&rdquo; on a code-viewer tab. Placeholders:{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  {"{file}"}
                </code>
                ,{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  {"{line}"}
                </code>
                ,{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  {"{endLine}"}
                </code>
                . Leave empty to hide the action. Quotes work for paths
                with spaces.
              </>
            }
          >
            <Input
              value={externalEditorCommand}
              placeholder='e.g. code --goto {file}:{line}'
              onChange={(e) =>
                void setExternalEditorCommand(e.currentTarget.value)
              }
              className="w-[320px] font-mono text-[11.5px]"
            />
          </SettingRow>
          <div className="flex flex-wrap items-center gap-1 px-3 pb-1 text-[10.5px] text-muted-foreground">
            <span className="mr-1 uppercase tracking-wider text-muted-foreground/70">
              presets:
            </span>
            {EXTERNAL_EDITOR_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => void setExternalEditorCommand(p.template)}
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-sm border border-border/50 bg-card px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.08] hover:text-primary",
                  externalEditorCommand === p.template &&
                    "border-primary/40 bg-primary/[0.06] text-primary",
                )}
              >
                {p.label}
              </button>
            ))}
            {externalEditorCommand ? (
              <button
                type="button"
                onClick={() => void setExternalEditorCommand("")}
                className="ml-1 inline-flex h-5 items-center rounded-sm border border-border/50 bg-card px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/[0.06] hover:text-destructive"
              >
                clear
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Source repos</Label>
        <SourceReposPanel />
      </div>
    </div>
  );
}

/** Built-in command-line templates for popular editors. Picking one
 *  populates the field; the user can still customize after.
 *
 *  Visual Studio's CLI (`devenv`) doesn't have a direct "--goto line"
 *  flag — the only way to land on a line from the command line is via
 *  `/command "Edit.GoTo"`. That spawns the goto-line popup in VS;
 *  good enough to position the user without requiring extensions. */
const EXTERNAL_EDITOR_PRESETS: ReadonlyArray<{ label: string; template: string }> = [
  { label: "VS Code", template: "code --goto {file}:{line}" },
  { label: "Cursor", template: "cursor --goto {file}:{line}" },
  { label: "Visual Studio", template: 'devenv /Edit {file} /Command "Edit.GoTo {line}"' },
  { label: "Sublime", template: "subl {file}:{line}" },
  { label: "Zed", template: "zed {file}:{line}" },
  { label: "Vim", template: "vim +{line} {file}" },
  { label: "Neovim", template: "nvim +{line} {file}" },
  { label: "Emacs", template: "emacs +{line} {file}" },
  { label: "IntelliJ", template: "idea --line {line} {file}" },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function UiScaleControl({
  zoomLevel,
  zoomInBinding,
  zoomOutBinding,
  zoomResetBinding,
}: {
  zoomLevel: number;
  zoomInBinding: string[];
  zoomOutBinding: string[];
  zoomResetBinding: string[];
}) {
  const clamp = (n: number) =>
    Math.round(Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, n)) * 100) / 100;
  const onDelta = (delta: number) => {
    const next = clamp(zoomLevel + delta);
    if (next !== zoomLevel) void setZoomLevel(next);
  };
  const onSlider = (vals: number[]) => {
    const v = clamp((vals[0] ?? 100) / 100);
    if (v !== zoomLevel) void setZoomLevel(v);
  };
  const percent = Math.round(zoomLevel * 100);
  const isDefault = Math.abs(zoomLevel - 1) < 0.001;
  return (
    <div className="flex w-[320px] flex-col gap-2">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="h-7 w-7"
              onClick={() => onDelta(-UI_ZOOM_STEP)}
              disabled={zoomLevel <= UI_ZOOM_MIN + 0.001}
              aria-label="Decrease UI scale"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={12} strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="flex items-center gap-1.5 text-[11px]">
            <span>Decrease</span>
            {zoomOutBinding.length > 0 ? (
              <KbdGroup>
                {zoomOutBinding.map((t, i) => (
                  <Kbd key={i}>{t}</Kbd>
                ))}
              </KbdGroup>
            ) : null}
          </TooltipContent>
        </Tooltip>
        <Slider
          className="flex-1"
          value={[percent]}
          min={UI_ZOOM_MIN * 100}
          max={UI_ZOOM_MAX * 100}
          step={UI_ZOOM_STEP * 100}
          onValueChange={onSlider}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="h-7 w-7"
              onClick={() => onDelta(UI_ZOOM_STEP)}
              disabled={zoomLevel >= UI_ZOOM_MAX - 0.001}
              aria-label="Increase UI scale"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="flex items-center gap-1.5 text-[11px]">
            <span>Increase</span>
            {zoomInBinding.length > 0 ? (
              <KbdGroup>
                {zoomInBinding.map((t, i) => (
                  <Kbd key={i}>{t}</Kbd>
                ))}
              </KbdGroup>
            ) : null}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span className="font-mono tabular-nums">{percent}%</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void setZoomLevel(1)}
              disabled={isDefault}
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground",
                isDefault && "cursor-default opacity-40 hover:text-muted-foreground",
              )}
            >
              Reset to 100%
            </button>
          </TooltipTrigger>
          {zoomResetBinding.length > 0 ? (
            <TooltipContent
              side="top"
              className="flex items-center gap-1.5 text-[11px]"
            >
              <span>Reset</span>
              <KbdGroup>
                {zoomResetBinding.map((t, i) => (
                  <Kbd key={i}>{t}</Kbd>
                ))}
              </KbdGroup>
            </TooltipContent>
          ) : null}
        </Tooltip>
      </div>
    </div>
  );
}
