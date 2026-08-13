import {
  DEFAULT_MODEL_ID,
  isKnownModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  type ModelId,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { consumeLaunchDir } from "@/lib/launchDir";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

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

/** One source repository in the workspace registry.
 *
 *  Deliberately carries no role, kind, tier, or relationship field: the app has
 *  to work for any combination of repos and must encode nothing about how they
 *  relate. A repo is a name and a path. List order is display order — never
 *  dependency order — and no position is semantically special. */
export type WorkspaceRepo = {
  /** Stable id. Survives rename and path move. Generated on add. */
  id: string;
  /** Display name AND the namespace the AI addresses files through, so it must
   *  be unique across the list and slug-safe (no path separators). Defaults to
   *  the folder basename. */
  name: string;
  /** Absolute path to the repo root. */
  root: string;
  /** ADO binding used when building published code links. null until resolved. */
  ado: { repoId: string; repoName: string; project: string } | null;
};

export type Preferences = {
  theme: ThemePref;
  defaultModelId: ModelId;
  editorTheme: EditorThemeId;
  customInstructions: string;
  autostart: boolean;
  restoreWindowState: boolean;
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
  /** Source repositories the app reads code from. Flat list — no active repo,
   *  no named profiles. Every code-reading surface sees all of them. */
  repos: WorkspaceRepo[];
  /** Master switch: may the AI read the source directory (read-only
   *  Read/Glob/Grep) to ground its answers? Applies to every surface —
   *  Generator, Suite Chat, Code Review, Confidence. Default on. */
  codeSearchEnabled: boolean;
  /** Warn before firing an AI run whose estimated context is large for the
   *  selected model (cost + quality + mid-run-failure risk). Governs the amber
   *  warning banner and the overflow confirm across every input surface; the
   *  passive meter always shows. Default on. */
  contextGuardEnabled: boolean;
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
const KEY_REPOS = "repos";
// Read exactly once, by the repo-registry migration in loadPreferences. Never
// written again — the registry is the persisted source of truth.
const KEY_SOURCE_ROOT = "sourceRoot";
const KEY_CODE_SEARCH_ENABLED = "codeSearchEnabled";
const KEY_CONTEXT_GUARD_ENABLED = "contextGuardEnabled";
// Removed when the app consolidated on a single BYOK engine. Kept here only so
// loadPreferences can scrub them from older settings files.
const KEY_LEGACY_AI_ENGINE = "aiEngine";
const KEY_LEGACY_CLAUDE_AUTH_MODE = "claudeAuthMode";
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
  // Must be a real array, not left undefined: preferences.ts spreads these as
  // the zustand initial state, so consumers map over it before hydration.
  repos: [],
  codeSearchEnabled: true,
  contextGuardEnabled: true,
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

function sanitizeModelId(id: string | undefined, fallback: ModelId): ModelId {
  return id && isKnownModelId(id) ? id : fallback;
}

/** Mint a repo id. Same shape as newAttachmentId — crypto.randomUUID exists in
 *  every context Tauri gives us, with a timestamp fallback for the rare one
 *  where it doesn't. */
function newRepoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `repo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Last path segment of a repo root, for both separators. */
export function repoBasename(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** Compare two roots as the OS would: separator- and case-insensitive, so the
 *  same folder can't be registered twice under two spellings. */
function rootKey(root: string): string {
  return root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/** Same folder, either spelling. Anything matching a root against the registry
 *  must use this — a path that round-trips through an event payload or a Rust
 *  command can come back with the other separator. */
export function sameRoot(a: string, b: string): boolean {
  return rootKey(a) === rootKey(b);
}

/** The name doubles as the namespace the AI addresses files through, so path
 *  separators must not survive it. Everything else is the user's business. */
export function sanitizeRepoName(raw: string): string {
  return raw.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim();
}

/** Resolve `desired` to a name no one else in `taken` is using, suffixing -2,
 *  -3, … Comparison is case-insensitive because repo-path matching is. */
export function uniqueRepoName(desired: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = sanitizeRepoName(desired) || "repo";
  if (!used.has(base.toLowerCase())) return base;
  // Bounded: with N names taken, one of N+1 candidates is always free.
  for (let i = 2; i <= used.size + 2; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${newRepoId()}`;
}

/** Inline validation for a name the user typed, against the names of the OTHER
 *  repos. Returns null when it's usable, else the message to show under it.
 *
 *  Lives next to `sanitizeRepoName` / `uniqueRepoName` so the UX can't drift
 *  from the backstop: those two silently rewrite a bad name (`repo` → `repo-2`),
 *  which is right for a malformed settings file and wrong for someone typing. */
export function validateRepoName(
  raw: string,
  taken: Iterable<string>,
): string | null {
  const name = raw.trim();
  if (!name) return "Name can't be empty.";
  if (/[\\/]/.test(raw)) return "Name can't contain / or \\.";
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  if (used.has(name.toLowerCase())) return "Another repo already uses that name.";
  return null;
}

function normalizeAdo(raw: unknown): WorkspaceRepo["ado"] {
  if (!raw || typeof raw !== "object") return null;
  const { repoId, repoName, project } = raw as Record<string, unknown>;
  if (
    typeof repoId !== "string" ||
    typeof repoName !== "string" ||
    typeof project !== "string"
  ) {
    return null;
  }
  return { repoId, repoName, project };
}

/** Coerce anything claiming to be a repo list into a well-formed one: drop
 *  entries with no root, drop repeats of a root, and force names unique and
 *  slug-safe.
 *
 *  This runs on load AND on every write because nothing downstream validates:
 *  preferences.ts blind-sets whatever a change event carries (`set({[key]:
 *  value})`), so a malformed payload from any window would otherwise land in
 *  the store verbatim. Normalising — rather than rejecting — means whatever is
 *  in the store is always usable; the Settings UI validates first and is where
 *  the user-facing error lives. */
export function normalizeRepos(raw: unknown): WorkspaceRepo[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceRepo[] = [];
  const roots = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, root, ado } = entry as Record<string, unknown>;
    if (typeof root !== "string" || !root.trim()) continue;
    const key = rootKey(root);
    if (roots.has(key)) continue;
    roots.add(key);
    out.push({
      id: typeof id === "string" && id ? id : newRepoId(),
      name: uniqueRepoName(
        (typeof name === "string" && name.trim()) || repoBasename(root),
        out.map((r) => r.name),
      ),
      root: root.trim(),
      ado: normalizeAdo(ado),
    });
  }
  return out;
}

