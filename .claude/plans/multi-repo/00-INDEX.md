# Multi-repo workspaces — execution index

**Read this file plus the phase file you're executing. Nothing else is needed.**

## Why

The app binds everything to one source directory: `Preferences.sourceRoot: string | null`
(`src/modules/settings/store.ts:122`), read from ~23 places across 31 files.

Real work spans repos. Whenever the code behind one feature lives in more than one repository,
pointing the app at a single one truncates coverage: the analyzer only sees part of the feature, so
it either writes cases for that part alone or finds nothing relevant and returns an empty batch.
Switching to the other repo inverts the problem. Either way coverage is silently lost, and the user
has no signal that it happened. Commit Review has the same hole — a change spanning repos can never
be reviewed as one change.

**Outcome:** a flat list of source repos. Every code-reading surface sees all of them (narrowable per
run), code links resolve to the correct ADO repo, and at exactly one repo the app looks and behaves
identically to today.

## Design principle: no assumed topology

**The solution must work for any combination of repositories, and must encode nothing about how they
relate.** Users' setups vary without limit — a service and its clients, N peer services, a library
and its consumers, a monorepo plus satellites, two repos that share nothing but a test plan, or one
repo today and six next month.

Concretely, this means:

- `WorkspaceRepo` has **no** role, kind, tier, or relationship field, and none may be added. A repo
  is a name and a path.
- **No repo is semantically special.** `repos[0]` is used as a default cwd for the terminal and as
  the clone-destination seed purely because *some* default is needed — it carries no meaning, and
  nothing may branch on position.
- Ordering is user-facing display order only. Never dependency order.
- Prompts list repos as a **flat, unannotated roster** — names and paths, nothing more. The model
  discovers how they relate by reading them, which is what the tools are for. Do not describe a repo
  as "the API", "the client", "the shared library", or anything else.
- Scope defaults to **all repos on**, because the app cannot know which repos a given spec touches.
  Narrowing is always the user's explicit act.
- Every count works: 1, 2, or 20. Nothing may assume more than one, and nothing may assume few.

Where these docs need an example, they use placeholder names — `repo-one`, `repo-two`, `repo-three`.
Do not substitute role-suggesting names in code, comments, prompts, or UI copy.

## Status

| # | Phase | File | Status | Commit |
|---|---|---|---|---|
| 1 | Custom provider: model dropdown + real Test | `01-custom-provider.md` | ☑ | `077d946` |
| 2 | Source-link format fixes | `02-source-link-format.md` | ☑ | `fbf5297` |
| 3 | Repo registry + compatibility shim | `03-repo-registry.md` | ☑ | `a4f1399` |
| 4 | Mechanical sweep: delete `sourceRoot` | `04-sourceroot-sweep.md` | ☑ | `b2cd9a4` |
| 5 | Settings: "Source repos" block | `05-settings-repos.md` | ☑ | `0801e2f` |
| 6 | Status bar: multi-repo | `06-status-bar.md` | ☐ | |
| 7 | **AI tool layer — the core fix** | `07-ai-tool-layer.md` | ☐ | |
| 8 | Prompts | `08-prompts.md` | ☐ | |
| 9 | Generator | `09-generator.md` | ☐ | |
| 10 | Commit Review | `10-commit-review.md` | ☐ | |
| 11 | Remaining surfaces | `11-remaining-surfaces.md` | ☐ | |
| 12 | ADO repo binding | `12-ado-binding.md` | ☐ | |
| 13 | Cleanup | `13-cleanup.md` | ☐ | |
| 14 | Full review + delete these docs | `14-review-and-cleanup.md` | ☐ | |

Phases 1 and 2 are independent of multi-repo and of each other. Phases 3→7 are strictly ordered.
Phases 9–12 can be reordered once 7–8 land.

### Deviations found during execution

> Record anything here that later phases must know about — a wrong line number, a file that moved, a
> decision made differently than planned. **If a phase discovers the plan is wrong, stop and record
> it here rather than improvising across phase boundaries.**

**Phase 1 — bug #11 is NOT fixed; it is only not inherited.** The plan said to fix the substring
test while porting `BranchPicker`'s not-in-list fallback into `ComboboxCreatable`, and separately said
not to touch `BranchPicker`. `ComboboxCreatable` has no `sentinel` prop (nothing in its spec needs
one), so the buggy `sentinel?.value.includes(value)` comparison has no analogue to fix — the fallback
is just `if (value && !seen.has(value))`. **`BranchPicker.tsx:91` still ships the substring test.**
Whoever runs Phase 14 should either fix it there or strike it from the bug table — do not read the
Phase 1 commit as having closed it.

