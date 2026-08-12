# Phase 9 — Generator

> Read `00-INDEX.md` first. Requires Phases 7–8.

**Files:** `src/modules/generator/lib/draftBatchSchema.ts`,
`src/modules/generator/store/useGenerationSession.ts`, `src/modules/generator/GeneratorPane.tsx`,
`src/modules/generator/lib/qaAnalystRun.ts`

## 1. Relax the schema FIRST — this is the trap in this phase

`DraftSourceLinkSchema.repoName` (`draftBatchSchema.ts:16`) is a **required** bare `z.string()`:

```ts
export const DraftSourceLinkSchema = z.object({
  /** Repo display name (matches what the user attached). */
  repoName: z.string(),
  repoId: z.string().nullable().optional(),
  filePath: z.string(),
  …
});
```

Phase 8 stopped telling the model to emit a repo name. Every case that follows the new instruction
now fails validation and is **silently dropped**:

- `parseDraftBatch` (`:125-133`) → `DraftBatchLLMSchema.parse` throws → returns `{cases: [], bugs: []}`
- `salvageDraftBatch` → `salvageItems` (`:175-194`) → per-case `safeParse` fails → `dropped.push(i)`,
  logged **only** to `console.error` (`:189-191`)

The user sees "the model generated nothing." Do this edit before anything else in the phase.

**Fix:** make `repoName` `.nullable().optional()`, mark it deprecated in the JSDoc (keep the field so
older drafts still parse), and fix `renderSourceLinksBlock` (`useGenerationSession.ts:3872-3888`),
which dereferences it unconditionally at `:3878-3879` (`repoId: l.repoId ?? l.repoName`).

`DraftBugCodeRefSchema` (`:44-52`) needs **no** change — its `file` carries the repo prefix like
source links, and the per-repo SHA is looked up at publish. Note `file` is `.min(1)` while
`repoName` was not, so `""` used to pass — don't reintroduce that.

## 2. Per-run repo scope

- `SessionState` gains `repoScope: string[] | null` (repo ids; `null` = all). Session-scoped, resets
  per run — same lifecycle as `tagSourceBranch` (declared `:211`, defaulted `:820`).
- `RunInput.repos` / `PreparedAnalystRun.repos` (plural since Phase 7) now carry
  `repoScope ∩ codeSearchEnabled` instead of every repo. Feeders: `useGenerationSession.ts:1862`
  (analyze), `:3061` (refine), `:3585` (chat).
- Persist `repoScope` in the generator + refine checkpoints so a resumed run keeps the narrower
  scope rather than widening back to all repos.
- **Attachments are untouched** — they are content blobs (`Attachment.path` is a display filename),
  not paths into a repo.

## 3. Input form

`GeneratorPane.tsx` `InputPhase` (`:696-1505`), near the `tagSourceBranch` switch (`:1187`) and the
branch preview row (`:1476-1492`):

```
Repos   [✓ repo-one] [✓ repo-two] [✓ repo-three]
```

- Rendered **only when `repos.length > 1`**, so a single-repo user sees today's form unchanged.
- All on by default. Clicking a chip excludes that repo from this run.
- The branch preview row becomes one line per in-scope repo (today it falls back to the literal
  string `"no source dir"` at `:1476-1492`; make that "no repos configured").
- Tooltip on the chip row explaining what deselecting does — per CLAUDE.md, an unexplained control
  reads as "WTF is this".

## 4. Publish: per-repo provenance

`publish()` (`:2645-2705`) currently makes **one** `git_repo_info` call at `:2667-2670` and derives
one `trackingBranch` (`:2679-2682`) and one `sourceDirSha` (`:2672`).

Build `Map<repoId, { branch, sha }>` by calling `git_repo_info` per in-scope repo instead. Then:

- For each `DraftSourceLink`, split the repo prefix off `filePath` → that repo's branch supplies
  `generationBranch` / `trackingBranch`, and its SHA supplies `generationSha` (which Phase 2 threaded
  through — before that it was hardcoded `""`).
- Bug code refs (`:2825-2841`, `commitSha` at `:2839`) take their own repo's SHA.
- `resolveTrackingBranch` (`src/modules/git/trackingBranch.ts:14`) is reused unchanged, once per repo.
- Phase 2 unified the two gate predicates (`:2699` vs `:2839`) — keep them unified.

> `git_repo_info` has **four** call sites app-wide: `useSourceDirGitInfo.ts:44`,
> `useSuiteConfidence.ts:29`, `evaluateCaseConfidence.ts:43`, and `useGenerationSession.ts:2670`.
> This phase changes only the publish one. Phase 11 handles the confidence pair; Phase 6 already
> handled the status-bar one.

The `repoId` / `repoName` / `project` on the published link still come from the repo's ADO binding —
which is `null` until Phase 12. Until then, fall back to the repo's display name, exactly as
`repoId: l.repoId ?? l.repoName` does today. Don't block on Phase 12.

## Verify

1. **The trap check:** have the model emit a source link with no `repoName` (or temporarily stub one)
   → the case is **not** dropped and no `console.error` fires.
2. Generate with all three repos in scope → the activity log shows reads across repos.
3. Deselect one repo, re-run → no reads in that repo.
4. With one repo configured, the chip row does not render and the form looks exactly as before.
5. Publish a batch whose cases reference two repos → each case's source link carries **its own**
   repo's branch and SHA, not the first repo's.
6. Interrupt an analyze with a narrowed scope, resume → the narrowed scope is restored.
7. `pnpm test` green.

## Commit

`feat(generator): scope runs per repo and stamp per-repo provenance at publish`
