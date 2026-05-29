import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
  type ModelId,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

/** Which AI engine the Generator routes through. See `ai/lib/engine.ts`. */
export type AiEngine = "vercel-ai-sdk" | "claude-agent-sdk";
export type ClaudeAuthMode = "max-oauth" | "api-key";

/**
 * Editor theme families. Each id resolves to a dark or light variant based on
 * the app's resolved theme. Themes that only have one upstream variant (atom-
 * one is dark-only, etc.) fall back to a sensible counterpart so picking
 * "Atom One" never strands you on an unreadable color combination when the
 * OS / app theme flips.
 *
 * Legacy ids ("devops-studio-dark", "github-dark", "github-light", "xcode-dark",
 * "xcode-light") are kept in EDITOR_THEME_LEGACY_MAP so old preference files
 * migrate transparently the first time they load.
 */
export const EDITOR_THEMES = [
  "devops-studio",
  "github",
  "xcode",
  "atom-one",
  "aura",
  "copilot",
  "nord",
  "tokyo-night",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  "devops-studio": "DevOps Studio",
  github: "GitHub",
  xcode: "Xcode",
  "atom-one": "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
};

/** Map the legacy variant-specific ids onto the new family ids so the user
 *  doesn't have to re-pick their theme after the upgrade. */
const EDITOR_THEME_LEGACY_MAP: Record<string, EditorThemeId> = {
  "devops-studio-dark": "devops-studio",
  "devops-studio-light": "devops-studio",
  "github-dark": "github",
  "github-light": "github",
  "xcode-dark": "xcode",
  "xcode-light": "xcode",
  atomone: "atom-one",
};

function normalizeEditorTheme(raw: unknown): EditorThemeId {
  if (typeof raw !== "string") return DEFAULT_PREFERENCES.editorTheme;
  if ((EDITOR_THEMES as readonly string[]).includes(raw)) {
    return raw as EditorThemeId;
  }
  return EDITOR_THEME_LEGACY_MAP[raw] ?? DEFAULT_PREFERENCES.editorTheme;
}

/** A best-practices / coding-standards file the user registers in Settings.
 *  Stored as a PATH REFERENCE (not a copy) so a shared network/UNC file stays
 *  the single source of truth — the loader reads it live at AI-run time. */
export type BestPracticeFile = {
  /** Absolute path (local or UNC). Read fresh on each AI run. */
  path: string;
  /** Display label shown in Settings + used as the context-block heading. */
  label: string;
  /** When false the file is kept in the list but skipped during injection. */
  enabled: boolean;
};

export type Preferences = {
  theme: ThemePref;
  defaultModelId: ModelId;
  editorTheme: EditorThemeId;
  customInstructions: string;
  autostart: boolean;
  restoreWindowState: boolean;
  autocompleteEnabled: boolean;
  autocompleteProvider: AutocompleteProviderId;
  autocompleteModelId: string;
  lmstudioBaseURL: string;
  lmstudioModelId: string;
  mlxBaseURL: string;
  mlxModelId: string;
  ollamaBaseURL: string;
  ollamaModelId: string;
  openaiCompatibleBaseURL: string;
  openaiCompatibleModelId: string;
  openaiCompatibleContextLimit: number;
  favoriteModelIds: string[];
  recentModelIds: string[];
  vimMode: boolean;
  showHidden: boolean;
  terminalWebglEnabled: boolean;
  terminalFontFamily: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  /** Detected-shell id chosen by the user in Settings → Terminal. We persist
   *  id + path together: the id survives a pwsh upgrade that moves the
   *  binary, the path is what pty_spawn actually executes when the user
   *  uses the same machine that did the picking. */
  defaultShellId: string | null;
  defaultShellPath: string | null;
  /** Command prefix Quick Prompts use when typing starter prompts into the
   *  terminal. Examples: `claude`, `codex`, `aider`. The chip code substitutes
   *  this into a template like `{cli} "Review my diff vs main"`. Empty string
   *  ⇒ chips paste the raw prompt without a CLI prefix. */
  preferredAiCli: string;
  zoomLevel: number;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  /** Phase 5: which engine to use for AI generation. */
  aiEngine: AiEngine;
  /** Phase 5: how to authenticate to Anthropic when `aiEngine === "claude-agent-sdk"`. */
  claudeAuthMode: ClaudeAuthMode;
  /** Absolute path to the user's source directory. Code-link rows in the Bug
   *  pane resolve relative paths against this when opening the code viewer. */
  sourceRoot: string | null;
  // Code editor preferences — applied to the read-only CodeMirror pane.
  /** Editor font size in px. */
  editorFontSize: number;
  /** Show line numbers in the editor gutter. */
  editorLineNumbers: boolean;
  /** Soft-wrap long lines instead of horizontal scrolling. */
  editorWordWrap: boolean;
  /** Highlight the currently-active line. */
  editorHighlightActiveLine: boolean;
  /** Width of a tab character in spaces. */
  editorTabSize: number;
  /** Command template used by "Open in external editor" on code-viewer
   *  tabs and bug code-link rows. Placeholders: `{file}`, `{line}`,
   *  `{endLine}`. Empty string disables the action (Reveal still works).
   *  Examples: `"code --goto {file}:{line}"`, `"subl {file}:{line}"`. */
  externalEditorCommand: string;
  /** Best-practices / coding-standards files injected as context into EVERY
   *  AI feature. Path references read live at run time (network/UNC ok). */
  bestPracticeFiles: BestPracticeFile[];
};