**Phase 1 — verification is partial.** Automated checks all pass (`tsc` clean, 922 frontend tests,
134 Rust tests incl. 5 new `extract_model_ids` cases, `vite build` clean). The plan's Verify steps
1–5 need a live OpenAI-compatible endpoint plus a valid and an invalid key, which this session had
no access to. **Those five are unrun**, not passed.

**Phase 2 — the plan's claim that branch and sha "are null together" is wrong.** `git.rs`
`read_info:70-72` derives `detached = branch.is_none() && commit.is_some()`, so a detached HEAD has
a real commit and no branch. The two gates were therefore NOT equivalent, and unifying them by
tightening the bug gate would have silently dropped a true commit. They were unified the other way:
one shared opt-in gate (`tagSourceBranch`), with each field stamping only what actually resolved.
Pinned by `useGenerationSession.provenance.test.ts`.

**Phase 2 — `resolveTrackingBranch` is now orphaned.** Publish was its last production caller; it
only ever mapped `$current` → the working-dir branch with a `main` fallback that the stamp guard
made unreachable. `src/modules/git/trackingBranch.ts` and its test still exist and `tsc` is clean —
**Phase 13 should decide** whether multi-repo branch resolution reuses it or deletes it.
`CURRENT_BRANCH_SENTINEL` is still live (`AzureDevOpsSection.tsx:142`).

**Phase 2 — CLAUDE.md's branch-awareness paragraph was corrected**, not just the code: it claimed
published links fall back to `main` on a detached HEAD / non-repo, which the `&& sourceDirBranch`
guard already prevented.

**Phase 3 — `Preferences.sourceRoot` is now DERIVED, and `setSourceRoot` writes the registry.**
The plan said to stop writing `KEY_SOURCE_ROOT` but left the existing setter unmentioned. Leaving it
writing the legacy key would have broken Phase 4's "behaviour-preserving by construction" claim:
once reads flip to the registry, nothing reads that key, so picking a source folder (`App.tsx:907`)
and cloning (`cloneProgressStore.ts:219`) would silently stop working. So:

- `loadPreferences` computes `sourceRoot: primaryRepoRoot(repos)`. Nothing writes `KEY_SOURCE_ROOT`.
- `writeRepos` (the one path every registry write goes through) emits a **second**
  `PREFS_CHANGED_EVENT` for `sourceRoot` so the derived value stays live cross-window. That is why
  `[KEY_SOURCE_ROOT]: "sourceRoot"` is still in the key map for a key that is no longer stored.
- `setSourceRoot` collapses the registry to the one folder handed in, reusing the existing entry
  when the root is unchanged so its id and ADO binding survive a re-pick.

**Phase 4 therefore deletes three things together**: the `sourceRoot` field, the second `emit` in
`writeRepos`, and the `[KEY_SOURCE_ROOT]` key-map entry. It should NOT need to touch `setSourceRoot`
— Phase 6 still replaces its clone caller with an append, as planned.

**Phase 3 — a launched folder is registered, not dropped.** The plan seeds only when the registry is
empty, which would have made the "Open in DevOps Studio" shell verb a silent no-op for anyone who
already has a repo (today it overrides the single root). `loadRepos` now registers the launched
folder and moves it to the front, so the single-root surfaces still see it. Consequence worth
knowing: the launched folder now **persists**, where before it was session-only — the registry has
no session-scoped entry.

**Phase 3 — validation normalises instead of rejecting, and runs on read as well as write.**
Rejecting inside `setRepos` cannot stop a malformed payload, because `preferences.ts` blind-sets
whatever a change event carries and a hand-edited settings file bypasses setters entirely. So
`normalizeRepos` runs on load and on every write: drops entries with no root, drops repeats of a
root (separator- and case-insensitive), mints missing ids, drops malformed `ado`, and forces names
unique and slug-safe. **Phase 5's inline validation is still the UX** — this only ever fires on a bug.

**Phase 3 — what later phases can import** from `settings/store.ts`: `normalizeRepos`, `createRepo`,
`repoBasename`, `sanitizeRepoName`, `uniqueRepoName`, `primaryRepoRoot`, and the setters `setRepos` /
`addRepo` / `removeRepo` / `renameRepo` / `setRepoAdo`. `addRepo` returns the entry already covering
a root instead of adding a second one, so Phase 5's "Add folder…" and Phase 6's clone-append can
call it blindly. `usePrimaryRepoRoot()` and `getRepos()` are in `settings/preferences.ts`.

