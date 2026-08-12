# DevOps Studio — Project Guide for Claude

DevOps Studio is a Tauri 2 desktop app for QA testers working in Azure DevOps Test Plans. Paste a feature spec, drag source files in, and the app generates publishable test cases with bug suggestions, code links, and duplicate detection.

## Tech stack

- **Desktop shell:** Tauri 2 (Rust backend + webview frontend)
- **Frontend:** React 19 + Vite 7 + TypeScript 5.8
- **UI:** shadcn (radix-luma variant) + Tailwind CSS v4 + oklch color tokens + Geist Variable / JetBrains Mono
- **Icons:** `@hugeicons/react` for app glyphs, `simple-icons` for brand marks (ADO, Anthropic, OpenAI, etc.) via `src/components/BrandIcon.tsx`
- **State:** Zustand stores under `src/modules/*/store/`
- **AI:** Vercel AI SDK — one BYOK engine, every provider via API key. All four AI surfaces (Generator, Suite Chat, Commit Review, Confidence) route through **one shared task runner** (`ai/lib/taskRunner.ts`: `runTask`/`streamTask`). **Read-only against the user's source** — the AI *suggests* artifacts the user applies (test cases via `ado_*`; commit-review patches via `fs_write_file` behind `ApplyPatchCard`); it never autonomously writes files, and the only shell access is a strictly read-only, allowlisted `run_command` tool (git/file inspection — `src-tauri/src/modules/command.rs`; no writes, deletes, network, or shell chaining). Read access (files + `run_command`) is gated by the global `codeSearchEnabled` preference; per-surface agentic-loop step caps live in `config.ts` `SURFACE_STEP_CAPS`.
- **Sampling params are per-model, decided in `config.ts` — not delegated to the provider SDKs.** Every surface asks for `temperature: 0`, but frontier tiers REMOVED the param: Anthropic's Claude 5 answers `` `temperature` is deprecated for this model `` with a **400**, so a model flagged `rejectsSamplingParams` (or tagged `reasoning`) gets no temperature at all — `supportsTemperature()` is the one gate, in front of every provider. Don't hand this decision to the provider SDK: each keeps its own per-model capability table that ships a release *behind* every model launch (an `@ai-sdk/anthropic` predating Claude 5 classified it as an unknown model and forwarded `temperature` straight through — that's how the **default** model came to 400 on every run, alongside a 4096-token output cap and downgraded structured output), and gateway/local transports (OpenRouter, custom OpenAI-compatible endpoints, LM Studio) have no such table at all — they forward our body verbatim, so curated gateway routes carry the flag themselves. When adding a frontier model, set the flag. `taskRunner` also retries **once** without the param when a provider explicitly rejects it, which is the only safety net for a user's custom endpoint or a model newer than the build.
- **AI checkpoint/resume:** long agentic runs (Generator analyze, Generator **review-phase follow-ups**, Commit Review) checkpoint every step to `ai_checkpoints.sqlite` (`ai/lib/checkpointApi.ts` over `src-tauri/src/modules/ai_checkpoints.rs`; opaque JSON payloads, keep-10 **per surface**, deleted on success). Three surfaces: `generator`, `generator-refine`, `commit-review` — declared in `CHECKPOINT_SURFACES`, free-form TEXT on the Rust side. An interrupted run resurfaces automatically: a fresh Commit Review tab **adopts** the newest resumable checkpoint for its cwd (`useCommitReview.ensure`), a restarted generator tab rehydrates from its checkpoint (`TabContent`), orphaned generator checkpoints show as "interrupted" rows in History, and the review pane probes for an unfinished follow-up on mount (`probeRefineCheckpoint`, matched on `sessionRunId`). Resume replays the persisted transcript (`resumeMessages`) so completed steps are never re-run; resumability is gated by the shared `errorClass.canOfferResume` (empty / schema_violation / context-overflow never resume). The resume affordance is the shared `ResumeCard`, structured run errors render through the shared `RunErrorPanel` (both in `ai/components/`). In `streamTask`, schema validation runs against the FINAL step's text, never the all-steps textStream concatenation — mid-run narration containing fenced JSON used to shadow the real answer and "validate" as an empty batch.
- **Follow-up ("ask follow-up") checkpoints are per ROUND, not per session.** `generator-refine` rows are keyed by a fresh `rfn-*` id and carry `sessionRunId` to tie them back to the draft — sharing the session runId would let a cancelled round's trailing throttled write land on the next round's row, and would collide with the analyze checkpoint that the same runId already owns. A resumed round `upsertRound`s its history entry rather than appending, so one follow-up is one row in the thinking history no matter how many attempts it took.
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
│   ├── ai/                               AI provider config, keyring, shared task runner + system prompts
│   ├── commit-review/                    BYOK-grounded review pane for selected git commits (investigate→verify, suggests applyable patches)
│   ├── code-viewer/                      CodeMirror panes
│   ├── command-palette/                  Ctrl/Cmd+K palette
│   ├── generator/                        Test case generator: store, prompt, Claude+Vercel runs, panes
│   ├── git/                              Source-directory git branch reading (P2 addition)
│   ├── search/                           Workspace-wide search surface
│   ├── settings/                         Preferences store + cross-window settings bridge
│   ├── shortcuts/                        Keyboard shortcut definitions
│   ├── sidebar/                          Left sidebar rail (Plans/History/Chats)
│   ├── tabs/                             Recursive pane tree + tab store (split, drag, pin, dedup)
│   ├── terminal/                         xterm.js pane + Quick Prompts (developer mode)
│   ├── test-plans/                       Plans tree, suites, cases, bug panes, Suite Chat
│   ├── theme/                            Light/dark/system theme provider
│   └── updater/                          Tauri auto-update dialog
├── settings/                             Settings window (its own Vite entry)
└── styles/globals.css                    Tailwind base + oklch tokens + scrollbar overrides

src-tauri/src/                            Rust backend
├── lib.rs                                Tauri builder + command handler registry
└── modules/
    ├── ado/                              Typed ADO HTTP client (plans, suites, cases, bugs, repos)
    ├── ai_checkpoints.rs                 SQLite store for AI run resume checkpoints (opaque payloads; keep-10/surface)
    ├── chat_threads.rs                   SQLite-backed persistence for suite-chat threads
    ├── command.rs                        Read-only allowlisted `run_command` runner (git/file inspection; no writes, no shell)
    ├── commit_review.rs                  SQLite-backed persistence for saved commit reviews
    ├── confidence_store.rs               SQLite-backed persistence for per-case confidence verdicts
    ├── fs/                               Filesystem reads (read/write/grep/glob/tree)
    ├── git.rs                            Read-only git: rev-parse/branch/commit info, status summary, commit + working-tree diffs
    ├── git_ops.rs                        Git WRITE ops: branch checkout (carry/stash) + fast-forward pull — the ONLY code that mutates the user's tree, and only from an explicit status-bar action
    ├── history.rs                        Generation run history (SQLite)
    ├── net.rs                            HTTP + LM-Studio ping helpers
    ├── pty.rs                            portable-pty driver for the embedded terminal
    ├── secrets.rs                        OS keychain bridge
    └── workspace.rs                      Launch-dir snapshot + (unused) root registry — NOT enforcement; the AI read gate is src/modules/ai/lib/security.ts
```

## How IPC works

Tauri commands are `#[tauri::command] async fn` in Rust. The frontend invokes them via `@tauri-apps/api/core`'s `invoke<Result>(name, payload)`. URLs you see in devtools like `http://ipc.localhost/ado_list_suite_cases` are the standard Tauri IPC plumbing — `ipc.localhost` is not a real network host.

All Rust handlers are registered in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]`. If you add a command, add it to that list.

ADO requires a connection that's persisted by:
- `devops-studio-settings.json` (Tauri Store plugin) — org URL, project, default tracking branch
- OS keychain (account `ado.pat`) — PAT only

## Theme & dark mode

- Tokens live in `src/styles/globals.css` as `oklch()` CSS variables.
- Dark mode is dimmed, not OLED black: the canvas sits at `oklch(0.18 0.004 240)` with elevated surfaces (card/popover/sidebar) stepping UP from it — see the rationale comment in globals.css (pure black + near-white text reads as glare over long sessions).
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
| Pane/page titles (the single h1 of a pane or settings page) | 16 px |

Mono micro-badges (uppercase abbreviation chips, kbd-style) are 9.5 px mono; inline mono refs/metadata bottom out at 10.5 px (CodeRefChip is canonical).

Monospace is JetBrains Mono Variable for `<code>`/`<pre>`/IDs. Sans is Geist Variable everywhere else.

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

Phase UIs live in `src/modules/generator/GeneratorPane.tsx` and its sibling
components (there is no `phases/` directory). The analyzer runs through
`qaAnalystRun.ts` → the shared `runTask` (schema-validated `DraftBatch`,
`temperature: 0`); when code search is on it gets read-only Read/Glob/Grep tools
so cases are grounded in real code.

Generator can re-target itself mid-session via `setTarget(planId, suiteId)` so reusing an open tab from the context menu actually updates the form.

## Branch awareness

The bottom status bar shows — and **switches** — the current git branch of every configured source repo (`usePreferencesStore.repos`). Reading is `src/modules/git/useReposGit.ts`: `useReposGitInfo()` (branch/commit) and `useReposStatus()` (dirty + ahead/behind + `parkedHere`, via Rust `git_status_summary`) both return `Map<repoId, …>`, and `usePrimaryRepoGitInfo()` is the single-repo view the surfaces that still read one root use. All three share one polling shell — every 30 s, on window focus, and on the `source-git-changed` event, which is subscribed through `onSourceGitChanged` (`gitOps.ts`). **Subscribe through that helper, never by hand:** the event goes out on the DOM bus *and* the Tauri bus (a listener on one only misses changes made in the other window), Tauri echoes it back to the emitting window, and the helper's nonce is what stops that echo costing every reader a second git spawn per repo. Its `{ root }` payload narrows a refresh to one repo; a payload-less event means "refresh all", and listeners must keep tolerating that.

The switcher lives in `src/modules/git/StatusBarGit.tsx`. At **one** repo it is exactly what it always was: folder segment + branch pill. At **more than one** the folder segment shows `3 repos` and opens Settings (the directory picker writes through `setSourceRoot`, which would collapse the workspace to the one folder picked), and the branch segment summarises the repos — the branch when they all agree, else `N branches` — and opens a repo list that drills into one repo's branch list with `cwd={repo.root}`. Branches come from `git_branches` (structured: local + remote-only, deduped, current-first, recency-sorted); picking one runs checkout → fast-forward pull (`git_ops.rs`), driven by `useBranchSwitch.ts` and surfaced through a glass-capsule toast (`BranchSwitchToast.tsx`, matched 1:1 to the updater toast). Pull is fast-forward-only and never auto-merges/rebases.

**Repos move independently.** `useBranchSwitch` keys its op token, toast, confirm and dismiss timer by `cwd`, so a switch started in one repo can't cancel or steal the toast of one already running in another; toasts render as a stack and the dirty-tree dialog asks one repo at a time, naming it.

The dirty-tree flow follows GitHub Desktop's model (researched): `BranchSwitchDialog.tsx` offers **Bring my changes to X** (plain checkout — git carries them or refuses, never conflict-markers) vs **Leave my changes on Y** (stash tagged with `PARKED_STASH_MARKER`; the target opens clean — we never auto-reapply). Restore is **manual, not auto-on-return**: when a branch has parked changes (`parkedHere`), the switcher shows a "Restore changes you left here" item (and a pill indicator) that runs `git_stash_restore` — `apply` then `drop`-only-on-clean, so a conflicting restore keeps the stash (conflicts surfaced by unmerged paths, never by message-scraping). Picking a **remote-only** branch creates a local tracking branch (`checkout -t`). The switcher footer also has a manual **Fetch from remote** button (`git_fetch --prune`, no auto-fetch — avoids credential-prompt fatigue) that refreshes the list with a "last fetched" hint and a **Pull latest** action (`pullOnly` → `git_pull`) that fast-forwards the *current* branch in place. Pull is shown whenever the current branch tracks an upstream — **not** gated on the `behind` count, because that count only reflects the last fetch (it reads the cached `origin/<branch>` ref); `git pull --ff-only` fetches first, so it's correct even when the cached count says 0, and a no-op when truly in sync. (Gating Pull on `behind > 0` is what once made pulling the current branch impossible without switching away and back.) A fast-forward that would clobber uncommitted edits comes back as `git_pull` status `local-changes` with a "commit or stash first" message; the tree is left untouched.

Code links on published cases **always** track the live branch of **the repo the link names**, read from that repo's working dir at publish-time — a case citing two repos records each link against the branch it was actually read from, never the first repo's. The repo comes from the path's `<repo>/…` prefix (`splitRepoPath`), falling back to a legacy draft's `repoName`; publish probes `git_repo_info` once per repo the batch actually names, and one unreadable root only costs its own links their stamp. When no branch resolves (detached HEAD / non-repo) the link records no branch at all rather than a fabricated `main`; a detached HEAD still stamps its commit. There is no fixed-branch option — `AzureDevOpsSection` shows a read-only explainer, and `defaultTrackingBranch` is always saved as `$current` (the generator ignores any legacy fixed value). The separate per-run **"Tag with source branch"** switch still controls whether any branch/commit provenance is stamped at all — with it off, publish makes no git call.

The generator input form has a **"Tag with source branch"** switch (`tagSourceBranch`, default on, shown when any in-scope repo has a branch). When on, published cases' source links carry each link's own repo branch and bug code refs carry that repo's HEAD commit, so links point at the code they were generated from; off stamps no provenance. Beside it, at **more than one** configured repo, is a **Repos** chip row (`RepoScopeChips`) writing `repoScope: string[] | null` — the repos this run may read, all on by default (`null`), narrowed only by the user's explicit click; deselecting every chip makes the run tool-less. Both are session-scoped (reset per run), and both are persisted in the analyze checkpoint so a resumed run keeps the scope it started with rather than widening back to every repo.

## Release process

Public repo: **https://github.com/Readtt/devops-studio**.
Releases auto-publish from `.github/workflows/release.yml` whenever a `v*`
tag is pushed. The workflow builds Windows + Linux + macOS installers, signs
every updater artifact with the private key in `TAURI_SIGNING_PRIVATE_KEY`,
and creates the GitHub release using the matching CHANGELOG section as the
release body.

**Cutting a new release**

Always go through `scripts/release.sh` — it keeps the four version sources
(`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`) in sync with CHANGELOG.md and the git tag. Skipping
the script and bumping by hand is how the updater silently breaks.

```bash
./scripts/release.sh 0.1.3
```

Opens `$EDITOR` (or nano) with a Keep-a-Changelog stub — fill in `### Added`,
`### Fixed`, `### Changed`, `### Removed` sections, save, exit. The script
then:

