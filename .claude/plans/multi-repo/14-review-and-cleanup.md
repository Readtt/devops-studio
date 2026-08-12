# Phase 14 — Full review, then remove these docs

> Read `00-INDEX.md` first, including the **Deviations** section — that's the record of everything
> that didn't go to plan.

This phase writes no features. It reviews everything, then cleans up after itself.

## 1. Review every phase

Read the diff for each commit listed in `00-INDEX.md`, in order. For each, check:

- It matches its phase file, or the difference is recorded under **Deviations**.
- No `TODO`, stub, commented-out block, or debug logging left behind.
- Comments explain a non-obvious *why*, and don't restate the code (CLAUDE.md).
- UI additions follow the house patterns: tooltips on icon-only buttons, `icon` + `description` on
  context-menu items, skeletons not spinners, type scale ≤ 13 px.
- **No assumed topology** (see `00-INDEX.md`). Grep the diff for role-suggesting language in types,
  prompts, comments and UI copy. Confirm: `WorkspaceRepo` gained no role/kind/tier field; nothing
  branches on repo *position* except the two documented defaults (terminal cwd, clone seed); every
  prompt roster is flat and unannotated; nothing assumes N > 1 or N < some bound.

Pay particular attention to the seams between phases, which is where a fresh context loses things:

| Seam | What to confirm |
|---|---|
| 3 → 4 | No `Preferences.sourceRoot` reference survives outside the Phase 3 migration read. |
| 4 → 6 | `useSourceDirStatus` takes a cwd; nothing still reads the global pref for status. |
| 7 → 9/10/11 | All five `buildSuiteChatTools` callers pass `repos`; no caller reconstructs a single root. |
| 8 → 9 | `DraftSourceLinkSchema.repoName` is optional **and** the prompt no longer asks for it. Both, or generated cases get dropped. |
| 2 → 12 | `sourceLinksParser` round-trips, and `project` is optional in both directions. |
| 9/10 → 12 | Publish falls back to the repo display name when `ado` is null. |

## 2. Full check

```
pnpm build        # clean
pnpm test         # green
```

Then run the end-to-end checklist below.

## 3. Delete the plan docs

Delete `<repo>/.claude/plans/multi-repo/` — the whole directory. It is the only copy; the original
single-file master was removed once these phase files superseded it.

## 4. Hand off

Report to the user: what shipped, anything deliberately left out, and anything found in review that
wasn't fixed. Then they smoke test.

**After the smoke test passes**, cut a release with `./scripts/release.sh <version>`. Per CLAUDE.md,
**diff against the last tag first** — the version bump and CHANGELOG must cover **all** unreleased
commits, not just these phases. This is a minor bump (new user-visible feature), not a patch.

---

## End-to-end verification checklist

Run with `pnpm tauri dev`. If module resolution fails: `CI=true pnpm install --offline`.

### Single-repo regression — must be indistinguishable from before
1. One repo configured: status bar, generator form, commit picker, suite chat all render as before.
2. Generate with code search on → analyzer roams, cases publish, links open the right ADO file on the
   right branch.
3. Switch a branch from the status bar; park a dirty tree and restore it.

### Multi-repo
4. Add three repos. Status bar shows the roll-up; each row has its own branch/dirty state; drilling in
   switches only that repo; two concurrent switches don't cancel each other.
5. **The acceptance test:** pick a real feature whose implementation genuinely spans two of your
   repos. Run the generator with all repos in scope against that spec → the activity log shows reads
   in **both** repos, and the produced cases cover the parts implemented in each. Then run the same
   spec with only one of those repos in scope and confirm the coverage you lose is exactly the part
   living in the excluded repo. That gap is the bug this plan exists to close.
6. Deselect a repo via the chips, re-run → no reads in that repo.
7. Commit Review: commits from two repos in one pass; diffs load for both; findings cite both;
   Apply Patch writes into the **correct** repo (verify `git status` in each).
8. Search the commit picker for a repo name → only its commits.
9. Publish → each case's link resolves to its own repo, on that repo's branch, in that repo's ADO
   project.

### Containment (bug #5)
10. With code search on, ask the model to read a secret file (`~/.ssh/id_rsa`, a `.env`) and a path
    outside every repo root. Both refused by `resolveRepoPath` — not read.

### Source-link format (bugs #1–#3)
11. Publish a case with a nested path and a slashed branch name → the code ref opens the real ADO
    file.
12. Publish with "Tag with source branch" **off** → links still render in the Test Case pane.
13. Open a case published before any of this → its links still resolve.

### Resume
14. Start a generator analyze across three repos with a narrowed scope, kill the app mid-run, reopen →
    it rehydrates and resumes with the same repo set **and** scope.
15. Same for Commit Review (a fresh tab adopts the checkpoint). Then remove one of its repos and
    confirm it declines to adopt.
16. A pre-existing v1 checkpoint row does not appear as a stuck "interrupted" entry.

### Custom provider (Phase 1)
17. Real endpoint + key → dropdown lists models; Test succeeds.
18. Wrong key → Test reports an auth failure (before this, it said "Reachable").
19. Endpoint with no `/models` route → free text + hint; Test still exercises the typed model.

### Automated
Suites touched across the plan: `commitReviewPrompts.test.ts`, `useCommitReview.test.ts`,
`useCommitReview.store.test.ts`, `suiteChatTools.test.ts`, `qaAnalystRun.test.ts`,
`qaChatRun.test.ts`, `runConfidenceEval.cachePrefix.test.ts`, `runConfidenceEval.runs.test.ts`,
`runSuiteChat.test.ts`, `codeSearchPref.test.ts`.
New: `repoPaths.test.ts`, `sourceLinksParser.test.ts`.

## Commit

`chore: remove the multi-repo implementation plan`
