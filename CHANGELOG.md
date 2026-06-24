# Changelog

All notable changes to DevOps Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow extracts the section matching the pushed tag and uses it
as the GitHub release body, so keep the heading format exact: `## [x.y.z] - YYYY-MM-DD`.

## [0.11.0] - 2026-06-24

### Added

- The test-case generator's single mode picker is now two independent choices: a **Coverage** control (Happy path, or Full = happy + edge + negative) and a separate **Suggest bugs** toggle. Folding both into one picker meant "bug-hunt" secretly also meant "full coverage" — now they're separate. Older saved drafts and history still load, mapping onto the new settings automatically.
- **Test** button on every provider key card in Settings → Models. It fires one tiny request to confirm the key actually works before you rely on it — catching the failures a format check can't: a wrong-provider key (e.g. an OpenAI key pasted under DeepSeek, which share the `sk-` prefix), a revoked key, or a key with no credits.
- Manual **reload** buttons beside the filter on the Generation history and Commit Review history panes, so you can refresh the list from disk on demand.

### Fixed

- API keys are now reliably found by every AI feature (Generator, Suite Chat, Commit Review, Confidence). Previously a freshly added key could read as a false "missing key" until you restarted the app — keys are now loaded from the OS keychain at launch and kept live as you save or clear them in Settings.
- Cloud models now connect through the app's own networking, fixing spurious "Failed to fetch" / "fetch failed" errors (including when pasting an image) for Anthropic, OpenAI, and other providers.
- A stalled model connection no longer hangs forever: if a provider goes silent mid-response for two minutes, the run ends with a clear error instead of spinning indefinitely.
- Stopping a Suite Chat now actually stops the model — and the billing — by tearing down the request, instead of letting it finish in the background. Stop also works during the brief setup window before streaming begins.
- The generator no longer drops you into a blank review when a model returns nothing. It shows a specific error explaining why (often an OpenAI-compatible or custom endpoint that needs structured-output / JSON mode), with your spec preserved. New, clearer error screens also cover context-overflow, rate limits, out-of-credits, provider overload, and network problems.
- Re-running a generation you reopened from history no longer overwrites the published history entry — and its Azure DevOps work-item links — as a draft.
- Refining a draft no longer turns an "update existing case" choice into a duplicate work item on publish.
- Code links on published cases are only stamped with a branch actually resolved from your source directory — never a fabricated "main" on a non-git or detached-HEAD source.
- Better support for OpenAI-compatible, local, and reasoning models: structured output (strict JSON schema) is requested where supported, sampling parameters that reasoning models reject are omitted, and a pasted image degrades to a text reference on models without vision support instead of erroring.
- A pinned-model badge (generator, Suite Chat, Commit Review) now only appears when the pinned model differs from your current default, so it no longer misleads when they're the same.
- Key fields now show a single password-reveal control (the app's) instead of stacking a second native one from the system webview.

### Changed

- Pasting a key that doesn't match a provider's usual prefix is now a non-blocking warning rather than a hard save-block — providers rotate their prefixes, and some providers share one, so the Test button (not the prefix) is the real check.
- Settings labels, model-availability copy, and run-error guidance now refer to **Settings → Models** consistently and reflect the single bring-your-own-key engine.
- Removing a custom (OpenAI-compatible) provider now also resets its custom context-window limit, so a re-added connector doesn't silently inherit the old value.

## [0.10.0] - 2026-06-18

### Added

- Switch your source-directory git branch right from the status bar: pick any local or remote branch to check out and fast-forward-pull the latest, fetch to refresh the remote branch list, or pull the current branch when it's behind. Pull is fast-forward-only — it never auto-merges or rebases, and reports cleanly when branches have diverged.
- When you switch branches with uncommitted work, the app asks what to do with it — bring your changes to the new branch, or leave them parked on the one you came from so the target opens clean. Branches with parked changes show an indicator and a Restore action, and a conflicting restore keeps your stash intact so nothing is ever lost.
- The status bar now shows whether your working tree is dirty and how far ahead or behind the upstream you are.
- Commit Review can now review your uncommitted changes: a **Local changes** target (staged, unstaged, and new files vs HEAD) lets you review work before you commit, on its own or alongside selected commits. It's re-read live right before each run, so it always reflects the current state of your files.
- Confidence scores now record the branch and commit they were graded against. The case confidence panel flags a score as stale once you switch branches or pull — showing the graded-vs-current branch and commit and prompting a re-evaluate — and confirms when a score still reflects your current source.
- Running confidence across a whole suite now re-scores cases whose code has changed since they were last graded, instead of only skipping cases that were never scored.

### Fixed

- Commit Review now stays in sync with the status-bar source directory: switching branches, pulling, or stashing refreshes an open Commit Review tab's commit list and local changes instead of showing the previous branch.
- The Suite Chat onboarding hint no longer promises code grounding when the global code-search toggle is off — it now requires both a source directory and code search enabled, matching what the assistant actually receives.
- Aligned the severity badge with the category tag in Commit Review finding cards (it no longer drops below the row).

### Changed

- Code links on published test cases now always track the branch you generated from, resolved from your source directory at publish time — switch branches in the status bar and the next publish follows the new one.
- The Azure DevOps settings panel replaces the tracking-branch picker and toggle with a read-only **Code-link branch** explainer showing the branch (and commit) links will use right now.
- The source directory is now picked and shown only in the bottom-left status bar; the duplicate title-bar button has been removed.

### Removed

- Removed the fixed/manual tracking-branch option — code links can no longer be pinned to a branch other than the one you're working on.

## [0.9.0] - 2026-06-17

### Added

- **Commit Review** — a new AI code-review surface. Select one or more commits and get a two-stage review (investigate → verify) that returns severity-ranked bug findings with evidence and one-click applyable patch cards. Reviews persist to SQLite and reopen from History exactly as you left them.

### Changed

- Rewrote the README to be shorter and feature-focused, grounded in the current app (Generator, Confidence scoring, Suite Chat, Commit Review). Refreshed the macOS install guide and updated CLAUDE.md's backend module map (the read-only `command` runner and the `confidence_store` persistence module).

### Removed

- Replaced the whole-branch "Code Review" pane with the new Commit Review surface.
- Dropped the `docs/smoke-test.md` and `docs/manual-test-checklist.md` manual QA checklists.

## [0.8.0] - 2026-06-16

### Added

- **Run confidence on all cases in a suite.** Right-click a suite to score every unscored case for pass-readiness in one pass. A bottom-left progress capsule shows live progress and can be cancelled; already-scored cases are skipped, suites with more than 20 cases ask for confirmation first, and open case tabs update the moment their case is scored.

### Changed

- **Prompt caching across every AI surface.** Generator, Suite Chat, Code Review, and Confidence now reuse a cached system prompt and tool definitions instead of re-sending them on every agentic step — an Anthropic cache breakpoint plus automatic caching on OpenAI and Google. Prompts stay byte-identical, so results are unchanged; only token cost and latency drop, most noticeably on multi-step, multi-run, and bulk scoring.

### Fixed

- The Test Case Generator's running-refine step label no longer overflows its container when a tool call references a long file path.

## [0.7.0] - 2026-06-12

The single-BYOK-engine release, plus a ~90-commit full review of the app.
Every AI surface now flows through one shared task runner on the Vercel AI
SDK, the generator grounds test cases in your real source code, and a
day-zero audit hardened ADO calls, cancellation, chat UX, and the UI type
scale.

### Added

- One shared task runner (`runTask`/`streamTask`) every AI surface flows through.
- Deep, code-grounded test-case generation: the analyzer reads your source
  (read-only Read/Glob/Grep) to ground cases and bug suggestions in real code.
- A read-only command tool (`run_command`) on every AI surface — git history,
  blame, diff, and file inspection, allowlisted so it can never mutate.
- Schema-validated, temperature-0 output on Generator and Confidence, with
  partial-batch salvage so one malformed item never zeroes a generation.
- Global **"Allow AI to read source code"** setting gating every surface.
- Generator review upgrades: accept/reject individual refine changes, assign
  bugs to a developer, warnings for unlinked bugs and for passing a case with
  open bugs, confidence verdicts auto-set the run status, and a similarity
  match can update the existing case instead of duplicating it.
- Suite Chat: bulk outcome skips already-marked cases, #-mentioned work items
  render inline, cases reconcile against ADO before each send, and confidence
  surfaces alongside outcomes.
- Plans explorer: reveal a case in the tree from anywhere it's opened; toolbar
  Refresh force-reloads the cases of expanded suites.
- The assign picker lists members across all project teams.
- AI tool calls render as readable observations with live activity, not raw JSON.

### Fixed

- Cancelling analyze/refine/Ask/generation now aborts the upstream model
  request — per-tab abort handles, no more orphaned streams.
- ADO hardening: project names percent-encoded in every URL, correct
  permanent bug-delete endpoint, suite-referenced cases unlink before delete,
  real error reasons surfaced, graceful fallback to the default team.
- Repro-steps HTML from ADO is sanitized before rendering.
- Custom instructions from Settings now apply on every AI surface.
- Source citations resolve to the real file, not a root+filename guess.
- Duplicated code-review tabs no longer share the saved thread.
- Chat polish: no "malformed block" flash while JSON streams, clickable bug
  refs, diffs no longer overflow, unreadable files survive attachment batches.
- A full type-scale and consistency sweep across the UI kit, and the
  confidence panel no longer steals Esc from active text edits.

### Changed

- **Single BYOK engine.** Every model runs through the Vercel AI SDK;
  per-surface agentic step caps centralized in `SURFACE_STEP_CAPS`.
- Read window raised to 1500 lines / 24 KB so the model pulls whole modules.
- The update notification is now a compact capsule linking to the release
  notes on GitHub instead of inlining the whole changelog.
- Refreshed app icons and logos at every resolution.

### Removed

- The Claude Code CLI engine (Rust `claude` driver, frontend clients,
  per-engine settings, and the `aiEngine`/`claudeAuthMode` prefs — older
  settings files migrate silently).
- A large dead general-coding-agent stack and all write/edit/bash/delegation
  tools — the app is read-only against your source: it suggests artifacts you
  apply, never autonomously edits or runs shell.
- The per-run "allow code search" toggle (replaced by the global setting).
- Dead weight found by the audit: 14 unused UI components, three callerless
  Tauri commands, the workspace-authorization machinery, and `@thesvg/react`.

## [0.6.0] - 2026-05-29

### Added

- Claude Opus 4.8 (`claude-opus-4-8`) in the model selector — Anthropic's
  new flagship, available to both the Vercel AI SDK and Claude Code engines,
  with context-limit and pricing metadata wired up.

### Changed

- Claude Opus 4.7 is now labelled "Powerful" (prior-generation flagship)
  instead of "Best", so Opus 4.8 reads as the current top model.

## [0.5.0] - 2026-05-29

The biggest release since the test-execution work — a full feature wave plus a
ground-up audit. Code Review grows up (Azure DevOps commit/PR/branch sources
with real diffs), AI **confidence evaluation** predicts whether a case will pass
against your current code, **bugs become first-class** across chat (attach as
context, full CRUD, auto-injected), **best-practices files** ground every AI
surface, inline **#id work-item mentions** replace the old pickers, chats now
**show the model's tool calls** and syntax-highlight code, and a closing audit
fixes latent bugs, prunes dead code, and adds test coverage. No breaking changes
to your persisted data or Azure DevOps payloads — existing settings, drafts,
chat threads, and saved runs load unchanged.

### Added

**Code Review**
- Review **Azure DevOps sources**, not just the local working copy: a commit
  (vs its parent), a pull request (source vs target), or a branch (vs base),
  picked from a cmdk source picker with repo + branch + recent-commits + PR
  lists, all fuzzy-searchable with skeleton loaders.
- **Real unified diffs + line counts for ADO sources** — each changed file is
  fetched at both versions and line-diffed (accurate +/−), instead of showing
  whole files with +0/−0.
- Runs on **Claude Code (OAuth)** as well as the BYOK API path; Stop cancels the
  CLI subprocess.
- **Regression-aware reviewer prompt**: traces callers/dependents of changed
  symbols and flags blast radius (signatures, contracts, persisted shapes);
  treats an ADO diff as authoritative over the local checkout.
- **Before/after diffs on patch cards** with persisted apply state — the
  "Applied" badge and the diff survive a reload (snapshot kept on the message).
- Source-aware header (per-source descriptor + tooltips), tab dedup, and ADO
  source restored across reload and Duplicate.

**AI confidence evaluation**
- A new engine that **predicts whether a test case would pass against the
  current code**, with per-step code evidence (file:line or an honest
  "Unknown"), calibrated anchors, optional self-consistency runs, and a SQLite
  verdict store. Dual-engine (Vercel + Claude CLI), cancellable end-to-end.
- A **pass-readiness chip** ("how safe is it to just mark this Passed?") on
  generator review cards and the test-case header — green only when a real Pass
  clears the 90% bar; the model now estimates pass-likelihood directly.
- Inline **re-analyze (↻) and cancel (✕)** on the chip, **"Evaluate all"** in
  the generator review (3 at a time, live progress), and a dismissible
  **detail side panel** with reasoning, per-step evidence (click a file:line to
  open it), and a branch reminder.

**Bugs as first-class**
- **Attach existing bugs as AI context** in every chat (repro, severity,
  embedded code links), via a searchable picker.
- **Bug CRUD in Suite Chat** — create / update / delete / link bugs (not just
  cases), with before/after diff cards, undo, and full persistence.
- **Auto-inject bugs linked to in-scope cases** (Tested-by/Tests relations) so
  the model sees open defects without you attaching them.
- Backend ADO commands: list / update / delete bug (WIQL search, JSON-Patch
  edits, soft-delete to Recycle Bin).

**Best practices & shared AI context**
- Register **best-practices / coding-standards files** (md, text, images — incl.
  network/UNC paths) in Settings → Models; they're read live and injected into
  **every** AI surface (generation, suite chat, review chat, code review), with
  a readability indicator that surfaces offline files before a run.
- A shared context-block mechanism (no-op when empty) and a cross-module
  consistency directive in the analyst/reviewer prompts.

**Mentions, palette & search**
- Inline **#id work-item mentions** in every chat composer *and* the generator
  requirements + Refine boxes — `#123` resolves by id, `#login` title-searches,
  bare `#` lists recent items; spans **all** work-item types with a type tag
  (BUG / TASK / STORY / …). Replaces the old Bugs dropdown.
- The Test Plans tree filter is replaced by the **command palette** (`⌘/Ctrl+K`)
  with live Azure DevOps work-item search; items without an in-app pane are
  flagged as opening in Azure DevOps. Tree search now lazy-loads suite cases so
  matches actually surface.

**Chat experience**
- Chats now **show the model's tool calls** (Read/Glob/Grep) in all surfaces
  (Suite Chat, Code Review, generator Ask) via shared infra — collapsed to a
  one-line "N tool calls" summary by default, auto-expanding while streaming.
- **Syntax-highlighted code blocks** using the in-app editor theme.
- **Multi-range code-reference pills** everywhere — one compact pill per file,
  each line range a clickable segment; back-ticked citations (`Foo.cs:42`) are
  linkified too; widened allowlist for the .NET/web stack.
- Persist the **pinned model per chat** across reload (code review + generator,
  matching suite chat); jump-to-latest pills in Ask and Code Review.
- The Suite Chat **inspectable context chip** shows exactly which cases, linked
  bugs, mentioned items, and best-practice files the model received.

**This release's audit pass**
- **"Tag with source branch"** toggle in the generator input form (default on,
  for git source dirs): stamps the resolved branch onto published cases' code
  links and the source-dir commit onto bug code refs.
- **Custom instructions** UI in Settings → Models (the field fed every AI prompt
  but had no control).
- Test coverage for batch parsing, bug→case linking, branch resolution, and
  confidence readiness; plus `docs/manual-test-checklist.md` and `SECURITY.md`.

### Changed
- Confidence verdicts are framed as pass-readiness, colored by predicted outcome
  (not the raw %), and the detail moved from a hover tooltip → Sheet → workspace
  pane → inline side panel over the release as the UX settled.
- Best practices live as a subsection of the Models settings tab (not a 7th tab).
- Claude `--bare` isolation is now derived from auth mode (API-key isolates,
  OAuth doesn't) instead of a footgun user toggle that broke OAuth runs.
- Keyboard hints adapt to the OS (⌘ on macOS, Ctrl on Windows) everywhere.
- File-path separators are normalized throughout (no more mixed `C:\…/…` paths).
- Suite Chat header drops the redundant "N cases" count beside the context chip;
  verbose tooltips (Narrow-AI-scope, code-review diff stats) tightened; icon-only
  Settings buttons use real tooltips; ADO status polling eased 15s → 30s + focus.

### Fixed
- **Bugs linked to the wrong parent case** when an earlier case was skipped
  before publishing — the link index addressed the unfiltered array; now
  resolved through the full array.
- **Stale confidence verdicts** after editing a case's steps no longer linger;
  the chip resets to "Evaluate" and the stored verdict is cleared.
- **429 Retry-After** read from the response body (never present) instead of the
  HTTP header — rate-limited calls always backed off a hardcoded 30s.
- **Large suites truncated**: `list_suite_cases` now follows ADO continuation
  tokens, so 200+ case suites load fully.
- The model no longer invents a git branch/commit in generated code refs — the
  app stamps real provenance at publish time.
- A **white-screen crash** in Suite Chat (a hook ran after an early return on
  suites without loaded cases).
- A **failed suite-chat turn** no longer reappears broken after reload (the
  reconciled thread is flushed to disk).
- Cross-window settings sync for keyboard shortcuts; a leaked PTY event listener
  when a terminal tab closed during spawn; the code viewer reliably scrolls to +
  highlights a linked line on open; context menus flip up near the screen bottom
  instead of clipping; the local diff no longer corrupts when switching back from
  an ADO source; the command palette's right column stays flush-right; #mention
  dropdowns no longer clip; the generation-history meta row wraps at narrow
  widths; the settings close button can't be pushed off-window.
- Backend no longer panics on a poisoned mutex; case-insensitive SSO detection;
  non-JSON CLI output and dropped autosaves / branch-list failures are now logged.

### Removed
- Dead settings: `vimMode`, `showHidden`, the autocomplete trio, and the unused
  `ado.defaultPlanId` field (existing settings files load fine — leftover keys
  are ignored). The "Run Claude in isolation" toggle (now derived from auth).
- 10 confirmed-unused npm packages, incl. `@anthropic-ai/claude-agent-sdk` (the
  engine is driven by the `claude` CLI, not the SDK).

### Security
- Added `SECURITY.md` documenting the trusted-renderer threat model and why the
  `fs_*` commands aren't path-gated (best-practice files and repos legitimately
  live on arbitrary paths / network shares).

### Notes
- The confidence-verdict JSON shape changed during this cycle; old verdicts still
  render (back-compat), no migration needed.

## [0.4.0] - 2026-05-26

This release brings test execution into the workflow — record Pass / Fail / Blocked outcomes from the test-case tab, Suite Chat, and the generator review tab — adds image & file attachments with real vision to every chat surface, bulk edits in Suite Chat, and a "what the last refine changed" diff in the generator. The stale-case detection feature is removed.

- **Record run outcomes (Pass / Fail / Blocked / N/A).** A minimal outcome dropdown in the test-case header writes the case's test-point outcome in its plan + suite, backed by a new Rust `test_points` module (list points, set outcome, list a case's suites) — the write returns the outcome it set rather than ADO's lagging PATCH echo. Suite Chat can now propose an outcome as an Apply card, and the **generator review tab** lets you pick an outcome per case that's recorded against its test point right after the case publishes.
- **Attachments in every chat.** Drag-drop, paste, or use the paperclip to attach images and text files in Suite Chat, Code Review, and the generator's Refine and Ask composers — matching the generator's input phase. Images are now sent to the model as real **vision** input (Vercel-SDK providers and the Claude CLI alike — the latter via `stream-json` image blocks), and every attachment is persisted, so it's still there when you reopen the chat thread or a saved generation draft.
- **Bulk edits in Suite Chat.** When a change spans many cases, the assistant proposes them as a single card with a checkbox per edit and an expandable diff for each. Apply the whole batch with "Apply all" or cherry-pick with "Apply selected" — one failing edit doesn't abort the rest, and a partially-applied batch stays marked when you reopen the chat. Referenced `#case` chips are clickable.
- **"What the last refine changed."** A review-tab panel diffs the pre-refine draft against the current one — field-labeled per case (description + step diffs) and per bug (severity + repro-steps) — and the snapshot persists in the saved draft, so the panel survives reopening a run from history.
- **Live-streaming Ask chat.** The generator's review-pane Ask panel now streams tokens into the assistant bubble (caret + thinking dots) with a stop button, matching the Suite Chat and Code Review surfaces.
- **Existing suite cases as generation context.** Analyze now feeds the target suite's existing cases — with their steps, capped at 20 — to the model, so it reads prior coverage and writes complementary, style-matched cases instead of deduping on titles alone.
- **Generation History context menu.** Right-click a run to open it in review, open its publish summary, copy the spec, copy case & bug titles, or delete it. Duplicating a review/done generation now confirms first, since the copy becomes its own publishable History entry.