1. Prepends your entry to `CHANGELOG.md` as `## [0.1.3] - YYYY-MM-DD`.
2. Bumps all four version files to `0.1.3`.
3. Commits as `chore(release): 0.1.3` with the notes in the commit body.
4. Tags `v0.1.3` (annotated, notes as the message).
5. Pushes `main` and the tag → the Release workflow fires.
6. If `gh` is on PATH, prints the workflow run URL.

If you want to pass notes from a file instead of opening the editor, use
`--notes-file path/to/notes.md`. For a hotfix where you want to push the tag
first and write notes later, `--no-edit` substitutes a placeholder entry —
amend the commit before pushing if you go that route.

**CHANGELOG conventions**

The release workflow extracts the section matching the pushed tag by
literally searching for `## [<version>]` in `CHANGELOG.md`. If the section
is missing or empty, the release body falls back to a generic string. So:

- Always include a section for the version you're tagging.
- Use the exact heading format `## [x.y.z] - YYYY-MM-DD` — the workflow
  matches on `[x.y.z]` only, but the date is for humans.
- Stick to `### Added`, `### Fixed`, `### Changed`, `### Removed`
  subheadings. Other content is allowed but those four cover most cases.

**Version-bump rules**

- Patch (`0.1.x`) for bug fixes and small chores.
- Minor (`0.x.0`) for new user-visible features.
- Major (`x.0.0`) when we break a contract — e.g. ADO connection format,
  history schema, or anything in the published JSON shapes.

