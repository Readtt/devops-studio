# Phase 11 — Remaining surfaces

> Read `00-INDEX.md` first. Requires Phases 7–8. Fixes bug #6.

Suite Chat, Confidence, Code Viewer, Terminal, Command Palette. Each is small; they're grouped
because none warrants its own phase.

## Suite Chat

- `SuiteChatPane.tsx:166-172` — `hasSource` becomes `codeSearchEnabled && repos.length > 0`.
- `hooks/useSuiteChat.ts:829-831, :886` and `lib/runSuiteChat.ts:405-432` pass `repos`.
- Add the same chip row as the generator to the composer header, beside the existing file-count chip.
  Tooltip it.
- `SuiteChatTab` (`tabs/store/types.ts:40-52`) needs **no** repo field — scope is per message, not
  per thread. Chat threads (`chatThreadsApi.ts`) stay repo-less.

## Confidence

- `lib/evaluateCaseConfidence.ts:30-61` stamps provenance from one repo (`:41-48`, via
  `git_repo_info` at `:43`). Fan out per in-scope repo.
- `ConfidenceVerdict` (`lib/confidence.ts:56-72`) gains
  `sources: { repoId, repoName, branch, sha }[]`. The legacy scalar `sourceSha` / `sourceBranch` are
  read as `repos[0]` for verdicts stored before this change — don't drop them, don't migrate them.
- `verdictSourceState` (`:92-98`) compares 7-char sha prefixes; it becomes "stale if **any** recorded
  repo's head sha differs from the stored one for that repo". Without this, a verdict scored against
  one repo but compared to another's HEAD reads as permanently stale.
- `hooks/useSuiteConfidence.ts:22-33` `currentSourceSha()` fans out too.
- The bulk run (`useSuiteConfidence.ts:44-90`) stays **one app-wide run over all repos** — no
  per-case scope control. Deliberate: it's a batch, and per-case scoping would be noise.

## Code Viewer

Good news: `resolveSourcePath` (`resolveSourcePath.ts:45-55`) and `resolveSourcePathDeep` (`:65-82`)
already take `sourceRoot` as a **parameter** — only the callers hardcode the global pref.

- Route both through `resolveRepoPath`. `resolveSourcePathDeep` fans `fs_resolve_source_path` across
  repos, preferring an explicit repo prefix before falling back to a unique fuzzy match. Today a
  bare filename can silently resolve to the wrong repo's file.
- `CodeViewerTab` (`types.ts:27-33`) gains `repoName?: string`.
- **Titles stay the bare basename** (`useTabsStore.ts:349`, `App.tsx:448-453`) and get prefixed with
  the repo name **only when two open tabs collide on basename**. Permanent prefixing costs tab-strip
  width for no benefit most of the time.
- The pane header (`CodeViewerPane.tsx:199`, `displaySourcePath`) shows the virtual path.
- Dedup on absolute `path + startLine + endLine` (`useTabsStore.ts:244-250`) already disambiguates
  repos correctly — absolute paths differ. No change needed.
- Dispatchers of `devops-studio:open-code-viewer` to check emit prefixed paths:
  `components/CodeRefChip.tsx:31-40`, `commit-review/{ApplyPatchCard.tsx:189,CommitDiffView.tsx:121,FindingCard.tsx:69}`,
  `generator/{components/AnalyzeActivityLog.tsx:493,GeneratorPane.tsx:2892}`,
  `test-plans/BugPane.tsx:273`.

## Terminal — including bug #6

- `openTerminalTab` (`App.tsx:543-560`) and `launchActions.ts:24-30` default to `repos[0].root`.
- `LaunchMenu` gains a repo submenu when `repos.length > 1`. Menu items take `icon` + `description`,
  never a nested tooltip.
- **Bug #6:** `QuickPromptsStrip.tsx:62` reads the global pref and `:76` calls
  `invoke("git_branch_list", { cwd: sourceRoot })` (dep array `:89`) — so a terminal opened in a
  different repo gets the **wrong** repo's base branches injected into its prompt templates.

  Its `Props` is `{ sessionId: string }` only (`:46-49`). `TerminalPane` **does** receive `cwd`
  (`:121`) but doesn't forward it, and renders the strip on every live tab (`:443`). Thread `cwd`
  through `TerminalPane` → `QuickPromptsStrip`.

  **Do not change the Rust command.** `git_branch_list` is deliberately separate from the status
  bar's structured `git_branches` (`git.rs:532-537` documents the strip as its only remaining
  caller) and has no `gitOps.ts` wrapper.

- Terminal tab titles already carry the cwd basename (`TerminalPane.tsx:245-255`), so terminals are
  the one surface already visually repo-labelled. Leave that as is.

## Command Palette

- `CommandPalette.tsx:303-333` subtitles show repo count / names instead of the single source path.
- `LaunchMenu.tsx:104-121` disabled state keys off `repos.length === 0`.

## Verify

1. Suite Chat with three repos → answers cite files from more than one; deselecting a repo via the
   chips stops reads there.
2. Score confidence on a case, then commit in one repo → the verdict goes stale; commit in an
   unrelated repo the case doesn't touch → it does **not** go stale for the wrong reason.
3. A confidence verdict stored before this change still renders (legacy scalar fallback).
4. Open the same filename from two repos → two tabs, each opening the right file, titles
   disambiguated by repo.
5. Open a terminal in a non-first repo → Quick Prompts shows **that** repo's branches (bug #6).
6. Command palette shows the repo count; with zero repos the terminal/review actions are disabled
   with a clear reason.
7. `pnpm test` green.

## Commit

`feat(app): make suite chat, confidence, viewer and terminal repo-aware`