**Phase 3 — verification.** `tsc` clean, `vite build` clean, 969 frontend tests green (25 new in
`settings/repos.test.ts`, each assertion proven by mutating the source). Verify steps 1–4 need a
running app; see the phase report.

**Phase 4 — the prop drill was the only structural change; everything else was one-for-one.** All
19 read sites became `usePrimaryRepoRoot()` or `primaryRepoRoot(…)`. Where the call site already
held a `usePreferencesStore.getState()` snapshot (`prefs`), the read is `primaryRepoRoot(prefs.repos)`
rather than the plan's `primaryRepoRoot(getRepos())` — same function, but it stays inside the one
snapshot the surrounding code already took instead of re-entering the store mid-function.

**Phase 4 — `KEY_SOURCE_ROOT` survives, deliberately.** The plan's "delete three things together"
note covers the `Preferences` field, the second `emit` in `writeRepos`, and the key-map entry — all
three are gone. The `const KEY_SOURCE_ROOT` itself stays, because `loadRepos` still reads the legacy
key once to seed the registry. **Phase 13 owns retiring that migration**, not this phase.

**Phase 4 — dropping the derived emit did not cost cross-window liveness.** Every consumer now
derives from `repos`, which `writeRepos` still emits through `writePref`. Pinned by
`repos.test.ts` "emits on every registry write", whose narrowed assertion was proven by mutation
(restoring the second emit fails it).

**Phase 4 — `BugPane`'s `sourceRoot` prop is gone, not just unthreaded.** It now calls
`usePrimaryRepoRoot()` itself, so `TabContent` / `LeafPane` / `PaneTreeRenderer` carry no root at
all. `StatusBarGit`, `CommandPalette`, `LaunchMenu` and `GetSourceCodeDialog` keep their `sourceRoot`
props — those come straight from `App.tsx`'s own hook and are Phase 6/11's to change.

**Phase 4 — verification.** `tsc` clean, `vite build` clean, 969 frontend tests green (no new
tests; this phase is behaviour-preserving, so the existing suite is the regression net). No Rust
touched. **Verify step 3 — the live walkthrough of every surface — is unrun**, not passed.

**Phase 5 — the block lives in its own file**, `src/settings/sections/SourceReposSection.tsx`,
exporting `SourceReposPanel`. It is still the 7th block of General exactly as planned — General
renders `<Label>Source repos</Label>` (the file-local helper, as instructed) wrapping the panel.
Splitting it follows the `BestPracticesPanel` precedent (own file, rendered as a block of Models)
and keeps `GeneralSection.tsx` from doubling in size.

**Phase 5 — "Set ADO repo…" is NOT in the `⋯` menu.** The plan allowed present-but-disabled or
deferred; deferred won, because a disabled item with no explanation is the "menu item that silently
does nothing" the plan warns against. The ADO cell still renders "not linked" as specified, with a
tooltip saying code links can't deep-link yet. **Phase 12 adds the menu item**, next to `Rename` and
above `Remove from workspace`.

**Phase 5 — name validation is `validateRepoName` in `settings/store.ts`**, not local to the
component, so the UX rule and the `uniqueRepoName` backstop can't drift. Phase 12+ should reuse it
for any other repo-name entry point. Rename commits on **blur/Enter, never per keystroke** —
`renameRepo` re-uniquifies, so live-writing turns "repo" into "repo-2" under the user's cursor the
moment the typed prefix momentarily collides.

**Phase 5 — `fs_stat` on `<dir>/.git` is the repo test in "Scan a folder…"**, not a `.git`
directory listing, because a worktree or submodule stores `.git` as a FILE. Both spellings are a
real repo, and `fs_stat` accepts either. Paths are joined with the separator the parent already
uses, so a Windows root doesn't come back half-forward-slashed and miss the registry's dedup key.