- **The generator prompt demands exact, value-level reproduction steps** and treats the generated cases & bugs as a deliberately-ordered list.
- **Dark mode eases off pure black** toward a softer near-black for more comfortable contrast.

- **Duplicating a generator tab** now clones the full live draft (phase, publish log, cases, bugs, refine snapshot) into an independent session with a fresh run id — instead of dropping you on an empty input form — and the copy survives a reload. Duplicating a deduped tab (test case / bug / code-viewer / Suite Chat) now actually creates a distinct copy instead of reactivating the original.
- **Reopening a draft or published run after a window reload** no longer snaps back to an empty input form.
- **Opening a case from a Suite Chat link** now carries its plan + suite, so the Execute dropdown targets the right test point instead of falling back to the suite picker.
- **The copy tooltip** no longer promises a link on an unpublished draft.

- **Stale-case detection.** The per-branch staleness scanner, the Stale sidebar queue, the "Mark for review" action, and the related command-palette entries and `Ctrl+Shift+S` shortcut are gone. Branch awareness in the status bar and the branch-aware code-link chips on published cases are unaffected — the tracking-branch setting now solely drives those code links.

## [0.3.2] - 2026-05-25

- **Title bar no longer sticks to the cursor.** Clicking the window title bar could drop the window into a drag that kept following the pointer after the mouse button was released. Window dragging now begins only after real pointer movement, so a plain click stays a click.
- **Terminal falls back to an installed shell.** When the saved default-shell path didn't exist on the current machine (settings copied between devices, a different OS, or a moved binary), opening a terminal failed outright. It now falls back to the platform's default shell so a terminal tab always opens.

