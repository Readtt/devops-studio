import { Input } from "@/components/ui/input";
import { ShellBrandIcon } from "@/modules/terminal/ShellBrandIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
                      <ShellBrandIcon kind={s.kind} size={13} />
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
                Command Quick Prompts use when typing starter prompts. Pick
                from the common CLIs or choose <em>Custom…</em> to type your
                own binary name. Leave empty to paste prompts raw, without a
                command prefix.
              </>
            }
          >
            <AiCliPicker
              value={preferredAiCli}
              onChange={(next) => void setPreferredAiCli(next)}
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

// Curated set of well-known AI CLIs the user can drop into the terminal's
// quick-prompts. `value` is the literal binary name we splice into typed
// prompts — keep it short and exact so shells resolve it via PATH without
// quoting. Anything not in the list lands in the "custom" branch.
const AI_CLI_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "cursor-agent", label: "Cursor" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "aider", label: "Aider" },
] as const;

const CUSTOM_SENTINEL = "__custom__";
const EMPTY_SENTINEL = "__none__";

function AiCliPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const matched = AI_CLI_OPTIONS.find((o) => o.value === trimmed);
  const isEmpty = trimmed.length === 0;
  const isCustom = !isEmpty && !matched;
  const [customMode, setCustomMode] = useState(isCustom);

  // Keep the local "show the typing input" flag in sync if the stored value
  // changes from outside (e.g. another window). Without this, switching to
  // a preset elsewhere would leave the custom input lingering on screen.
  useEffect(() => {
    if (isCustom) setCustomMode(true);
    else if (matched || isEmpty) setCustomMode(false);
  }, [isCustom, matched, isEmpty]);

  const selectValue = isEmpty
    ? EMPTY_SENTINEL
    : customMode
      ? CUSTOM_SENTINEL
      : (matched?.value ?? CUSTOM_SENTINEL);

  return (
    <div className="flex items-center gap-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_SENTINEL) {
            setCustomMode(true);
            // Don't clobber an existing custom value — give the user a chance
            // to keep typing rather than wiping back to empty.
            if (matched || isEmpty) onChange("");
            return;
          }
          if (v === EMPTY_SENTINEL) {
            setCustomMode(false);
            onChange("");
            return;
          }
          setCustomMode(false);
          onChange(v);
        }}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AI_CLI_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {o.value}
                </span>
                <span className="truncate">{o.label}</span>
              </span>
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>
            <span className="italic text-muted-foreground">Custom…</span>
          </SelectItem>
          <SelectItem value={EMPTY_SENTINEL}>
            <span className="italic text-muted-foreground">
              None (paste raw)
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {customMode ? (
        <Input
          value={value}
          placeholder="my-cli"
          className="w-[160px] font-mono"
          onChange={(e) => onChange(e.target.value)}
          autoFocus={isCustom && value.length === 0}
        />
      ) : null}
    </div>
  );
}