**Phase 5 — verification is REAL, including the live steps.** `tsc` clean, `vite build` clean, 974
frontend tests green (+5 new; the three substantive assertions each proven by mutating
`validateRepoName` — dropping the empty check, neutering the separator check, and making uniqueness
case-sensitive each fail exactly one test). Verify steps 3, 4, and the empty state were driven in
the **real settings webview** over CDP against a mocked Tauri IPC boundary (fixture: 3 repos, one
detached, one non-git). Confirmed: duplicate rename → inline error + `aria-invalid`, nothing
persisted; valid rename persists; scan lists exactly the git dirs and marks already-registered ones
disabled/"already added"; confirm adds only the new roots; zero console errors throughout.
**Verify step 2 (cross-window liveness) is the one still unrun** — it needs two real Tauri windows,
which the browser harness can't provide. The `repos` key-map entry it depends on is pinned by
`repos.test.ts` "maps the repos key so the other window's write lands in the store".

---

## Shared: the data model

```ts
// src/modules/settings/store.ts — added in Phase 3
export type WorkspaceRepo = {
  /** Stable id. Survives rename and path move. Generated on add. */
  id: string;
  /** Display name AND the namespace the AI addresses files through.
   *  Unique across the list, slug-safe (no "/"). Defaults to the folder basename. */
  name: string;
  /** Absolute path to the repo root. */
  root: string;
  /** ADO binding for published code links. null until resolved. */
  ado: { repoId: string; repoName: string; project: string } | null;
};
```

Preference key `repos: WorkspaceRepo[]` **replaces** `sourceRoot`. Flat list — no named workspace
profiles, no "active repo" concept.

### AI addressing: repo-prefixed virtual paths

Every path the model reads or emits is `<repoName>/<path-within-repo>`, **always**, including at
N=1. One code path, one prompt, no behavioural fork, and every emitted path round-trips into a repo
binding. The user never sees the prefix — it is stripped at publish time and when opening the viewer.

Resolution is one function, added in Phase 7 — the single containment point for the whole app:

```ts
// src/modules/ai/lib/repoPaths.ts
resolveRepoPath(input: string, repos: WorkspaceRepo[]):
  | { ok: true; repo: WorkspaceRepo; absPath: string; virtualPath: string; corrected?: string }
  | { ok: false; reason: string }
```

1. Normalise separators, strip leading `./`.
2. **Absolute** → find the repo whose `root` is a path prefix (case-insensitive on Windows).
   No match → **reject**.
3. First segment matches a repo `name` (case-insensitive) → that repo + remainder.
4. Exactly one repo configured → that repo + the whole path (tolerates a forgotten prefix).
5. N > 1, no prefix → probe each repo with `fs_stat` (`src-tauri/src/modules/fs/file.rs:204-205`,
   registered `lib.rs:535`). **`fs_stat` REJECTS on a missing path** — it does not return null — so
   the probe must `.catch(() => null)` per repo (precedent: `BestPracticesSection.tsx:75`).
   Exactly one hit → use it and set `corrected` so the tool result echoes the canonical prefixed
   path back. Zero or several → `{ ok: false }` naming the candidates.
6. After joining, re-normalise and reject anything escaping its repo root (`..` traversal).
7. Run `checkReadable(absPath)` — `src/modules/ai/lib/security.ts:198`, signature
   `(path: string) => SafetyResult` (`:129`). Four gates: empty/non-string, control bytes, 21 secret
   basename patterns, 25 protected dirs. Written, tested (`security.test.ts`), currently unreachable.

> `ai/tools/fs.ts` and `search.ts` import `checkReadableCanonical`, **not** `checkReadable` — but
> both are dead files (Phase 13). `checkReadable` is right here because `resolveRepoPath` has already
> produced an absolute path.

---

## Shared: ground rules

- One phase, one commit, per CLAUDE.md. Conventional-commit subject.
- Do **not** regenerate shadcn components. Do **not** reintroduce WSL code.
- Comments only where there's a non-obvious *why*. Don't restate the code.
- Icon-only buttons need a `<Tooltip>`; context-menu items take `icon` + `description` props, never
  a nested tooltip (Radix portals fight).
- Skeleton loaders, not spinners.
- Type scale caps at 13 px; mono micro-badges 9.5 px; inline mono refs bottom out at 10.5 px.
- Any new Windows subprocess spawn must hide the console window (`hide_console()` in `git.rs`).
- New Tauri commands go in `tauri::generate_handler![...]` in `src-tauri/src/lib.rs`.
- UI must be minimal, self-explanatory, and match the existing surfaces — copy `SuiteChatPane` /
  `CodeReviewPane` patterns rather than inventing.

---

## Shared: what is already multi-repo ready — do not re-do