/** Build a registry entry for `root`, named so it doesn't collide with `taken`. */
export function createRepo(root: string, taken: Iterable<string> = []): WorkspaceRepo {
  return {
    id: newRepoId(),
    name: uniqueRepoName(repoBasename(root), taken),
    root: root.trim(),
    ado: null,
  };
}

/** The single root every pre-registry surface reads.
 *
 *  `repos[0]` is a default, not a designation — it carries no meaning beyond
 *  "some default was needed". Nothing may branch on a repo's position. */
export function primaryRepoRoot(repos: WorkspaceRepo[]): string | null {
  return repos[0]?.root ?? null;
}

/** Every registry write goes through here.
 *
 *  Routes through writePref so the cross-window event fires — the Settings
 *  window is a separate webview and never sees a write that skips it. */
async function writeRepos(repos: WorkspaceRepo[]): Promise<WorkspaceRepo[]> {
  const next = normalizeRepos(repos);
  await writePref(KEY_REPOS, next);
  return next;
}

/** The registry as persisted, which is authoritative across windows — the
 *  plugin store lives in the Rust process, so this sees another window's
 *  writes. Read-modify-write helpers below start here, never from a snapshot. */
async function readRepos(): Promise<WorkspaceRepo[]> {
  return normalizeRepos(await store.get<unknown>(KEY_REPOS));
}

/** Resolve the registry at boot, seeding it from the pre-registry single root
 *  the first time. A folder launched via the "Open in DevOps Studio" shell verb
 *  registers and moves to the front, which is what it did when there was only
 *  one root to take over. */