## [0.3.1] - 2026-05-24

- **Updater toast no longer fills the workspace height when expanded.** Clicking "Show all N changes" on a release with a long changelog used to stretch the bottom-left toast all the way to the top of the workspace. The sections list is now capped at `min(55vh, 420px)` with internal scrolling, so the card stays a glanceable corner notification even on releases with a lot of changes.

## [0.3.0] - 2026-05-24

This release lands two big new surfaces — an embedded terminal and an AI code-review pane — on top of a full workspace tab system rewrite (drag-to-split, recursive panes, persistent reorder/pin), multi-thread persistent Suite Chat with real code grounding, and a Settings UI scale slider. Plus the usual basket of fixes.


- **Embedded terminal (developer mode).** `xterm.js` pane backed by a Rust `portable-pty` driver. Open from the sidebar, the command palette, an in-strip "+" launcher, or `Ctrl+Shift+`` `. Per-pane shell picker (PowerShell / cmd / bash / zsh / fish / Git Bash) renders real brand marks. Quick-Prompts strip with CLI-aware starter prompts that detect the active Claude / Codex / Cursor / Gemini CLI and resolve the source-dir's *real* git default branch. UTF-8 forced on cmd.exe so non-ASCII output renders. Right-click context menu, copy/paste/clear actions, and clean app-close + tab-close lifecycle. Sessions survive pane splits / merges because xterm + the PTY live outside the React lifecycle (module-scoped registry, DOM-move on re-attach). Concurrent-session cap raised from 8 → 16 with synchronous slot release on kill.
- **Code Review pane.** BYOK-grounded review of your current branch diff against a chosen base (defaults to the real default branch, never main-when-you're-on-trunk-flow). Chat-style composer matching Suite Chat — message bubbles, suggested prompts, send/stop, model picker filtered to providers that actually have an API key, branch picker with fuzzy search. **Apply-able patch cards** — when the model proposes an edit, it renders as a click-to-write card; applying patches is now the default surface, not optional. Threads persist in SQLite and surface in the new **Chats** sidebar. Multiple Review tabs can be open at once. ADO marks now come from `@thesvg/react` instead of inline SVG.
- **Workspace tab system rewrite.** A recursive pane renderer replaces five kind-specific stacks. Drag tabs to reorder within a strip, drop them on another pane to move, drop into a leaf's edge zones to split horizontally or vertically; `Ctrl`-drag clones instead of moving. Keyboard splits / focus / move shortcuts. Pin, duplicate, close-others / close-right / close-all, jump-to-N (`Ctrl+1`…`Ctrl+9`), reopen-closed. "+" launcher in three surfaces (sidebar, top bar, in-strip) with Generate + terminal-action shortcuts in the popover. Per-cell store subscriptions for tab state so opening a tab doesn't re-render every other tab.
- **Multi-thread Suite Chat with code grounding.** Each ADO suite now owns multiple persistent threads (SQLite-backed) — keep regression sweeps, exploratory chats, and bug triage separate without context bleed. A "Narrow AI scope" pill replaces the old ambiguous search box; each thread opens in its own tab from the history sidebar. The BYOK runner now has real `fs` tools (read / grep / glob / write) wired in, so the model can actually look at your code instead of pretending. Apply pipeline now covers **create-case** and **delete-case** alongside the existing **devops-edit** flow — proposed ADO mutations land as inline cards you click to apply.
- **Editable test-case steps in TestCasePane.** Click any step to edit in place; the table is stable across edits and keeps focus.
- **Reopen-and-republish drafts.** Generation history rows now open back into the review draft and re-publishing is idempotent — no more duplicate cases on a second click.
- **UI scale slider** (Settings → General → Accessibility). Independent of the OS zoom, 80% floor so dense panes stay readable. The settings window no longer rescales itself when you drag the slider.
- **shadcn `Kbd` / `KbdGroup`** rendering everywhere shortcuts appear — sleeker, more compact, no more context-menu line wrap.
- **`ContextMenuItem` `icon` + `description` props** for Linear/Raycast-style two-line menu rows (label on top, 10.5 px muted subtitle underneath). Use instead of nesting a Tooltip on a Radix menu item.
- **`BranchPicker` shared component** — cmdk Combobox in a Popover, fuzzy search, height-capped at 280 px. Reused by Code Review and Azure DevOps settings.
- **`ProviderIcon` picks real brand marks where available** — simple-icons for Anthropic / Vercel / Google / Mistral / Ollama / OpenRouter / DeepSeek and shell marks (PowerShell from thesvg.org, bash / zsh / fish / Git Bash from simple-icons), with the hugeicons stroke set as a clearly-labelled fallback only for providers without a registered brand (OpenAI, xAI, Cerebras, Groq, LM Studio).
- **Cursor** added to the AI CLI picker in the top bar.


- **Suite-chat render loop** in the `boundThread` activation effect — the pane no longer spins on first open.
- **Suite-chat deleting the active thread** no longer leaves the pane stuck in skeleton state forever.
- **Tab strip overflow** scrolls horizontally without showing a visible scrollbar; in-strip "+" launcher actually opens and sits next to the last tab.
- **Tabs context menu** — right-click now opens; cross-leaf split-leaf now actually moves the tab; drop targets gained nicer focus / drop hints; the focused-pane inset ring was dropped.
- **PTY capacity-slot leak** — slot is freed synchronously on `kill` instead of waiting on the async exit signal. Cap raised to 16. PTY error messages are now readable (the OS error number is wrapped with context) instead of opaque codes leaking through.
- **Terminal quick-prompt clear** — switched from `Ctrl+U` to backspace tracking (Ctrl+U was triggering cmd.exe's command-history menu). Quick prompts now send a single explicit `Ctrl+U` before typing so the prompt isn't appended to stale input.
- **Terminal re-attach** moves the xterm DOM node instead of re-instantiating, so React unmount/remount no longer wipes scrollback or kills the shell.
- **Code-review model picker** is filtered to providers that have an API key configured — no more selecting a model the runner will immediately fail on.
- **Generator narrow-column layout** — 2-column input breakpoint bumped from `@xl` to `@3xl`; container-query responsive layout means a generator tab in a narrow split pane lays out as one column instead of overflowing.
- **Steps-table editing stability** + settings dialog corner radius + scroll gutter alignment.
- **AI / tabs missing-key copy** is now generic instead of mentioning a specific provider that may not be the one you tried to use. Duplicate pin glyph removed from the tab strip.
- **Native webview zoom** wired correctly — 80% lower bound; settings window no longer rescales itself when you change app-wide zoom.


- **Apply-able patches are the default** in Code Review — not behind a feature flag, not an opt-in surface.
- **Review chat** promoted from floating FAB → right-side drawer → flex sibling controlled by `GeneratorPane`, so it survives layout changes and respects pane resizing.
- **Top-bar "+" launcher** dedup — drop the duplicate entry; the sidebar / top-bar / in-strip launchers now share one popover.
- **Suite Chat header** simplified — clearer thread switcher, send-arrow composer that matches Code Review.
- **Tab context menu** trimmed to labels only (no descriptions) — descriptions live on the new ContextMenuItem two-line pattern instead, used where the label isn't self-explanatory.
- **Settings → Models default-model picker** stays in sync across the main and settings windows via the prefs bridge (`emitGenerationBusy` / `onGenerationBusy`).
- **Generator Changesets / Scope Notes field** folded into the Requirements field — one place to paste your spec instead of two near-identical text areas.
- **Branch awareness across panes** — `$current` sentinel resolves at scan-time from the live source-dir branch; quick prompts and code-review base default to the real default branch instead of hard-coded `main`.


- **Generator Changesets / Scope Notes field** as a separate input — its content lives inside Requirements now.
- **Duplicate "+" launcher** in the top bar (one launcher, three surfaces).
- **Floating Q&A FAB** over the review draft — promoted to a docked sibling, see Changed.

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