The Rust backend needs exactly **one** change in this whole plan (`remote_url` on `GitRepoInfo`,
Phase 12) plus the Phase 1 provider command.

| Layer | State |
|---|---|
| `fs_*` commands (`src-tauri/src/modules/fs/`) | Every one takes an explicit `path`/`root`. Calling with N roots works today. |
| `git_*` (`git.rs`, `git_ops.rs`) | Every one takes an explicit `cwd`/`path`. |
| `run_readonly_command_cmd` (`command.rs:368`) | Takes an explicit `root`; its no-absolute-paths rule (`is_absolute_path`, `:302`) is what confines it. |
| `ai_checkpoints` SQLite (`ai_checkpoints.rs:209-215`) | `cwd` is free-form TEXT with SQL filtering — a generic scope key. |
| `commit_reviews` SQLite (`commit_review.rs:62-64`) | `cwd` is `TEXT NOT NULL`, no constraint. Adjacent `commits TEXT` (`:110`) is already "Opaque JSON" — same trick, **no schema migration**. |
| Tab store | `cwd` already exists on `commit-review` and `terminal` tabs. |
| `resolveSourcePath` / `resolveSourcePathDeep` | Already take `sourceRoot` as a **parameter**; only callers hardcode the global pref. |
| `GetSourceCodeDialog.tsx:112-273` | Already clones N repos into one parent. |

---

## Shared: surfaces deliberately unchanged

Verified — no repo dimension. Don't go hunting.

| Surface | Why |
|---|---|
| `src/modules/search/useSearchIndex.ts` | Despite the name, not a filesystem search — it indexes the ADO test-plans zustand cache (`:38-71`). Only consumer is the command palette. |
| `src/modules/sidebar/` | Three views (Plans / History / Chats). No repo tree. |
| `SuiteChatTab` (`tabs/store/types.ts:40-52`) | Scope is per message, not per thread. |
| `ai/lib/taskRunner.ts` | Repo-agnostic by design (`:16-19`): `TaskInput.tools` is an opaque `ToolSet`, `TaskCheckpoint` (`:91-106`) holds no path. |
| `ai/config.ts` budgets | `SURFACE_STEP_CAPS` / `SURFACE_TOKEN_BUDGETS` stay as-is. |
| `workspace.rs` `WorkspaceEnv` | Vestigial single-variant enum threaded through 10 Rust signatures. |
| Updater, theme, shortcuts, PTY driver | No repo dimension. |

---

## Shared: pre-existing bugs this plan fixes

Found during plan verification. All live today; each is fixed in the phase that already touches its
code — don't fix them opportunistically elsewhere.

| # | Bug | Phase |
|---|---|---|
| 1 | `sourceLinksParser` escapes every `/` to U+2215 and never unescapes (`:109-112`) — every published path and slashed branch is corrupted on read, so **every ADO deep link from a source link is already dead**. Zero test coverage on that file. | 2 |
| 2 | An empty `branch:` value drops the entire link (`parseLine:82,84`) — "Tag with source branch" off, or a non-git/detached dir, publishes a block the app can't read back. | 2 |
| 3 | `generationSha` hardcoded `""` (`useGenerationSession.ts:3884`) though `sourceDirSha` is captured at `:2672`. | 2 |
| 4 | `ApplyPatchCard.tsx:65` reads the global `sourceRoot`, not the review tab's `cwd` — already writes patches into the wrong repo. | 10 |
| 5 | The AI tool layer has **no path containment**. `suiteChatTools.ts:506-507` claims the Rust side enforces a boundary — false; `workspace.rs:31-33` `resolve_path` is identity. | 7 |
| 6 | `QuickPromptsStrip.tsx:62,76` reads the global pref, not the terminal's own `cwd`. | 11 |
| 7 | `openSettingsWindow("general")` (`App.tsx:502`) is a dead end — General has no source-directory control. | 5 |
| 8 | `App.tsx:1482-1486` reopens a saved commit review with no cwd, binding it to whatever repo is current. Same at `:951`, `:1601`. | 10 |
| 9 | `useSourceDirStatus` ignores any cwd (`:21`) while `StatusBarGit` takes `sourceRoot` as a prop — split source of truth. | 6 |
| 10 | `useSourceDirGitInfo:71` listens on the Tauri bus, `useSourceDirStatus:55` on the DOM event only — cross-window refresh silently half-works. | 6 |
| 11 | `BranchPicker.tsx:91-94` uses a substring test where equality is meant. | 1 |
