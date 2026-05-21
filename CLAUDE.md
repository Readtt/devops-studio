# DevOps Studio — Project Guide for Claude

DevOps Studio is a Tauri 2 desktop app for QA testers working in Azure DevOps Test Plans. Paste a feature spec, drag source files in, and the app generates publishable test cases with bug suggestions, code links, and duplicate detection. Forked from Terax (terminal/AI editor); the terminal/shell/agents UI has been removed.

## Tech stack

- **Desktop shell:** Tauri 2 (Rust backend + webview frontend)
- **Frontend:** React 19 + Vite 7 + TypeScript 5.8
- **UI:** shadcn (radix-luma variant) + Tailwind CSS v4 + oklch color tokens + Inter Variable / JetBrains Mono
- **Icons:** `@hugeicons/react` for app glyphs, `simple-icons` for brand marks (ADO, Anthropic, OpenAI, etc.) via `src/components/BrandIcon.tsx`
- **State:** Zustand stores under `src/modules/*/store/`
- **AI:** Vercel AI SDK (multi-provider) and Claude Code CLI (subprocess, OAuth + API-key)
- **ADO client:** Native Rust HTTP via `reqwest`, PAT stored in OS keychain
- **Code viewer:** CodeMirror 6
- **Secrets:** Tauri `secrets` plugin → Windows Credential Manager / macOS Keychain / libsecret

## Layout

```
src/                                      Frontend
├── app/App.tsx                           Main window root (sidebar + tabs + status bar)
├── components/ui/                        shadcn components (we edit these — do not regenerate from upstream)
├── components/BrandIcon.tsx              Simple-icons wrapper for company logos
├── modules/
│   ├── ado/                              Tauri-invoke wrappers + types for ADO commands
│   ├── ai/                               AI provider config, keyring, Claude/Vercel SDK clients
│   ├── code-viewer/                      CodeMirror panes
│   ├── command-palette/                  Ctrl/Cmd+K palette
│   ├── generator/                        Test case generator: store, prompt, Claude+Vercel runs, panes
│   ├── git/                              Source-directory git branch reading (P2 addition)
│   ├── settings/                         Preferences store + cross-window settings bridge
│   ├── shortcuts/                        Keyboard shortcut definitions
│   ├── sidebar/                          Left sidebar rail (Plans/Stale/History)
│   ├── tabs/                             Tab management
│   ├── test-plans/                       Plans tree, suites, cases, stale queue, bug panes
│   ├── theme/                            Light/dark/system theme provider
│   └── updater/                          Tauri auto-update dialog
├── settings/                             Settings window (its own Vite entry)
└── styles/globals.css                    Tailwind base + oklch tokens + scrollbar overrides

src-tauri/src/                            Rust backend
├── lib.rs                                Tauri builder + command handler registry
└── modules/
    ├── ado/                              Typed ADO HTTP client (plans, suites, cases, bugs, repos)
    ├── claude.rs                         Subprocess driver for `claude` CLI (probe, run-query, setup-token)
    ├── fs/                               Filesystem reads (read/write/grep/glob/tree)
    ├── git.rs                            git rev-parse helpers (P2 addition)
    ├── history.rs                        Generation run history (SQLite)
    ├── net.rs                            HTTP + LM-Studio ping helpers
    ├── secrets.rs                        OS keychain bridge
    ├── staleness.rs                      Per-branch stale-case detection
    └── workspace.rs                      Source-dir authorization + path resolution
```

## How IPC works

Tauri commands are `#[tauri::command] async fn` in Rust. The frontend invokes them via `@tauri-apps/api/core`'s `invoke<Result>(name, payload)`. URLs you see in devtools like `http://ipc.localhost/ado_list_suite_cases` are the standard Tauri IPC plumbing — `ipc.localhost` is not a real network host.

All Rust handlers are registered in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]`. If you add a command, add it to that list.

ADO requires a connection that's persisted by:
- `devops-studio-settings.json` (Tauri Store plugin) — org URL, project, default plan, default tracking branch
- OS keychain (account `ado.pat`) — PAT only

## Theme & dark mode

- Tokens live in `src/styles/globals.css` as `oklch()` CSS variables.
- Dark mode is OLED-style: pure-black background (`oklch(0 0 0)`) with cards/popovers/sidebar lifted to ~`oklch(0.14 0.003 240)` for depth.
- Light mode is unchanged.
- Switching is driven by `src/modules/theme/ThemeProvider.tsx` which writes to localStorage shadow + Tauri store.

## Type scale (be consistent)

UI text caps at 13 px because this is an editor. Allowed sizes:

| Use | Size |
|-----|------|
| Captions, tags, meta | 10.5 px |
| Tooltip text, inline metadata | 11 px |
| UI body (most labels, list rows) | 11.5 px |
| Body text / readable rows | 12 px |
| Emphasis (titles in cards) | 12.5 px |
| Section headings | 13 px |

Monospace is JetBrains Mono Variable for `<code>`/`<pre>`/IDs. Sans is Inter Variable everywhere else.

## shadcn defaults (after the consistency pass)

- `<Button>`: `h-8 px-3 text-[12px] rounded-md` (default), `h-7 text-[11px]` (sm), `h-6 text-[11px]` (xs)
- `<Input>` / `<Select>`: `h-8 text-[12px] rounded-md`
- `<Tooltip>`: `text-[11px] py-1 px-2`
- Icon-only buttons MUST be wrapped in a `<Tooltip>`. The codebase contains a runtime audit you can grep: `size="icon"` without surrounding `Tooltip` is a bug.

## Generator session phases

The Test Case Generator is a state machine in `src/modules/generator/store/useGenerationSession.ts`:

```
input → analyzing → review → publishing → done
                ↘            ↘            ↘
                 → error  → error      → error
```

Phase UIs live under `src/modules/generator/phases/`. Run engines:

- `qaAnalystRunClaude.ts` — drives the `claude` CLI via `claude_run_query` (full agent loop)
- `qaAnalystRun.ts` — Vercel AI SDK with whichever provider is the user's default

Generator can re-target itself mid-session via `setTarget(planId, suiteId)` so reusing an open tab from the context menu actually updates the form.

## Branch awareness

The bottom status bar shows the current git branch of the user's source directory (`usePreferencesStore.sourceRoot`). Reading is done by `src/modules/git/useSourceDirGitInfo.ts` → Rust `git_repo_info`, polled every 30 s and on window focus.

If `AzureDevOpsSection`'s tracking branch is set to the sentinel `$current`, the staleness scanner resolves it at scan-time from the live source-dir branch instead of using the saved value.

## Contribution notes for follow-ups

- **Don't regenerate shadcn components** from the registry — we customized them. If you must update, diff carefully.
- **Don't reintroduce WSL or terminal code** — those modules were intentionally removed.
- **Don't add comments that just restate the code.** This codebase generally writes a comment only when there's a non-obvious "why."
- **One feature, one phase commit.** When in doubt, look at `.claude/plans/humming-coalescing-petal.md` for the phased remediation plan.
- **Skeleton loaders, not spinners.** When a list is loading, show shadcn `<Skeleton>` rows that mirror the eventual content.
- **Tooltips on every icon-only button.** Use `<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent side="bottom" className="text-[11px]">…</TooltipContent></Tooltip>`.