const STORE_PATH = "devops-studio-settings.json";
const KEY_THEME = "theme";
const KEY_DEFAULT_MODEL = "defaultModelId";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_PROVIDER = "autocompleteProvider";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModelId";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_LMSTUDIO_MODEL_ID = "lmstudioModelId";
const KEY_MLX_BASE_URL = "mlxBaseURL";
const KEY_MLX_MODEL_ID = "mlxModelId";
const KEY_OLLAMA_BASE_URL = "ollamaBaseURL";
const KEY_OLLAMA_MODEL_ID = "ollamaModelId";
const KEY_OPENAI_COMPAT_BASE_URL = "openaiCompatibleBaseURL";
const KEY_OPENAI_COMPAT_MODEL_ID = "openaiCompatibleModelId";
const KEY_OPENAI_COMPAT_CONTEXT_LIMIT = "openaiCompatibleContextLimit";
const KEY_FAVORITE_MODELS = "favoriteModelIds";
const KEY_RECENT_MODELS = "recentModelIds";
const KEY_VIM_MODE = "vimMode";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_DEFAULT_SHELL_ID = "defaultShellId";
const KEY_DEFAULT_SHELL_PATH = "defaultShellPath";
const KEY_PREFERRED_AI_CLI = "preferredAiCli";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_SHORTCUTS = "shortcuts";
const KEY_AI_ENGINE = "aiEngine";
const KEY_CLAUDE_AUTH_MODE = "claudeAuthMode";
const KEY_SOURCE_ROOT = "sourceRoot";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_EDITOR_LINE_NUMBERS = "editorLineNumbers";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_EDITOR_HIGHLIGHT_ACTIVE_LINE = "editorHighlightActiveLine";
const KEY_EDITOR_TAB_SIZE = "editorTabSize";
const KEY_EXTERNAL_EDITOR_COMMAND = "externalEditorCommand";
const KEY_BEST_PRACTICE_FILES = "bestPracticeFiles";

