# Phase 10 — Commit Review

> Read `00-INDEX.md` first. Requires Phases 7–8. Fixes bugs #4 and #8.

**Files:** `src/modules/commit-review/{useCommitReview,CommitReviewPane,gitCommitApi,ApplyPatchCard,commitReviewApi,CommitReviewHistoryPane}`,
`src/modules/tabs/store/{types,useTabsStore}.ts`, `src/modules/tabs/TabContent.tsx`,
`src/app/App.tsx`

## 1. The tab `cwd` — read this before touching anything

Removing `cwd` from `CommitReviewTab` (`types.ts:57`) breaks **five** things. None are optional.

1. **`useTabsStore.ts:285` `t.cwd === input.cwd` IS the fresh-tab dedup rule.** Remove it without a
   replacement and every invocation stacks a new tab — and `App.tsx:951` (the `commitReview.new`
   shortcut) and `App.tsx:1601` both call `openCommitReviewTab()` with **no args**.
2. `OpenTabInput` declares `cwd: string` as **required** (`:86`) → compile break at `App.tsx:505-510`.
3. `useTabsStore.ts:392` — `cwd: input.cwd` in tab construction.
4. `TabContent.tsx:69` passes `cwd={tab.cwd}` into `CommitReviewPane` → `useCommitReview.ensure`
   (`:620-639`) → `slice.cwd`, which is read at `:810, :816, :933, :970-971, :1062, :1171,
   :1181-1182, :1351, :1535`.
5. **The tabs persist store has `version: 1` (`:759`) and NO `migrate`.** `merge` (`:773-797`) is
   `{...current, ...persisted}` taking `merged.tabs` wholesale — no per-tab validation, no field
   whitelist. Already-persisted tabs keep a stale `cwd` at runtime, invisible to TypeScript. If you
   bump the version you **must** supply `migrate`, or zustand logs an error and passes the state
   through unmigrated.

Rehydrate currently drops exactly three cases (`:777-782`): unbound generators, all terminals, and
the legacy `code-review` kind. A commit-review tab with an extra unknown field survives fine.

**So the safe move: leave `cwd` in the persisted shape and simply stop reading it.** The fresh-tab
dedup key becomes a constant — a review tab is now workspace-scoped, so exactly one fresh review tab
exists, which matches today's one-per-cwd behaviour. Saved runs still dedup on `rehydrateRunId`
(`:277-286`); Duplicate still clones (`:530-587`, with `clone.rehydrateRunId = null` at `:579`).

## 2. Store and commit list

- `CommitReviewSlice.cwd` (`:94`) → `repoIds: string[]`. `emptySlice` (`:582-615`) and the `ensure`
  identity check (`:622`, `existing.cwd === cwd`) compare the set.
- **`loadCommits` (`:805-828`)** fans out `listCommits(repo.root, 80)` per in-scope repo, tags each
  row with `{ repoId, repoName }`, and merges by `CommitMeta.date` descending. That field is
  ISO-8601 strict (`%cI`, `git.rs:355-356`) so the merge sort is trivially correct. Cap display at
  200.
- One **"Local changes" row per dirty repo**, from the per-repo `gitStatusSummary` already fetched at
  `:816`.
- `loadDiffs` (`:954-1009`) fans out per `(repo, sha)`;
  `s === LOCAL_CHANGES_SHA ? workingTreeDiff : commitDiff` (`:969-971`) becomes per-repo.
- `selectedShas: string[]` → composite keys `${repoId}:${sha}`; `LOCAL_CHANGES_SHA` becomes
  `${repoId}:local`. **Keep the field name** so persisted tabs and SQLite rows still load — on read,
  a key with no `:` is a legacy bare sha belonging to `repos[0]`.

## 3. Picker UI — merged timeline, NO repo chips

`CommitReviewPane.tsx:1249-1344`. Each row gains a repo chip before the `shortSha` (`:1323-1325`).

The existing **manual, order-preserving** filter (`:1169-1177`) gains one clause:

```ts
const filtered = q
  ? commits.filter(
      (c) =>
        c.repoName.toLowerCase().includes(q) ||   // ← added
        c.shortSha.toLowerCase().includes(q) ||
        c.subject.toLowerCase().includes(q) ||
        c.sha.toLowerCase().includes(q),
    )
  : commits;
```

Placeholder (`:1253`) → `"Search commits by repo, message or sha…"`.

**Do not add repo chips to this list.** Ticking is already the selection mechanism and the search box
handles noise. A second filter layered over a multi-select creates a bad edge: a ticked commit whose
repo you then hide either stays selected but invisible (you review a repo you thought you'd excluded
— the exact bug class this plan fixes) or gets silently deselected by a view control.

**`head` badge bug:** `:1156` computes `headSha = commits[0]?.sha`, which is wrong once repos
interleave. Build `headShaByRepo: Map<repoId, sha>` and compare per row (`:1329`).