**Signing key inventory**

- Local: `~/.tauri/devops-studio.key` (private, no password). Back this up.
- Repo secret: `TAURI_SIGNING_PRIVATE_KEY` on `Readtt/devops-studio`.
- Public key: baked into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

If the local key is ever lost AND the GitHub secret is rotated, every
existing install will refuse future updates (signature mismatch against the
pubkey baked into the app). The fix is to ship a new app version with the
new pubkey embedded — users have to download that one manually.

**macOS notes**

We don't have an Apple Developer Program account, so macOS builds are
unsigned. The release workflow's `releaseBody` step injects a footer
pointing macOS users at `docs/install-macos.md` for the Gatekeeper bypass.
If we ever get an Apple account, restore the `APPLE_*` env vars in
`.github/workflows/release.yml` (history has the previous version) and add
the matching repo secrets.

## Contribution notes for follow-ups

- **Don't regenerate shadcn components** from the registry — we customized them. If you must update, diff carefully.
- **Don't reintroduce WSL code** — that module was intentionally removed. (The embedded terminal *is* back as a developer-mode pane; see `src/modules/terminal/` and `src-tauri/src/modules/pty.rs`.)
- **Don't add comments that just restate the code.** This codebase generally writes a comment only when there's a non-obvious "why."
- **One feature, one phase commit.** When in doubt, look at `.claude/plans/humming-coalescing-petal.md` for the phased remediation plan.
- **Skeleton loaders, not spinners.** When a list is loading, show shadcn `<Skeleton>` rows that mirror the eventual content.
- **Verify UI changes by driving them, not just by typechecking.** `.claude/skills/drive-ui/` clicks, types into, and screenshots the real React tree over CDP with the Tauri IPC boundary mocked — it needs `pnpm dev` only, no Rust build, because both windows are plain Vite entries. Mocking the boundary is what lets you drive states this machine can't produce (twenty repos, a detached HEAD, an ADO call that 500s). Read its SKILL.md before hand-rolling browser automation: synthetic `blur` events don't reach React, Radix ignores `el.click()`, and screen-capturing the real Tauri window fails outright from an agent shell.
- **Tooltips on every icon-only button.** Use `<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent side="bottom" className="text-[11px]">…</TooltipContent></Tooltip>`.
- **Context menu items get a `description`, not a `<Tooltip>`.** Radix Tooltip and Radix ContextMenu manage their portals/focus independently and fight if you nest a tooltip on a menu item. Instead, pass `icon` + `description` props to `<ContextMenuItem>`. The component renders a Linear/Raycast-style two-line row — label on top, 10.5 px muted subtitle underneath — so right-clickers can see what an action does before they invoke it.
  ```tsx
  <ContextMenuItem
    icon={<HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.75} />}
    description="Generate more cases into this same suite."
    onSelect={...}
  >
    Generate sibling cases
  </ContextMenuItem>
  ```
  Add a description for any item whose label isn't fully self-explanatory ("Open" can ride bare; "Generate sibling cases" cannot).
