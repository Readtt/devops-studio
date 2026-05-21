# Changelog

All notable changes to DevOps Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow extracts the section matching the pushed tag and uses it
as the GitHub release body, so keep the heading format exact: `## [x.y.z] - YYYY-MM-DD`.

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
