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
| 6 | Status bar: multi-repo | `06-status-bar.md` | ☑ | `ad366e5` |
| 7 | **AI tool layer — the core fix** | `07-ai-tool-layer.md` | ☑ | `f166137` |
| 8 | Prompts | `08-prompts.md` | ☑ | `770deb1` |
| 9 | Generator | `09-generator.md` | ☑ | `77c6583` |
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

**Phase 6 — the hooks are `useReposGitInfo` / `useReposStatus` / `usePrimaryRepoGitInfo`,** all in
one new file `src/modules/git/useReposGit.ts`; `useSourceDirGitInfo.ts` and `useSourceDirStatus.ts`
are deleted. The plan named only the first two, but `useSourceDirGitInfo` had three consumers outside
the status bar (`GeneratorPane`, `ConfidenceDetailPanel`, `AzureDevOpsSection`) that still want one
repo. Making it a wrapper over the N-repo hook would have had each of them poll every repo, so it
survives as `usePrimaryRepoGitInfo` — same single-root cost, truthful name. **Phases 9 and 11 own
retargeting those three.** All three share one polling shell (`useRootPoll`), which is where the
30 s / focus / event cadence now lives once. `GitRepoInfo` + `EMPTY_REPO_INFO` + a `gitRepoInfo()`
wrapper moved to `gitOps.ts` next to the other IPC wrappers.