- **Every new Windows subprocess spawn must hide the console window.** Use the `hide_console()` helper in `src-tauri/src/modules/git.rs` (or inline `cmd.creation_flags(0x0800_0000)` for `std::process::Command` with `CommandExt` imported). Without it the spawn flashes a cmd.exe window — for a poller like `git_repo_info` that runs every 30 s, the result looks (and is) broken. (Exception: the embedded terminal in `pty.rs` deliberately spawns a *visible* shell via portable-pty's ConPTY backend, which doesn't pop a separate cmd.exe — it owns the PTY directly.)

## Tab kinds and dedup rules

Tabs are a discriminated union (`AppTab` in `src/modules/tabs/store/types.ts`). Opening a tab routes through `useTabsStore.openTab(input)` which is the **single place** that decides whether a new tab is created or an existing one is reactivated. The dedup rule is per-kind:

| Kind          | Dedup key                       | Why                                                              |
|---------------|---------------------------------|------------------------------------------------------------------|
| `test-case`   | `caseId`                        | One case == one tab. Re-opening jumps to the existing tab.       |
| `bug`         | `bugId`                         | Same.                                                            |
| `code-viewer` | `path + startLine + endLine`    | Same path at a different line range is a different tab.          |
| `suite-chat`  | `planId + suiteId`              | Per-suite chat. Threads live inside the tab via the switcher.    |
| `generator`   | `runId` (only when set)         | Fresh generator drafts deliberately stack; bound drafts dedup.   |
| `terminal`    | **never**                       | Each `pty_spawn` is a real OS process — N tabs = N shells.       |
| `commit-review` | `cwd` (fresh) / `rehydrateRunId` | Re-opening "Commit Review" focuses the existing fresh review for that source dir; a saved run reopens its own tab. **Duplicate** clones for a parallel review on the same commits. |