export const EDITOR_FONT_SIZE_DEFAULT = 12.5;
export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 22;
export const EDITOR_FONT_SIZES = [10, 11, 12, 12.5, 13, 14, 15, 16, 18, 20, 22] as const;
export const EDITOR_TAB_SIZES = [2, 4, 8] as const;

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const TERMINAL_SCROLLBACK_DEFAULT = 2000;
export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  defaultModelId: DEFAULT_MODEL_ID,
  editorTheme: "devops-studio",
  customInstructions: "",
  autostart: false,
  restoreWindowState: true,
  autocompleteEnabled: false,
  autocompleteProvider: "cerebras",
  autocompleteModelId: DEFAULT_AUTOCOMPLETE_MODEL.cerebras ?? "",
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  lmstudioModelId: "",
  mlxBaseURL: MLX_DEFAULT_BASE_URL,
  mlxModelId: "",
  ollamaBaseURL: OLLAMA_DEFAULT_BASE_URL,
  ollamaModelId: "",
  openaiCompatibleBaseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  openaiCompatibleModelId: "",
  openaiCompatibleContextLimit: 128_000,
  favoriteModelIds: [],
  recentModelIds: [],
  vimMode: false,
  showHidden: false,
  terminalWebglEnabled: true,
  terminalFontFamily: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  defaultShellId: null,
  defaultShellPath: null,
  preferredAiCli: "claude",
  zoomLevel: 1.0,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  aiEngine: "vercel-ai-sdk",
  claudeAuthMode: "api-key",
  sourceRoot: null,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  editorLineNumbers: true,
  editorWordWrap: false,
  editorHighlightActiveLine: true,
  editorTabSize: 2,
  externalEditorCommand: "",
  bestPracticeFiles: [],
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "devops-studio://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    defaultModelId:
      get<ModelId>(KEY_DEFAULT_MODEL) ?? DEFAULT_PREFERENCES.defaultModelId,
    editorTheme: normalizeEditorTheme(get<unknown>(KEY_EDITOR_THEME)),
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ??
      DEFAULT_PREFERENCES.customInstructions,
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    autocompleteEnabled:
      get<boolean>(KEY_AUTOCOMPLETE_ENABLED) ??
      DEFAULT_PREFERENCES.autocompleteEnabled,
    autocompleteProvider:
      get<AutocompleteProviderId>(KEY_AUTOCOMPLETE_PROVIDER) ??
      DEFAULT_PREFERENCES.autocompleteProvider,
    autocompleteModelId:
      get<string>(KEY_AUTOCOMPLETE_MODEL) ??
      DEFAULT_PREFERENCES.autocompleteModelId,
    lmstudioBaseURL:
      get<string>(KEY_LMSTUDIO_BASE_URL) ?? DEFAULT_PREFERENCES.lmstudioBaseURL,
    lmstudioModelId:
      get<string>(KEY_LMSTUDIO_MODEL_ID) ?? DEFAULT_PREFERENCES.lmstudioModelId,
    mlxBaseURL:
      get<string>(KEY_MLX_BASE_URL) ?? DEFAULT_PREFERENCES.mlxBaseURL,
    mlxModelId:
      get<string>(KEY_MLX_MODEL_ID) ?? DEFAULT_PREFERENCES.mlxModelId,
    ollamaBaseURL:
      get<string>(KEY_OLLAMA_BASE_URL) ?? DEFAULT_PREFERENCES.ollamaBaseURL,
    ollamaModelId:
      get<string>(KEY_OLLAMA_MODEL_ID) ?? DEFAULT_PREFERENCES.ollamaModelId,
    openaiCompatibleBaseURL:
      get<string>(KEY_OPENAI_COMPAT_BASE_URL) ??
      DEFAULT_PREFERENCES.openaiCompatibleBaseURL,
    openaiCompatibleModelId:
      get<string>(KEY_OPENAI_COMPAT_MODEL_ID) ??
      DEFAULT_PREFERENCES.openaiCompatibleModelId,
    openaiCompatibleContextLimit:
      get<number>(KEY_OPENAI_COMPAT_CONTEXT_LIMIT) ??
      DEFAULT_PREFERENCES.openaiCompatibleContextLimit,
    favoriteModelIds:
      get<string[]>(KEY_FAVORITE_MODELS) ??
      DEFAULT_PREFERENCES.favoriteModelIds,
    recentModelIds:
      get<string[]>(KEY_RECENT_MODELS) ?? DEFAULT_PREFERENCES.recentModelIds,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ??
      DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    defaultShellId:
      get<string | null>(KEY_DEFAULT_SHELL_ID) ??
      DEFAULT_PREFERENCES.defaultShellId,
    defaultShellPath:
      get<string | null>(KEY_DEFAULT_SHELL_PATH) ??
      DEFAULT_PREFERENCES.defaultShellPath,
    preferredAiCli:
      get<string>(KEY_PREFERRED_AI_CLI) ?? DEFAULT_PREFERENCES.preferredAiCli,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    aiEngine: get<AiEngine>(KEY_AI_ENGINE) ?? DEFAULT_PREFERENCES.aiEngine,
    claudeAuthMode:
      get<ClaudeAuthMode>(KEY_CLAUDE_AUTH_MODE) ??
      DEFAULT_PREFERENCES.claudeAuthMode,
    sourceRoot:
      get<string | null>(KEY_SOURCE_ROOT) ?? DEFAULT_PREFERENCES.sourceRoot,
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    editorLineNumbers:
      get<boolean>(KEY_EDITOR_LINE_NUMBERS) ??
      DEFAULT_PREFERENCES.editorLineNumbers,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    editorHighlightActiveLine:
      get<boolean>(KEY_EDITOR_HIGHLIGHT_ACTIVE_LINE) ??
      DEFAULT_PREFERENCES.editorHighlightActiveLine,
    editorTabSize:
      get<number>(KEY_EDITOR_TAB_SIZE) ?? DEFAULT_PREFERENCES.editorTabSize,
    externalEditorCommand:
      get<string>(KEY_EXTERNAL_EDITOR_COMMAND) ??
      DEFAULT_PREFERENCES.externalEditorCommand,
    bestPracticeFiles:
      get<BestPracticeFile[]>(KEY_BEST_PRACTICE_FILES) ??
      DEFAULT_PREFERENCES.bestPracticeFiles,
  };
}