**Phase 6 — the event carries a nonce as well as the root.** Tauri's `emit` broadcasts back to the
emitting window, so once both hooks listen to both buses (the bug #10 fix) every git action costs
each reader **two** refreshes — i.e. 2 git spawns per repo per event. `onSourceGitChanged` (new, in
`gitOps.ts`) is the single subscribe point and collapses the echo by nonce. Pinned by
`gitOps.test.ts`, proven by mutation.

**Phase 6 — the branch segment says `3 branches`, not `3 repos`.** The plan's sketch had the folder
segment show `3 repos` and the branch segment `3 repos · 1 dirty`; driven in the real webview that
reads as the same words twice in one 20 px pill. It now shows the branch when every repo agrees on
one, `N branches` when they don't (counting a detached HEAD as its own position), and falls back to
`N repos` only when too few repos resolve a ref to say anything truthful about branches.

**Phase 6 — the post-clone source picker is deleted, not rewired.** `CloneSourceDialog.tsx` and the
`choose-source` phase are gone: asking which of N clones becomes "the source" has no meaning once
every configured repo is read. `startBatch` now appends every successful clone via `addRepo`
(sequential — it's read-modify-write) and shows "Added X" / "Added N repos". Per-repo clone failures
are still surfaced by `CloneProgressCapsule`'s tally, which is where they already were.

**Phase 6 — the multi-repo folder segment opens Settings, it does not open the picker.** The picker
writes through `setSourceRoot`, which collapses the registry to the folder chosen — at N > 1 that
would silently drop every other repo. At N ≤ 1 it is the picker, exactly as before.

**Phase 6 — `sameRoot` is now exported from `settings/store.ts`.** Matching an event-payload root
against the registry needs the same separator/case-insensitive comparison the registry dedups with.
`SourceReposSection`'s local copy was replaced by it, and its hand-rolled `useRepoBranches` poller
by `useReposGitInfo()`.

**Phase 6 — the drive-ui harness was missing `__TAURI_EVENT_PLUGIN_INTERNALS__`.** The unlisten that
`listen()` returns goes through that global, not through `invoke`, so every Tauri-bus subscriber
threw on unmount — which in React dev mode is the first thing that happens. Nothing in the Settings
General tab had subscribed before this phase, which is why it surfaced now. `tauriMock.js` provides
it, and `plugin:event|listen` now returns the callback id so unregistering actually works.

**Phase 6 — verification is REAL, including the live steps.** `tsc` clean, `vite build` clean, 987
frontend tests green (+13; every substantive assertion proven by mutating the source — a single
global op token, a confirm map that clears wholesale, a removed nonce dedup, a half-detached
unsubscribe, and an append loop that adds only the first clone each fail exactly the intended test).
Verify steps 1–4 and 6 were driven in the **real main webview** over CDP against a mocked Tauri IPC
boundary, at N=1 and at N=3 (one clean, one dirty+ahead, one detached+parked): the N=1 bar is
unchanged down to its aria-labels and its single hairline; each repo row shows its **own** branch and
state; drilling in lists that repo's branches under a header naming it; the dirty-tree dialog names
the repo; and two switches started back to back render two independent capsules, neither cancelling
the other. **Verify step 5 (a git change made from the Settings window) is the one still unrun** —
it needs two real Tauri windows; `gitOps.test.ts` pins the both-bus subscription it depends on.

**Phase 7 — the checkpoint types are renamed `…V2`, not just re-versioned.** The plan said the
version change was `CHECKPOINT_PAYLOAD_VERSION` 1 → 2 and nothing else, which would have left three
types named `GeneratorCheckpointV1` / `GeneratorRefineCheckpointV1` / `CommitReviewCheckpointV1`
declaring `v: 2`. The rename is mechanical (12 files, `tsc`-verified) and the naming convention the
codebase already uses. `checkpointApi.test.ts`'s "returns null when v is not 1" became "returns null
for a superseded payload version" and now feeds `v: 1`.

**Phase 7 — `joinPath` now re-separates the tail, and that was a live bug.** Joining a
forward-slashed relative path onto a Windows root produced `C:\repo\src/auth/x.ts` — accepted by
Windows, but two spellings of one file, which is enough that the `fs_stat` ambiguity probe missed a
path it had just built. `resolveRepoPath` emits the root's own separator throughout. Found by
driving the real tool layer in the webview, NOT by the unit tests, which had encoded the mixed form
as expected. Anything comparing a resolved path against a fixture must use the root's separator.

**Phase 7 — `path` echoes what the model sent; `corrected` carries the canonical form.** Only when
they differ. The plan said "echo `corrected` when a prefix was inferred" and left the shape open;
duplicating the same string into two keys reads as noise, so `read_file`'s result keeps its existing
`path: <what you asked for>` and adds `corrected: "<repo>/<path>"` when the resolver had to work for
it. Phase 8's prompt should not promise a different shape.

**Phase 7 — `grep` did NOT gain a `repo` param; `run_command` did.** Per the plan. A grep spans every
repo and is narrowed with `glob`, which is matched **inside each repo** against that repo's own root
— so a `<repo>/…` prefix in a glob matches nothing. `emptyScanHint` now says that explicitly,
because it is the trap a model walks into first. If Phases 9–11 find the model still fighting it,
adding an optional `repo` to grep is the fix, not changing the glob semantics.

**Phase 7 — a per-repo failure travels as data, not as a thrown error.** One unreadable root (moved,
unmounted, deleted from disk but still in the registry) must not take code search down for the repos
that do answer. `grep` and `list_files` return their hits plus `errors: [{repo, error}]`. This wasn't
in the plan and is load-bearing at N > 1.

**Phase 7 — `renderRepoRoster` (in `repoPaths.ts`) is the shared prompt block.** `runSuiteChat` and
`runConfidenceEval` had a `Source directory: <root>` line that would have been a lie at N > 1, so
both now render the flat name+path roster. **That is the only prompt text this phase touched** —
Phase 8 still owns the addressing-rule paragraph and the other four prompt sites, and should build
on this helper rather than a fourth copy.

**Phase 7 — `cleanPathArg` moved to `repoPaths.ts`** (exported) and `suiteChatTools` imports it.
`resolvePathHint` and the local `joinPath` are gone. `activityLog.ts` still mirrors the
quote-stripping deliberately, to stay dependency-free.

**Phase 7 — `evaluateCaseConfidence` still resolves ONE root for provenance.** `sourceSha` /
`sourceBranch` stamp a single repo's HEAD (`primaryRepoRoot`), while the tools now read all of them.
A verdict graded across three repos is therefore stamped stale by one repo's movement. **Phase 11
owns** deciding whether that stamp becomes per-repo or is dropped.

**Phase 7 — verification.** `tsc` clean, `vite build` clean, 1023 frontend tests green (+36; 19 new
in `repoPaths.test.ts`, 17 in `suiteChatTools.test.ts`). Eleven mutations were each caught by exactly
the intended test — first-repo-only grep, concatenate-instead-of-interleave, whole-cap-per-repo
listing, first-repo-only listing, silent repo default in `run_command`, swallowed per-repo errors,
lost repo attribution, dropped `checkReadable`, `..` allowed to escape, an uncaught `fs_stat` probe,
and an out-of-repo absolute path accepted. Verify steps 2–5 were driven in the **real main webview**
over CDP against a mocked Tauri IPC boundary at N=3, exercising the shipped module: grep reaching all
three repos and interleaving under a cap of 9, `list_files` spanning all three repo-prefixed,
`fs_stat` probing a bare path to the one repo holding it, `~/.ssh/id_rsa` and an in-repo `.env`
both refused without an `invoke`, `run_command` naming the three repos and then running in the one
asked for, zero console errors. **Verify step 1 is unrun** — a real generator analyze needs API keys
and three real repos, which this session had neither of.

**Phase 8 pulled Phase 9's schema relaxation forward, and had to.** The plan told this phase to stop
asking the model for `repoName` while `DraftSourceLinkSchema.repoName` was still a required
`z.string()` — so between the two commits every code-grounded case would have failed
`DraftCaseLLMSchema`, been dropped by the salvager, and reached the user as "it generated nothing",
logged only to `console.error`. A phase commit that breaks the generator until the next one lands is
not a working state, so **Phase 9 §1 is already done**: `repoName` is `.nullable().optional()` with a
deprecated JSDoc, and `renderSourceLinksBlock` no longer dereferences it. Phase 9 should verify that,
not redo it; §2–§4 (repoScope, the chip row, per-repo provenance at publish) are untouched.

**Phase 8 — a published link's repo comes from the path prefix, via a new `splitRepoPath`.**
Exported from `repoPaths.ts`, returning `{ repo, within }` — the sync counterpart `resolveRepoPath`
can't be, because publish must not touch the disk. Same N=1 missing-prefix tolerance as the resolver,
so a path the tools accepted is a path publish can attribute. **Phase 9 §4 should reuse it** for the
per-repo branch/sha stamp rather than re-splitting by hand. A link whose path names no configured
repo is **dropped**, not written with a blank `repo:` — `parseSourceLinks` requires a repo
(`sourceLinksParser.ts:93`), so a blank one publishes a line the app can never read back.

**Phase 8 — the roster rides on the SYSTEM prompt for the three surfaces that gained one**
(generator, draft chat, commit review); suite chat and confidence keep Phase 7's placement in their
own grounding block. For the generator this is load-bearing rather than stylistic: refine replaces
the user turn wholesale through `userPromptOverride`, so a roster assembled into `buildUserPrompt`
would reach analyze and silently miss every follow-up round. `investigateSystemPrompt` /
`verifySystemPrompt` now take `(commitCount, repos)`, which also keeps the roster out of the turn a
resume compacts.

**Phase 8 — `REPO_PATH_RULE` goes BEFORE each prompt's OUTPUT section, never after it.** Three of the
six prompts close with a strict JSON contract; appending the rule after it displaces the last
instruction the model reads, on exactly the surfaces where a prose answer costs a whole run.
`systemPrompts.test.ts` asserts the rule over the barrel's enumeration, so a NEW surface has to carry
it too.

**Phase 8 — two promises the prompts now make that later phases must keep.** The codeRefs paragraph
tells the model the repo prefix is what the app stamps from; publish still reads one repo
(`primaryRepoRoot`) for every link and every bug ref until **Phase 9 §4**. And bug code refs travel to
ADO prefixed (`codeLinks.file` is `r.file` verbatim, `useGenerationSession.ts:2831`), like suite-chat
citations — **Phase 11** owns making the viewer resolve a prefixed path.

**Phase 8 — verification.** `tsc` clean, `vite build` clean, 1062 frontend tests green (+39; the
`qaAnalystRun` prompt-bytes snapshot was regenerated for the now-prefixed schema example). Nine
mutations were each caught by exactly the intended test — `splitRepoPath` guessing `repos[0]` instead
of refusing, a stale `repoName` outranking the prefix, an unclaimable link published blank, `repoName`
required again, the analyst/draft-chat/commit-review rosters never rendered, the engine dropping its
repos on the way to the prompt, and the rule removed from each of the five prompt files in turn.
**Verify steps 1–3 are unrun** — a real analyze / Suite Chat / Commit Review across three repos needs
API keys and three real repos, which this session had neither of. Step 4 (one repo unchanged) holds by
construction: the prompts are identical at every count and the N=1 bare-path tolerance is pinned in
`repoPaths.test.ts`.

**Phase 9 — `repoScope` lives in `ai/lib/repoScope.ts` and the chip row is SHARED.** The three pure
helpers (`scopedRepos` / `isRepoInScope` / `toggleRepoScope`) sit next to `repoPaths.ts` rather than
inside the generator, and the row itself is `src/components/RepoScopeChips.tsx` (label + hint props),
because **Phase 10 §4 asks for "the same chip row as the generator"** — build on these two, don't
copy. `toggleRepoScope` collapses back to `null` the moment every repo is selected: "all on" must
have one representation, or a scope frozen at today's ids silently excludes a repo added tomorrow.

**Phase 9 — the checkpoint carries BOTH the resolved repos and the scope.** `repos` (Phase 7) is what
a resume replays against; the new `form.repoScope` (optional, read-tolerant) is what re-renders the
chips when a checkpoint is loaded back into the form. They are not redundant: a null scope must stay
null across a resume. The refine checkpoint needed nothing — it has no form to restore, and its
`repos` is already the narrowed list.

**Phase 9 — publish probes the repos the batch NAMES, not the in-scope ones.** The plan said one
`git_repo_info` per in-scope repo; a reopened draft can cite a repo that isn't in the current scope,
and that link would then publish with no provenance while still being written. Walking the kept
links/refs through `splitRepoPath` (and `linkRepo`'s legacy-`repoName` fallback) is both correct and
cheaper — N cases citing one repo cost one subprocess, and a repo nobody linked to costs none. With
`tagSourceBranch` off there is no probe at all.

**Phase 9 — `linkRepo` is the one precedence for both the published name and the stamp.** Prefix
first, then a legacy draft's `repoName` matched against the registry. Two resolutions would let a
link claim one repo and carry another's branch. A link that matches neither still publishes under its
raw `repoName` (Phase 8's rule) but gets no provenance — a stamp for a repo we can't locate would be
a guess.

**Phase 9 — the chip row is gated on `codeSearchEnabled` too.** The plan said "only when
`repos.length > 1`". A control asking which repos may be read, on a run that reads nothing because
the global toggle is off, is a lie; the row hides instead.

**Phase 9 — the run preview caps at 5 branch rows** (`BRANCH_PREVIEW_MAX`) then collapses the rest
into "+N repos · each stamps its own branch". The aside is sticky, so an uncapped list at twenty
repos runs past the viewport and buries the context meter. The `"no source dir"` fallback became
`"no repos configured"` / `"no repos in scope"` / per-repo `"not a git repo"` — the old string was
wrong for a configured folder that simply isn't a repo.

**Phase 9 — `InputPhase` no longer calls `usePrimaryRepoGitInfo`.** It uses `useReposGitInfo` for
everything; holding both hooks in one component polls the same root twice every 30 s. **Phase 11
should check the other single-root callers for the same trap** before adding a second hook anywhere.

**Phase 9 — verification.** `tsc` clean, `vite build` clean, 1087 frontend tests green (+25: 11 in
`repoScope.test.ts`, 6 in the provenance suite, 8 in a new
`useGenerationSession.repoScope.test.ts`). Eleven mutations were each caught by exactly the intended
test — scope ignored, the null-collapse dropped, the analyze feeder unscoped, the checkpoint's scope
dropped, `loadCheckpoint` ignoring it, every link taking the first repo's stamp, bug refs taking the
first repo's sha, probing every configured repo, a failed probe propagating, probing with tagging
off, and the legacy-`repoName` fallback removed. (A twelfth — one failed probe calling
`provenance.clear()` — survived: the failing repo's catch runs before the succeeding repo's set, so
that ordering isn't observable. Nothing in the shipped code clears the map.) Verify steps 2–4 were
driven in the **real main webview** over CDP against a mocked Tauri IPC boundary at N=1, N=3 and N=8:
at one repo the form is unchanged down to the single "Branch" row and the branch-named switch copy;
at three each repo shows its own branch (one deliberately not a git repo), deselecting drops exactly
that repo's row, deselecting all says the run reads no source, re-selecting all restores every row;
at eight the chips wrap and the preview collapses to "+3 repos". Zero console errors. **Verify step 5
(publish across two repos) is covered by unit tests, not by a live ADO publish**, and steps 1 and 6
(a real analyze, interrupt, resume) need API keys and three real repos — unrun live, pinned by tests.

**Phase 10 — `slice.cwd` became `repoIds: string[] | null`, where null means "track the live
registry".** The plan said `repoIds: string[]`. A frozen list is right for a REHYDRATED saved run
(bug #8 — it must show the repos it ran against) and wrong for a fresh tab, which would then never
see a repo added in Settings without being reopened. Null is the same convention `repoScope` already
uses, and `scopedRepos(getRepos(), slice.repoIds)` reads both cases with one function. The pane
derives its repos from the LIVE `usePreferencesStore((s) => s.repos)` rather than calling
`sliceRepos` imperatively, so the chips re-render on a registry change; a small effect re-runs
`loadCommits` when the repo signature moves, because the commit list is a cache.

**Phase 10 — diffs and picker rows are repo-TAGGED at the call site (`RepoCommitDiff` /
`RepoCommitMeta`), and that tag is load-bearing for the AI.** The plan only asked for
`{repoId, repoName}` on the picker rows. But the engine renders each diff into the prompt, and
`git` writes repo-RELATIVE paths — so at N > 1 the model could not tell which repo a changed file
belonged to. `diffHeader` now prefixes the changed-file LIST and states the repo; the raw patch is
left byte-identical (rewriting `diff --git` headers would corrupt a patch the model may hand to
`git apply`), and the investigate prompt's CITATIONS paragraph was corrected to match. A selection
spanning repos also gets one sentence telling the model to trace across the seam.

**Phase 10 — `verifyFocus` needed a repo-aware companion, and without it the narrowing silently
died.** Candidates cite `<repo>/<path>`; `focusPatchOnFiles` substring-matches against
`diff --git a/src/x.ts`. The prefixed form never matches, so every verify pass would have quietly
fallen back to the full patch — correct, but the token win Phase 7's predecessor bought was gone.
`focusPathsInRepo` maps cited paths into one repo and drops the ones naming a different one.

**Phase 10 — `hasLocalChanges: boolean` became `dirtyRepoIds: string[]`, and the mount default
selects EVERY dirty repo's local changes.** At one repo that is byte-identical to today. At several,
uncommitted work spanning repos is the case this pane exists for; the selection is visible in the
picker and the oversized-diff banner still warns, so nothing is silently expensive.

**Phase 10 — the ROW's `cwd` and the CHECKPOINT's `cwd` diverged, deliberately.** `commit_reviews.cwd`
holds a JSON array of the review's repo roots (that is what bug #8's fix reads back);
`ai_checkpoints.cwd` holds the literal `"workspace"`, as the plan specified. A resumed pre-multi-repo
checkpoint is re-filed under `"workspace"` so `listCheckpoints` keeps finding it. Both readers are
tolerant: a `cwd` that doesn't parse as JSON is a legacy single path, an untagged checkpoint diff and
a bare selection sha both belong to `repos[0]`, and `repoScope` is optional on the payload. **No
version bump** — `CHECKPOINT_PAYLOAD_VERSION` is still 2.

**Phase 10 — `ApplyPatchCard` now takes `repos` as a prop** (drilled through `FindingsList` →
`FindingCard`), and resolves through `resolveRepoPath`, which also brings the traversal and
secret/protected-path gates the old `resolveAgainstRoot` join never had — it passed absolute paths
straight through. **Phase 11 should not re-add a global-preference read here.**

**Phase 10 — the fresh-review dedup key is a constant, and `cwd` is gone from every WRITE.**
`CommitReviewTab.cwd` survives as an optional `@deprecated` field documenting what persisted tabs
carry; nothing reads it and `openTab` no longer writes it, so the persist version stays 1 with no
`migrate`. `openCommitReviewTab` / `launchCommitReview` now gate on "the workspace is empty" rather
than "there is a source root".

**Phase 10 — `commitReviewApi` reads are zod-parsed** at the IPC boundary, per the plan. `get`
returns null on a shape mismatch; `list` drops the offending row and keeps the rest, because failing
the whole call would hide every good review behind one bad one.

**Phase 10 — History rows show the repo on the SUBJECT line, not the meta line.** Driven in the real
webview, the meta line's five items squeezed the chip to the single letter "R." in a 200 px sidebar.
On the subject line it competes only with a string that already truncates.

**Phase 10 — verification is REAL, including the live steps.** `tsc` clean, `vite build` clean, 1126
frontend tests green (+39; 65 in the store suite, 20 in `verifyFocus`, 15 in the selector suite).
Twenty-five mutations were each caught by exactly the intended test — a concatenated merge, an
ISO-text date compare, one unreadable repo emptying the picker, every diff read from `repos[0]`,
`toggleLocalChanges` ignoring its argument, the run ignoring the scope, the checkpoint dropping the
scope, the row storing one root, bug #8 restored, adopt resuming against a changed workspace, a raw
`!==` root compare, a whole-workspace local-diff drop, a first-repo-only pre-run re-read, an untagged
snapshot diff, unkeyed legacy shas, a repo-less commits blob, per-directory checkpoints, locals
losing their sort position, a bare sha read as a repo id, focus paths keeping their prefix, focus
paths leaking across repos, an unnamed diff section, an unprefixed file list, and a dropped span
note. Verify steps 2–6 were driven in the **real main webview** over CDP against a mocked Tauri IPC
boundary at N=2 and N=1: the merged picker interleaves repo-two's commit between repo-one's two, each
repo carries its own `head` badge, searching a repo name narrows to it, one commit from each repo
loads its diff **from its own root**, deselecting a repo from the read scope leaves the ticked
commits ticked, a reopened saved run restores its own repo set, and **Apply wrote to
`C:\dev\repo-two\src\two.ts`** — bug #4, closed end to end. At one repo the pane is unchanged: no
repo chips, no scope row, a plain "Local changes" trigger. Zero console errors. The drivers are
`.claude/skills/drive-ui/drive-commit-review{,-apply}.mjs`. **Verify steps 1 and 7 (a real
two-repo review, and interrupt→adopt) are unrun live** — they need API keys and two real repos;
both are pinned by store tests.

**Phase 6 found a real bug in its own first draft**, worth knowing because the pattern recurs: the
repo popover's `open` is controlled, so a programmatic `setOpen(false)` never fires `onOpenChange` —
the drilled-into repo was never cleared and the next open showed the previous repo's branches. Any
new controlled Radix surface here needs one `close()` that resets its own state too.

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