When you add a new kind, set the rule explicitly. The dedup rule is also where the user's "why can't I open two of these?" frustration lives — if a kind doesn't dedup naturally, it should NOT dedup in the openTab switch.

## Tab content survival across pane restructures

The workspace pane tree is built by `react-resizable-panels`. **Splitting or merging a pane unmounts everything underneath the affected leaf**, which used to wipe terminal sessions (lost typed input, killed PTYs). The general fix pattern: anything expensive that needs to survive a React unmount — running processes, WebGL contexts, streaming connections — lives in a module-level registry outside React. The component just attaches the existing DOM to whatever container React gives it this render.

Reference: `src/modules/terminal/terminalRegistry.ts` — module-scoped `Map<sessionId, TerminalSession>`. `TerminalPane` looks up by id on mount, re-attaches if it exists, creates if it doesn't. Disposal triggers on real lifecycle events (tab close, PTY exit, app close) — never on React unmount.

If you add another long-running pane (streaming logs, video, an embedded editor with unsaved state), follow the same pattern.

## Brand icons

Three sources, in priority order. **Don't add new manual SVGs** — pick a registry.

1. **simple-icons** via `BrandIcon` (`src/components/BrandIcon.tsx`). First-class for AI providers and shells that ship in the upstream pack. Currently registered: `anthropic`, `git`, `github`, `google`, `vercel`, `apple`, `deepseek`, `mistral` (→ `siMistralai`), `ollama`, `openrouter`, plus shell marks `bash` (`siGnubash`), `zsh`, `fish` (`siFishshell`), `git-bash` (`siGitforwindows`). The `branded` prop controls colour vs `currentColor`; the `isNearBlack` detector keeps Anthropic / Vercel / GitHub legible on dark surfaces by inheriting text colour.
2. **thesvg.org** for brands simple-icons doesn't carry (Microsoft trademarks: PowerShell, Azure DevOps). Fetch from `https://thesvg.org/icons/{slug}/default.svg` and inline as a React component. Examples: `src/modules/terminal/ShellBrandIcon.tsx` (PowerShell), `src/components/AzureDevOpsLogo.tsx`. Use `useId` for gradient defs so multiple copies don't collide. License is "nominative-fair-use for identification", which fits our use.
3. **hugeicons stroke set** as the catch-all fallback. Used when neither registry carries a usable mark (OpenAI, xAI/Grok, Cerebras, Groq, LMStudio). `ProviderIcon` (`src/modules/ai/components/ProviderIcon.tsx`) handles this routing automatically — consumers just write `<ProviderIcon provider={...} />`.