export async function setAiEngine(value: AiEngine): Promise<void> {
  await writePref(KEY_AI_ENGINE, value);
}

export async function setClaudeAuthMode(value: ClaudeAuthMode): Promise<void> {
  await writePref(KEY_CLAUDE_AUTH_MODE, value);
}

export async function setSourceRoot(value: string | null): Promise<void> {
  await writePref(KEY_SOURCE_ROOT, value);
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setDefaultModel(value: ModelId): Promise<void> {
  await writePref(KEY_DEFAULT_MODEL, value);
}

export async function setEditorTheme(value: EditorThemeId): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setAutocompleteEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_ENABLED, value);
}

export async function setAutocompleteProvider(
  value: AutocompleteProviderId,
): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_PROVIDER, value);
}

export async function setAutocompleteModelId(value: string): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_MODEL, value);
}

export async function setLmstudioBaseURL(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_BASE_URL, value);
}

export async function setLmstudioModelId(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_MODEL_ID, value);
}

export async function setMlxBaseURL(value: string): Promise<void> {
  await writePref(KEY_MLX_BASE_URL, value);
}

export async function setMlxModelId(value: string): Promise<void> {
  await writePref(KEY_MLX_MODEL_ID, value);
}

export async function setOllamaBaseURL(value: string): Promise<void> {
  await writePref(KEY_OLLAMA_BASE_URL, value);
}

export async function setOllamaModelId(value: string): Promise<void> {
  await writePref(KEY_OLLAMA_MODEL_ID, value);
}

export async function setOpenaiCompatibleBaseURL(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_BASE_URL, value);
}

export async function setOpenaiCompatibleModelId(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_MODEL_ID, value);
}

export async function setOpenaiCompatibleContextLimit(
  value: number,
): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(1_000, Math.round(value))
    : DEFAULT_PREFERENCES.openaiCompatibleContextLimit;
  await writePref(KEY_OPENAI_COMPAT_CONTEXT_LIMIT, clamped);
}

export async function setFavoriteModelIds(value: string[]): Promise<void> {
  await writePref(KEY_FAVORITE_MODELS, value);
}

export async function setRecentModelIds(value: string[]): Promise<void> {
  await writePref(KEY_RECENT_MODELS, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value) ? Math.max(-10, Math.min(10, Math.round(value))) : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  // Round to the nearest 0.5 so the slider lands on consistent steps.
  const rounded = Math.round(value * 2) / 2;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, rounded),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}
export async function setEditorLineNumbers(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_LINE_NUMBERS, value);
}
export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}
export async function setEditorHighlightActiveLine(
  value: boolean,
): Promise<void> {
  await writePref(KEY_EDITOR_HIGHLIGHT_ACTIVE_LINE, value);
}
export async function setExternalEditorCommand(value: string): Promise<void> {
  await writePref(KEY_EXTERNAL_EDITOR_COMMAND, value.trim());
}

export async function setBestPracticeFiles(
  value: BestPracticeFile[],
): Promise<void> {
  await writePref(KEY_BEST_PRACTICE_FILES, value);
}