async function loadRepos(
  get: <T>(k: string) => T | undefined,
): Promise<WorkspaceRepo[]> {
  const stored = normalizeRepos(get<unknown>(KEY_REPOS));
  // The one and only read of the legacy key.
  const legacy = stored.length
    ? null
    : (get<string | null>(KEY_SOURCE_ROOT) ?? null);
  // Drains on first read, so consume it exactly once.
  const launched = consumeLaunchDir() ?? null;

  let next = legacy ? [createRepo(legacy)] : stored;
  if (launched) {
    const key = rootKey(launched);
    const already = next.find((r) => rootKey(r.root) === key);
    next = already
      ? [already, ...next.filter((r) => r !== already)]
      : [createRepo(launched, next.map((r) => r.name)), ...next];
  }

  const unchanged =
    next.length === stored.length && next.every((r, i) => r === stored[i]);
  if (unchanged) return stored;
  // Persisted here rather than on next write: a seed that never lands is
  // re-minted with a fresh id on every launch.
  await writeRepos(next).catch(() => undefined);
  return next;
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  // Scrub keys from the removed Claude-engine era so they don't linger in the
  // settings file. Best-effort; never blocks the load.
  if (map.has(KEY_LEGACY_AI_ENGINE) || map.has(KEY_LEGACY_CLAUDE_AUTH_MODE)) {
    void store
      .delete(KEY_LEGACY_AI_ENGINE)
      .then(() => store.delete(KEY_LEGACY_CLAUDE_AUTH_MODE))
      .then(() => store.save())
      .catch(() => undefined);
  }
  const repos = await loadRepos(get);
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    // A retired model id persisted from an older build would crash the picker
    // and runner (both call the throwing `getModel`) — fall back to the default.
    defaultModelId: sanitizeModelId(
      get<string>(KEY_DEFAULT_MODEL),
      DEFAULT_PREFERENCES.defaultModelId,
    ),
    editorTheme: normalizeEditorTheme(get<unknown>(KEY_EDITOR_THEME)),
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ??
      DEFAULT_PREFERENCES.customInstructions,
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
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
    // Drop any retired ids so they don't linger in the picker's Recent/Favorites.
    favoriteModelIds: (
      get<string[]>(KEY_FAVORITE_MODELS) ??
      DEFAULT_PREFERENCES.favoriteModelIds
    ).filter(isKnownModelId),
    recentModelIds: (
      get<string[]>(KEY_RECENT_MODELS) ?? DEFAULT_PREFERENCES.recentModelIds
    ).filter(isKnownModelId),
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
    repos,
    codeSearchEnabled:
      get<boolean>(KEY_CODE_SEARCH_ENABLED) ??
      DEFAULT_PREFERENCES.codeSearchEnabled,
    contextGuardEnabled:
      get<boolean>(KEY_CONTEXT_GUARD_ENABLED) ??
      DEFAULT_PREFERENCES.contextGuardEnabled,
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

/** Replace the registry wholesale. Names are forced unique and slug-safe on the
 *  way in; the Settings UI validates first, this is the backstop. */
export async function setRepos(value: WorkspaceRepo[]): Promise<void> {
  await writeRepos(value);
}

/** Register `root`, or return the entry already covering it. Idempotent, so
 *  adding the same folder twice can't produce two repos pointing at it. */
export async function addRepo(
  root: string,
  name?: string,
): Promise<WorkspaceRepo> {
  const current = await readRepos();
  const key = rootKey(root);
  const existing = current.find((r) => rootKey(r.root) === key);
  if (existing) return existing;
  const taken = current.map((r) => r.name);
  const repo = createRepo(root, taken);
  if (name) repo.name = uniqueRepoName(name, taken);
  await writeRepos([...current, repo]);
  return repo;
}

/** Drop a repo from the registry. Nothing on disk is touched. */
export async function removeRepo(id: string): Promise<void> {
  const current = await readRepos();
  await writeRepos(current.filter((r) => r.id !== id));
}

export async function renameRepo(id: string, name: string): Promise<void> {
  const current = await readRepos();
  await writeRepos(
    current.map((r) =>
      r.id === id
        ? {
            ...r,
            name: uniqueRepoName(
              name,
              current.filter((o) => o.id !== id).map((o) => o.name),
            ),
          }
        : r,
    ),
  );
}

export async function setRepoAdo(
  id: string,
  ado: WorkspaceRepo["ado"],
): Promise<void> {
  const current = await readRepos();
  await writeRepos(current.map((r) => (r.id === id ? { ...r, ado } : r)));
}

/** Pre-registry setter: collapses the workspace to the one folder handed in.
 *  Its callers become explicit registry edits as their surfaces land. Returns
 *  the surviving entry, which is what an ADO auto-bind needs. */
export async function setSourceRoot(
  value: string | null,
): Promise<WorkspaceRepo | null> {
  if (!value) {
    await writeRepos([]);
    return null;
  }
  const current = await readRepos();
  const key = rootKey(value);
  // Keep the existing entry when it's the same folder, so its id and ADO
  // binding survive a re-pick.
  const existing = current.find((r) => rootKey(r.root) === key);
  const next = await writeRepos([existing ?? createRepo(value)]);
  return next[0] ?? null;
}

export async function setCodeSearchEnabled(value: boolean): Promise<void> {
  await writePref(KEY_CODE_SEARCH_ENABLED, value);
}

export async function setContextGuardEnabled(value: boolean): Promise<void> {
  await writePref(KEY_CONTEXT_GUARD_ENABLED, value);
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
  // platform default while the UI shows a phantom selection. Both keys land
  // in ONE save (two writePref calls = two saves, and a failure between them
  // produces exactly that phantom state).
  await store.set(KEY_DEFAULT_SHELL_ID, id);
  await store.set(KEY_DEFAULT_SHELL_PATH, path);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key: KEY_DEFAULT_SHELL_ID, value: id });
  await emit(PREFS_CHANGED_EVENT, { key: KEY_DEFAULT_SHELL_PATH, value: path });
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
  // Route through writePref so the PREFS_CHANGED_EVENT fires — otherwise a
  // shortcut edited in the Settings window never reaches the main window
  // (store.onChange only fires in the writing process).
  await writePref(KEY_SHORTCUTS, value);
}

export async function resetShortcuts(): Promise<void> {
  await writePref(KEY_SHORTCUTS, DEFAULT_PREFERENCES.shortcuts);
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
    [KEY_REPOS]: "repos",
    [KEY_CODE_SEARCH_ENABLED]: "codeSearchEnabled",
    [KEY_CONTEXT_GUARD_ENABLED]: "contextGuardEnabled",
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

// The ADO connection (org/project/PAT) is owned by the Rust backend, not the
// prefs store, so a save in the Settings window can't reach the main window
// through onPreferencesChange. Broadcast a dedicated event so the main window
// re-reads the connection and reloads the Plans explorer the moment the user
// connects — instead of waiting for a window refocus or app restart.
const ADO_CONNECTION_CHANGED_EVENT = "devops-studio://ado-connection-changed";

export async function emitAdoConnectionChanged(): Promise<void> {
  await emit(ADO_CONNECTION_CHANGED_EVENT);
}

export function onAdoConnectionChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(ADO_CONNECTION_CHANGED_EVENT, () => cb());
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
