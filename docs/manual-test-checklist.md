# Manual Test Checklist

Automated tests (`pnpm test`) cover the pure logic — batch parsing, bug→case
linking, confidence readiness, branch resolution, tab-tree ops, security rules,
context blocks. The items below need a running app (webview UI), a live Azure
DevOps org, or a real PTY, so they can't run headless. Work through them before
cutting a release. **★ = touched in the audit pass — re-test these first.**

## Azure DevOps connection
- [ ] Settings → Azure DevOps: save org URL + project + PAT → status bar shows connected.
- [ ] Change a setting in the Settings window → the main window's ADO status reflects it (within 30s or on focus). ★
- [ ] Bad PAT → clear "PAT was rejected (401)" error, not a generic failure.
- [ ] Org requiring SSO → "SSO required" hint (not a JSON parse error). ★

## Generator — end to end
- [ ] Paste a spec, pick plan + suite, generate (Vercel engine) → cases + bugs in review.
- [ ] Generate with Claude engine + "Let the analyzer read source code" on → cases grounded in real files.
- [ ] **Skip an early case, then publish** → every kept bug links to its *correct* parent case (not shifted). ★ (regression-tested in `bugLinking.test.ts`)
- [ ] Edit a case's steps after evaluating confidence → the chip resets to "Evaluate" (no stale %). ★
- [ ] "Tag with source branch" ON (default) → published case code links carry the branch; bug code refs carry the commit. ★
- [ ] "Tag with source branch" OFF → no branch on cases, no commit chip on bugs. ★
- [ ] Toggle hidden when the source dir isn't a git repo. ★
- [ ] Re-publish after a partial failure → no duplicate work items (idempotent); only failed/new items retry.
- [ ] Publish a case with a run outcome → the test point gets the outcome; if it fails, the row shows the warning text (still green dot).
- [ ] Model returns malformed JSON → console warns "could not parse model batch response"; UI shows empty review, not a silent hang. ★

## Suite chat
- [ ] Open a suite chat → context chip shows "N cases · M items"; **no separate "N cases" text beside it.** ★
- [ ] Type in "Narrow AI scope" on a >5-case suite → chip count updates; "filtered · N in suite" appears. ★
- [ ] Apply an edit (case/bug create/update) → Apply/Undo works; reload the tab → applied state persists.
- [ ] Send a message, close the tab mid-stream, reopen → the question + reply are still there.
- [ ] Multiple threads per suite via the switcher; rename/delete a thread.

## Code review
- [ ] Open Code Review on the local diff → diff loads; the diff badge tooltip reads "What the reviewer sees: N files (+X −Y), plus Read/Glob/Grep…". ★
- [ ] `git checkout` a different branch externally → the diff auto-refreshes.
- [ ] Open "Code Review" again for the same dir → focuses the existing fresh review (Duplicate clones for a parallel one).
- [ ] Apply a patch → file is written; Undo restores it.
- [ ] Switch source local ↔ ADO (commit/PR/branch); reopen from the Chats sidebar → restores the same source.

## Settings
- [ ] Azure DevOps "Defaults" section shows only the tracking-branch control (no dead default-plan field). ★
- [ ] Models tab → "Custom instructions" textarea persists and is reflected in a fresh AI run's behavior. ★
- [ ] Provider key cards: replace/remove buttons show tooltips on hover. ★
- [ ] Shortcuts: reset/clear buttons show tooltips; rebinding a shortcut updates the main window. ★
- [ ] No "Vim mode" / "Show hidden" / autocomplete toggles remain (removed as dead). ★
- [ ] An older settings file with leftover keys still loads cleanly (no crash). ★

## Terminal (developer mode)
- [ ] Open a terminal → shell spawns, no cmd.exe window flashes (Windows).
- [ ] Split the pane with an active terminal → session survives (scrollback intact).
- [ ] Open then immediately close a terminal tab during spawn → no leaked process/listener. ★

## Large data (needs a big ADO org)
- [ ] A suite with 200+ test cases → all cases load (pagination), not just the first page. ★

## Cross-platform
- [ ] Build + smoke on macOS and Linux (the secrets.rs durability tweaks were deferred; nothing platform-specific changed this pass). 