## 4. Read scope — a separate control, and it is not the commit filter

Add the same chip row as the generator, in the input area beside the code-search notice (`:491`),
all repos on by default.

This is a genuinely different concept from which commits are under review. A commit in one repo often
can't be judged without reading a *different* repo it depends on — and that other repo may have no
commit in the selection at all. Restricting reads to the repos with selected commits would reintroduce
the exact blindness this plan removes.

Label it "Repos the reviewer can read" and tooltip it, so it's clearly not a filter on the commit
list.

## 5. Bug #4 — `ApplyPatchCard` writes into the wrong repo

`ApplyPatchCard.tsx:65` reads the **global** pref, not the review tab's repos:

```ts
const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
```

and `resolveAgainstRoot` (`:364-369`) joins against it. Route the before-read (`:93`), the apply-read
(`:146`) and the **`fs_write_file`** (`:164-168`) through `resolveRepoPath` against the **review's**
repo set. The "Set a source directory in Settings first" copy (`:137-143`) becomes "Add a source
repo".

Same class of issue in the viewer jumps — `ApplyPatchCard.tsx:187-197`, `FindingCard.tsx:69`,
`CommitDiffView.tsx:121` all dispatch `devops-studio:open-code-viewer` with a repo-relative path
resolved in `App.tsx:445-447` against the global root. Phase 11 fixes that resolver; here just make
sure the paths you emit carry the repo prefix.

## 6. Refresh guard

`refreshSource` (`:927-952`) guards at `:933`:

```ts
if (slice.cwd !== usePreferencesStore.getState().sourceRoot) return;
```

A raw `!==` string compare with **no normalisation** — a trailing separator or a Windows case
difference makes it silently return forever. Replace with a normalised match of the
`source-git-changed` payload root (added in Phase 6) against `repoIds`.

## 7. Persistence — no Rust migration needed

`commit_reviews.cwd` is `TEXT NOT NULL` with no constraint (`src-tauri/src/modules/commit_review.rs:62-64`).
Store a JSON array of repo roots, following the adjacent `commits TEXT` column already documented as
"Opaque JSON" (`:110`). On read, a value that doesn't parse as JSON is a legacy single path.

> If a dedicated column is ever wanted, the tolerant `ALTER TABLE … ADD COLUMN` +
> duplicate-column-swallow pattern already exists at `:93-97`. Not needed now.

**`commitReviewApi.ts` does zero runtime validation** — all four reads are raw `invoke<T>()` casts
(`:60-66`, `:68-70`), unlike `ado/native.ts:510` which zod-parses. A shape change therefore fails deep
inside a component. Add a zod parse at that boundary while you're here.

Note `listCommitReviews` returns `CommitReviewSummary` (`:39-53`), a **narrower** type than
`CommitReviewRow` — no `context`, `findings`, `appliedPatches`, or `error`. Don't plan to filter
History on those without a schema change.

**Bug #8:** `App.tsx:1482-1486` reopens a saved run with `openCommitReviewTab({ rehydrateRunId })` and
**no cwd**, so it binds to whatever repo is current. Restore the run's own repo set from the row.
Same shape at `:951` and `:1601`. History rows should show repo labels.

## 8. Checkpoint

`.sourceRoot` became `repos` in Phase 7. Here, `CommitReviewCheckpointV1.cwd` (`:166`) **and** the
SQLite `cwd` scope column both become the literal `"workspace"`, so `adoptInterruptedRun`
(`:458-580`) and `listCheckpoints("commit-review", cwd)` keep working unchanged.

**No second version bump** — the payload *shape* is unchanged, only what goes in the field.

Guard on adopt: skip the row if any repo root in the payload is no longer configured, rather than
resuming against a changed workspace.

Two behaviours to preserve: `adoptInterruptedRun` probes only the newest 5 entries (`:478`), and
`persistRow` silently no-ops when `diffs.length === 0` (`:1529`).

## Verify

1. Select commits from **two** repos in one pass → both diffs load, findings cite files in both.
2. **Apply Patch writes into the correct repo** — verify with `git status` in each. (Before this
   phase it wrote into whichever repo the status bar pointed at.)
3. Search the picker for a repo name → only that repo's commits.
4. The `head` badge appears on the newest commit of **each** repo, not just the first row.
5. Deselect a repo from the read-scope chips → the reviewer makes no reads there, but already-ticked
   commits stay ticked.
6. Reopen a saved review from History → it restores its own repo set, not the current one.
7. Interrupt a review, reopen a fresh tab → it adopts the checkpoint; then remove one of its repos
   from settings and confirm it declines to adopt.
8. `pnpm test` green (`useCommitReview.test.ts`, `useCommitReview.store.test.ts` will need updates).

## Commit

`feat(commit-review): review commits across repos in one pass`