When adding a new provider:
- Check `simple-icons` first: `node -e "const s=require('simple-icons'); console.log(typeof s.siXxx)"`.
- If it's there, register the slug in `BrandIcon`'s `ICONS` map and add the provider → BrandName entry in `ProviderIcon`'s `SIMPLE_ICON_BRAND`.
- If not, check `https://thesvg.org/api/registry.json` for the slug.
- If neither, fall back to a hugeicons stroke icon (the LAST resort — brand recognition matters).

## UI consistency

The fastest way to make a new pane feel native: copy `SuiteChatPane` (or `CodeReviewPane`) and adapt. Specifically:

- **Chat surfaces all use the same bubble pattern.** User messages right-aligned in `bg-primary/12` with `rounded-2xl rounded-br-sm`; assistant messages left-aligned with a 24×24 avatar tile and `border border-border/45 bg-card/55`. Copy-on-hover button absolute-positioned top-right of the assistant bubble. Streaming placeholder is three pulsing dots, 1.5px × 1.5px, staggered animation delays of 0 / 120 / 240ms.
- **Every interactive control gets a tooltip.** Header buttons, base pickers, send/stop, the file-count chip — all wrapped in `<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent side="bottom" className="max-w-[280px] text-[11px]">…</TooltipContent></Tooltip>`. The tooltip explains what the action does AND what'll happen if the user clicks it (e.g. "Changing wipes the conversation"). The user has explicitly asked for this — UI features without tooltips read as "WTF is this".
- **Branch pickers use `BranchPicker`** (`src/components/BranchPicker.tsx`), not a raw `<Select>`. It's a cmdk Combobox in a Popover with fuzzy search and `max-h-[280px]` so long branch lists don't take the viewport. New setting/form branch-picker surfaces should use it too. The sibling `DeveloperPicker` (`src/components/DeveloperPicker.tsx`) mirrors the same cmdk-in-a-Popover pattern to assign a bug's developer; it's shared by the generator review pane and the Suite Chat create-bug card (`ApplyEditCard`), which is why it now lives next to `BranchPicker` rather than inside the generator. (The status-bar branch *switcher* in `StatusBarGit.tsx` builds its own cmdk list rather than `BranchPicker` because its trigger is the status-bar pill segment, not a standalone control.)
- **Empty states explain what's about to happen.** Don't just show a centered icon — write a sentence describing what this pane does and what triggering its primary action will do. Example: `CodeReviewPane`'s `EmptyState`. Confused users disable features.
- **One look for AI provider marks.** Use `ProviderIcon` — never embed a hugeicons stroke for a provider that has a brand mark in `BrandIcon`. The mixed look (real Anthropic next to stroke OpenAI) is fine because each provider's icon is the best available representation for that brand.
- **Don't reinvent the wheel for kinds that have an established pattern.** If you're adding a chat pane, it should look like the existing chat panes. If you're adding a developer-mode surface, it should match the terminal/commit-review aesthetic. The codebase has converged on a few visual templates; honour them.
