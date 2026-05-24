import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setDefaultShell,
  setPreferredAiCli,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type ShellCandidate = {
  id: string;
  label: string;
  path: string;
  /** Coarse classifier — `pwsh` / `cmd` / `bash` / `zsh` / `git-bash` / etc.
   *  Used here only to colour the indicator dot; the actual spawn passes
   *  the resolved `path` to the Rust side. */
  kind: string;
};

// Letter-spacing presets keep the slider feel without committing to a real
// Slider component — three steps cover "tight" / "default" / "airy".
const LETTER_SPACING_OPTIONS = [
  { value: 0, label: "Default" },
  { value: 1, label: "Looser (+1)" },
  { value: 2, label: "Roomy (+2)" },
] as const;

// Brand-ish colours for the indicator dot next to each shell in the picker.
// Not the brand's official hex — these are perceptual swatches that read on
// both light and dark surfaces.
const SHELL_KIND_DOT: Record<string, string> = {
  pwsh: "bg-sky-500",
  powershell: "bg-sky-700",
  cmd: "bg-zinc-500",
  bash: "bg-emerald-500",
  zsh: "bg-violet-500",
  "git-bash": "bg-amber-500",
  fish: "bg-orange-500",
  sh: "bg-zinc-400",
  other: "bg-zinc-400",
};

export function TerminalSection() {
  const defaultShellId = usePreferencesStore((s) => s.defaultShellId);
  const defaultShellPath = usePreferencesStore((s) => s.defaultShellPath);
  const preferredAiCli = usePreferencesStore((s) => s.preferredAiCli);
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const fontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const letterSpacing = usePreferencesStore((s) => s.terminalLetterSpacing);
  const scrollback = usePreferencesStore((s) => s.terminalScrollback);
  const webglEnabled = usePreferencesStore((s) => s.terminalWebglEnabled);

  const [shells, setShells] = useState<ShellCandidate[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<ShellCandidate[]>("detect_shells")
      .then((list) => {
        if (!alive) return;
        setShells(list);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDetectError(typeof e === "string" ? e : "Failed to detect shells");
        setShells([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Picker value: prefer the saved id; if the saved id is no longer in the
  // detected list (binary moved, OS reinstalled), fall back to whichever
  // detected shell shares the saved path. This avoids the dropdown showing
  // empty for users whose pwsh upgrade renamed `7-preview` → `7`.
  const selectedShellValue = (() => {
    if (!shells || shells.length === 0) return undefined;
    if (defaultShellId && shells.some((s) => s.id === defaultShellId)) {
      return defaultShellId;
    }
    if (defaultShellPath) {
      const match = shells.find((s) => s.path === defaultShellPath);
      if (match) return match.id;
    }
    return undefined;
  })();

  const handleShellChange = (id: string) => {
    const picked = shells?.find((s) => s.id === id);
    if (!picked) return;
    void setDefaultShell(picked.id, picked.path);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Terminal"
        description="Embedded terminal tabs. Open via the sidebar, command palette, or Ctrl+Shift+`."
        icon={
          <HugeiconsIcon icon={CommandLineIcon} size={16} strokeWidth={1.5} />
        }
      />

      <div className="flex flex-col gap-2">
        <Label>Shell</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Default shell"
            description={
              shells === null
                ? "Detecting installed shells…"
                : detectError
                  ? detectError
                  : shells.length === 0
                    ? "No shells detected. The terminal will fall back to the platform default."
                    : "Picks the shell that new terminal tabs launch."
            }
          >
            <Select
              value={selectedShellValue ?? ""}
              onValueChange={handleShellChange}
              disabled={!shells || shells.length === 0}
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder={shells === null ? "…" : "Auto"} />
              </SelectTrigger>
              <SelectContent>
                {(shells ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          SHELL_KIND_DOT[s.kind] ?? SHELL_KIND_DOT.other,
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{s.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            title="Preferred AI CLI"
            description={
              <>
                Command Quick Prompts use when typing starter prompts. Common
                values:{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  claude
                </code>
                ,{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  codex
                </code>
                ,{" "}
                <code className="rounded-sm bg-foreground/[0.06] px-1 font-mono text-[10.5px]">
                  aider
                </code>
                . Leave empty to paste prompts without a command prefix.
              </>
            }
          >
            <Input
              value={preferredAiCli}
              placeholder="claude"
              className="w-[180px] font-mono"
              onChange={(e) => void setPreferredAiCli(e.target.value)}
            />
          </SettingRow>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Font size"
            description="Terminal text size in pixels."
          >
            <Select
              value={String(fontSize)}
              onValueChange={(v) => void setTerminalFontSize(Number(v))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_FONT_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            title="Font family"
            description="Override the default monospace stack. Leave empty to use JetBrains Mono Variable."
          >
            <Input
              value={fontFamily}
              placeholder="JetBrains Mono Variable"
              className="w-[240px] font-mono"
              onChange={(e) => void setTerminalFontFamily(e.target.value)}
            />
          </SettingRow>

          <SettingRow
            title="Letter spacing"
            description="Loosen up the glyph track for legibility on dense terminal output."
          >
            <Select
              value={String(letterSpacing)}
              onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LETTER_SPACING_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            title="Scrollback"
            description="How many lines of past output the terminal remembers. Higher values use more memory per tab."
          >
            <Select
              value={String(scrollback)}
              onValueChange={(v) => void setTerminalScrollback(Number(v))}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_SCROLLBACK_PRESETS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n.toLocaleString()} lines
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            title="WebGL renderer"
            description="Render the terminal on a WebGL canvas. Smoother scrolling and faster paint at high columns, but falls back to canvas automatically on machines without WebGL support."
          >
            <Switch
              checked={webglEnabled}
              onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

// Local helper — matches GeneralSection's Label so terminal settings inherit
// the same visual grouping above each block of SettingRows.
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
