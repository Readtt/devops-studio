# Changelog

All notable changes to DevOps Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow extracts the section matching the pushed tag and uses it
as the GitHub release body, so keep the heading format exact: `## [x.y.z] - YYYY-MM-DD`.

## [0.2.0] - 2026-05-22

- **Status-bar update indicator + bottom-left toast** replace the modal that used to pop over the workspace whenever an update landed. The pill in the footer mirrors updater state (available / downloading / restart-ready) and the toast renders a parsed Keep-a-Changelog body — `Added`, `Fixed`, `Changed`, `Removed`, `Security` get tone-coded chips and overflow into a "show all N" affordance. Dismissing the toast remembers the version in `localStorage` so it doesn't re-pop every launch; clicking the pill un-dismisses for that version.
- **ESC cancels in-flight refine.** Rust side adds `claude_cancel_run` that notifies a per-run `tokio::sync::Notify`; the run task races `child.wait()` against the cancel signal via `tokio::select!` and surfaces a new `ClaudeError::Cancelled` variant. JS plumbs the runId through `runQaAnalystClaude` via `onRunStart`; pressing ESC during refine kills the subprocess instead of waiting on the model. The running strip also gets an explicit `cancel` button with an `esc` kbd hint.
- **Settings → Models default-model picker locks during analyze / refine / open draft.** New `emitGenerationBusy` / `onGenerationBusy` events on the prefs bridge so the settings window mirrors the status-bar picker's local behavior across windows. Inline amber "locked" pill explains why.
- **Production right-click guard.** New `installContextMenuGuard` helper called from both window entries suppresses the native Chromium / Edge context menu in release builds (devtools menu stays in development). Opt-in escape: any element marked `data-allow-context-menu` preserves the native menu — useful for CodeMirror surfaces where users want OS copy/paste.
- **"Run Claude in isolation" toggle** (Settings → Models → Advanced runtime) — passes `--bare` so the analyst skips your `~/.claude` hooks, plugins, MCP servers, and `CLAUDE.md`. Tucked behind a collapsed disclosure since most users never need it; the code-1 error message references it by name. Automatically ignored at runtime on Max OAuth (bare skips the keychain read) with an explanatory chip in the UI.
- **Refine "thinking" and "history" chips** moved into the composer's dock header — always visible without eating composer real estate, with hover tooltips and live counts.

- **`<button>` cannot be a descendant of `<button>` hydration error** in `GenerationHistoryPane.RunCard`. The outer toggle is now a `<div>` with the row's toggle + action icons as siblings.
- **Refine history dialog** lists rounds most-recent-first (round numbers still count chronologically so `#03` stays `#03` across views).
- **Analyst.log layout** — long file paths and grep patterns no longer break mid-token. Live composer view gets per-cell horizontal scroll with a slim 4px hover-revealed scrollbar; the rounds-history dialog wraps content instead (shadcn's `ScrollArea` was eating nested horizontal wheel events).
- **Improved code-1 error message** — detects "not logged in" / "invalid api key" stderr and gives a targeted hint about the OAuth + bare-mode conflict; empty-stderr message now enumerates likely causes (hook, MCP, plugin) and points at the activity log for `hook:<name>` rows.

- **Updater dialog removed.** All in-app updater UX flows through the bottom-bar pill + bottom-left toast. Settings → About keeps its own "Check for updates" affordance, unchanged.
- **`claudeBareMode` preference defaults to `true`** on fresh installs — DevOps Studio runs the analyst in an isolated CLI session so your local Claude Code config doesn't bleed into the app's internal AI calls. Existing installs without the stored key inherit the new default; explicit user choices are preserved.

## [0.1.2] - 2026-05-21

### Fixed
- Windows: console windows no longer flash when the app spawns subprocesses.
  `git rev-parse` runs every 30 s for source-directory branch detection, plus
  every Claude CLI invocation (probe, run-query, auth status, etc.) — each of
  those used to pop a brief cmd.exe window. All spawns now pass
  `CREATE_NO_WINDOW` on Windows. This fixed the "terminals keep opening and
  closing" issue that made the app look broken on first launch.

### Added
- macOS builds (.dmg / .app) are back in the release matrix. They're
  intentionally unsigned for now (no Apple Developer Program account); see
  [docs/install-macos.md](docs/install-macos.md) for how to bypass Gatekeeper
  on first launch.
- `scripts/release.sh` — one-shot release helper that bumps the version
  across `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`,
  prepends an entry to this CHANGELOG, commits, tags, and pushes. See
  [CLAUDE.md → Release process](CLAUDE.md#release-process) for usage.

### Changed
- Release workflow auto-publishes (no more draft step) and pulls release
  notes from the matching CHANGELOG section instead of the static placeholder
  string.

## [0.1.1] - 2026-05-21

First public release. Windows + Linux installers, signed updater artifacts,
auto-update wired through `tauri-plugin-updater`. macOS bundles were skipped
in this build — added back in 0.1.2.

### Added
- Auto-updater: the app polls `latest.json` on the GitHub release every 30 min
  (and on launch), verifies signatures with the embedded minisign pubkey, and
  prompts to download + relaunch.
- Public-release CI / release workflows under `.github/`.

### Fixed
- Test-case generator "ask follow-up" no longer fails silently with
  `Claude exited with code 1` and no message. Stdin / stdout / stderr now
  drain concurrently (was a pipe deadlock on large refine prompts), stderr is
  captured lossily so non-UTF8 console bytes don't truncate the diagnostic,
  and `--allowed-tools` was switched to `--tools` so `bypassPermissions`
  doesn't accidentally re-expose Bash/Write/Edit.
- Refine-history dialog no longer expands sideways when "thinking & tool
  calls" is opened. CSS grid items needed `min-w-0` down the chain plus
  `break-all` / `break-words` on long paths and JSON output.