export async function setEditorTabSize(value: number): Promise<void> {
  const clamped = EDITOR_TAB_SIZES.includes(value as (typeof EDITOR_TAB_SIZES)[number])
    ? value
    : DEFAULT_PREFERENCES.editorTabSize;
  await writePref(KEY_EDITOR_TAB_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setDefaultShell(
  id: string | null,
  path: string | null,
): Promise<void> {
  // Always set both atomically — the id is meaningless without a path, and
  // a stale path-only state would have pty_spawn falling back to the
  // platform default while the UI shows a phantom selection.
  await writePref(KEY_DEFAULT_SHELL_ID, id);
  await writePref(KEY_DEFAULT_SHELL_PATH, path);
}

export async function setPreferredAiCli(value: string): Promise<void> {
  await writePref(KEY_PREFERRED_AI_CLI, value.trim());
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await store.set(KEY_SHORTCUTS, value);
  await store.save();
}

export async function resetShortcuts(): Promise<void> {
  await store.set(KEY_SHORTCUTS, DEFAULT_PREFERENCES.shortcuts);
  await store.save();
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_DEFAULT_MODEL]: "defaultModelId",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_CUSTOM_INSTRUCTIONS]: "customInstructions",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_AUTOCOMPLETE_ENABLED]: "autocompleteEnabled",
    [KEY_AUTOCOMPLETE_PROVIDER]: "autocompleteProvider",
    [KEY_AUTOCOMPLETE_MODEL]: "autocompleteModelId",
    [KEY_LMSTUDIO_BASE_URL]: "lmstudioBaseURL",
    [KEY_LMSTUDIO_MODEL_ID]: "lmstudioModelId",
    [KEY_MLX_BASE_URL]: "mlxBaseURL",
    [KEY_MLX_MODEL_ID]: "mlxModelId",
    [KEY_OLLAMA_BASE_URL]: "ollamaBaseURL",
    [KEY_OLLAMA_MODEL_ID]: "ollamaModelId",
    [KEY_OPENAI_COMPAT_BASE_URL]: "openaiCompatibleBaseURL",
    [KEY_OPENAI_COMPAT_MODEL_ID]: "openaiCompatibleModelId",
    [KEY_OPENAI_COMPAT_CONTEXT_LIMIT]: "openaiCompatibleContextLimit",
    [KEY_FAVORITE_MODELS]: "favoriteModelIds",
    [KEY_RECENT_MODELS]: "recentModelIds",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_DEFAULT_SHELL_ID]: "defaultShellId",
    [KEY_DEFAULT_SHELL_PATH]: "defaultShellPath",
    [KEY_PREFERRED_AI_CLI]: "preferredAiCli",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_AI_ENGINE]: "aiEngine",
    [KEY_CLAUDE_AUTH_MODE]: "claudeAuthMode",
    [KEY_SOURCE_ROOT]: "sourceRoot",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_EDITOR_LINE_NUMBERS]: "editorLineNumbers",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_EDITOR_HIGHLIGHT_ACTIVE_LINE]: "editorHighlightActiveLine",
    [KEY_EDITOR_TAB_SIZE]: "editorTabSize",
    [KEY_EXTERNAL_EDITOR_COMMAND]: "externalEditorCommand",
    [KEY_BEST_PRACTICE_FILES]: "bestPracticeFiles",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

// API key changes are stored in OS keychain (not the prefs store),
// so we broadcast via a Tauri event for cross-window listeners.
const KEYS_CHANGED_EVENT = "devops-studio://ai-keys-changed";

export async function emitKeysChanged(): Promise<void> {
  await emit(KEYS_CHANGED_EVENT);
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(KEYS_CHANGED_EVENT, () => cb());
}

// Generation busy state — broadcast by the main window whenever any
// generator tab transitions between idle / running / refining / in-draft.
// The settings window's Models page subscribes so it can lock the default
// model picker mid-flight (matches the status-bar picker's local behavior).
const GEN_BUSY_EVENT = "devops-studio://generation-busy";
export type GenerationBusyReason =
  | "idle"
  | "running"
  | "refining"
  | "in-draft";
export type GenerationBusyState = {
  busy: boolean;
  /** Strongest reason across all open generator tabs. The picker uses this
   *  to render an explanatory tooltip ("a draft is open" vs "a run is in
   *  progress"). */
  reason: GenerationBusyReason;
};

export async function emitGenerationBusy(state: GenerationBusyState): Promise<void> {
  await emit(GEN_BUSY_EVENT, state);
}

export async function onGenerationBusy(
  cb: (state: GenerationBusyState) => void,
): Promise<UnlistenFn> {
  return listen<GenerationBusyState>(GEN_BUSY_EVENT, (e) => cb(e.payload));
}
