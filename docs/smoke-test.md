# Manual smoke test — single-BYOK-engine milestone

Run after `pnpm tauri dev`. Each item: **what changed · how to trigger · expected**.
Tick the box once you've confirmed it by hand. Automated coverage (`pnpm test`,
`cargo build`, `pnpm build`) is green; this file is the human-in-the-loop pass
the automated tests can't do.

## Engine consolidation

- [ ] **No engine/auth UI.** Settings → Models shows provider key fields and a
  single default-model picker — **no** "AI engine" selector, no Claude
  OAuth/auth-mode controls. *(The whole Claude-CLI engine + its settings were
  removed.)*
- [ ] **Runs on a non-Anthropic model.** Set the default model to an OpenAI (or
  Google) model with a key configured. Generate cases, open Suite Chat, run a
  Code Review, run a Confidence check — all four work. *(Everything routes
  through the one Vercel/BYOK runner.)*
- [ ] **Old settings migrate silently.** Launch with a pre-existing
  `devops-studio-settings.json` that still has `aiEngine` / `claudeAuthMode`
  keys → no console errors; those keys are scrubbed from the file on load.

## Global code-search toggle

- [ ] **Toggle exists, default on.** Settings → Azure DevOps → Defaults shows
  **"Allow AI to read source code"** (on by default) with a hint.
- [ ] **On →** Generator activity log shows the analyzer reading / grepping the
  source dir; generated cases cite real `file:line`. Suite Chat / Code Review
  likewise read code.
- [ ] **Off →** regenerate / re-ask: the activity log shows **no** file reads;
  the model works from spec / diff / case text alone. RefineComposer's
  "code-search: off" chip reflects it.

## Reliability

- [ ] **Generator — schema + salvage.** Generate cases; they arrive as a clean
  `DraftBatch`. (If the model emits one malformed case the rest still come
  through — partial-batch salvage; check the console for a "dropped … case"
  log only in that case.)
- [ ] **Confidence — manual-test caveat.** Run the confidence analyzer on a case
  whose steps the model can't fully ground in code. A high score (≥90 Pass)
  with an ungrounded step shows the **"manual test recommended"** caveat.
- [ ] **Code Review — patches + malformed guard.** Review a branch diff → emits
  `Apply` patch cards. Clicking **Apply** writes the file (proves
  `fs_write_file` + `ApplyPatchCard` survived). A malformed `code-review-patch`
  block renders an amber **"Skipped a malformed patch block"** warning, not a
  broken card.
- [ ] **Suite Chat — edit guard.** Ask for a change → a valid `devops-edit`
  Apply card appears. A malformed / unknown-kind edit block renders an amber
  **"Skipped a malformed edit block"** warning instead.

## Depth

- [ ] **Generator reads code.** Point at a medium repo with code search on;
  generate. The activity log shows Read/Grep calls and the model chases context
  across files (it no longer guesses from the spec alone — this is the headline
  BYOK depth change).

## Regression

- [ ] **No console errors** referencing deleted modules (`claude`, `engine`,
  `planStore`, `transport`, `sessions`, `compact`).
- [ ] **Status-bar model picker** still drives the default model; per-run
  override in the generator still works.

---

## Deferred (NOT in this milestone — verify these are simply absent, not broken)

These plan items were intentionally deferred to protect quality / scope; they
are documented follow-ups, not regressions:

- **First-run provider/key modal** + Settings reorg (mode/tagSourceBranch →
  session-defaults, local models → Advanced, Models→AI tab rename). *(Phase 7.)*
  Today: configure keys via Settings → Models as before.
- **Repo-map primer** context block + **ripgrep context lines** (grep
  `-A`/`-B`). *(Phase 6 #2/#3.)* Code reading works without them.
- **Post-hoc citation verification** + `unverified-ref` badge in code review.
  *(Phase 4 code-review.)* Citations render as normal clickable chips.

---

## Changes summary (for cross-checking during QA)

**Added**
- `ai/lib/taskRunner.ts` — shared `runTask`/`streamTask` (Vercel-only; text /
  structured-object / structured-with-tools modes; repair + circuit breaker).
- `ai/lib/systemPrompts.ts` — central prompt barrel.
- `ai/lib/extractJson.ts` — shared JSON-block slicer.
- `code-review/patchSchema.ts` — Zod `PatchSchema` + `parsePatch`.
- `config.ts` `SURFACE_STEP_CAPS`; `settings` `codeSearchEnabled` pref + toggle.
- Tests: `taskRunner`, `systemPrompts`, `qaAnalystRun`, `patchSchema`,
  `parseEdit`, `codeSearchPref`; extended `draftBatchSchema` + `confidenceAggregate`.

**Changed**
- All four surfaces route through the runner with schema-validated output +
  `temperature: 0`. Generator analyzer now gets read-only source tools.
- Read window raised to 1500 lines / 24 KB. Identifiers de-prefixed
  (`*Task` names, `stepToActivity`).

**Removed**
- Claude Code CLI engine: `claude.rs` + 6 `claude_*` commands, `ai/lib/claude*`,
  `qaAnalystRunClaude.ts`, `AiEngineSection.tsx`, `ai/lib/engine.ts`,
  `aiEngine`/`claudeAuthMode` prefs.
- Dead general-agent stack: `planStore`, `todoStore`, `transport`,
  `slashCommands`, `subagent`, `agents/*`, `agentsStore`, plus `sessions.ts` +
  `compact.ts`. Write/edit/bash/delegation tools. Per-run `allowCodeSearch`.
