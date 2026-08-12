# Phase 2 — Source-link format fixes

> Read `00-INDEX.md` first for ground rules. This phase is **independent** of the multi-repo work.
> Do it before Phase 12, which adds a field to the same format.

## Problem

Three live bugs (#1, #2, #3 in the index) silently break published code links today. The file has
**zero test coverage** — `Glob **/sourceLinks*.test.ts` returns nothing.

**Files:** `src/modules/test-plans/lib/sourceLinksParser.ts`,
`src/modules/generator/store/useGenerationSession.ts`

## Bug 1 — `/` is escaped and never unescaped

`escape` (`sourceLinksParser.ts:109-112`):

```ts
function escape(s: string): string {
  // Avoid the " / " separator turning up inside a value.
  return s.replace(/\s*\/\s*/g, " ∕ ");
}
```

Every `/` becomes U+2215 DIVISION SLASH. **There is no inverse anywhere in the file.** So
`src/auth/login.cs` serializes as `src ∕ auth ∕ login.cs` and parses back the same way; branch
`feature/2fa` becomes `feature ∕ 2fa`.

Downstream, `TestCasePane.tsx:432` feeds the mangled path into `buildAdoReposWebUrl` as `path=`,
producing **a dead ADO link for every case**.

The escape is *necessary* — `parseLine:76` does `line.split("/")` on a plain `/`, so unescaped paths
would shred the line. The missing inverse is the defect.

**Fix:** add an `unescape` and apply it when reading each value in `parseLine`. The doc comment at
`:5-8` shows clean `file: src/auth/login.cs` — that is not what the serializer produces today; make
the comment true.

## Bug 2 — an empty `branch:` drops the whole link

`parseLine:82,84` returns `null` — dropping the entire line — when `repo`, `branch` or `file` is
missing or empty. `renderSourceLinksBlock` passes `""` for the branch whenever `tagSourceBranch` is
off or `sourceDirBranch` is null (`useGenerationSession.ts:2699`), so `renderLine:61` emits
`branch: ` and the reader discards it.

Result: a user who unchecks "Tag with source branch", or generates from a non-git / detached-HEAD
directory, publishes a source-links block the app itself cannot read. The pane shows "No source links
recorded on this case yet."

**Fix:** only `repo` and `file` are genuinely required. Treat `branch` as optional — an empty branch
legitimately means "no provenance was stamped" — and have the renderer omit the branch from the
generated link rather than dropping the row.

## Bug 3 — `generationSha` is hardcoded empty

`renderSourceLinksBlock` (`useGenerationSession.ts:3872-3888`) sets `generationSha: ""` at `:3884`,
even though `sourceDirSha` is captured at `:2672`. Thread it through.

While here, note the gate asymmetry: cases gate on `tagSourceBranch && sourceDirBranch` (`:2699`),
bugs on `tagSourceBranch` alone (`:2839`). These are equivalent today only because both source values
are null together. Make them the same predicate.

## Add tests — this is the regression net Phase 12 depends on

New `src/modules/test-plans/lib/sourceLinksParser.test.ts`. Round-trip (serialize → parse →
deep-equal) covering:

- a nested path containing `/` (the Bug 1 case)
- a branch containing `/`, e.g. `feature/x`
- an empty branch (the Bug 2 case)
- a missing optional `symbol` and `lineRange`
- an **unknown forward-compat key** in the line — `parseLine:75-80` builds a Map from every
  `key: value` part and reads only known keys, so unknown keys must be ignored, not fatal. Phase 12
  relies on this.
- a line missing a genuinely required key (`repo` or `file`) → still dropped

## Verify

1. Publish a case with a nested source link (e.g. `src/services/auth/handler.ts`), open it in the
   Test Case pane, click the code ref → the ADO URL resolves to the real file.
2. Publish from a branch whose name contains `/` → the link's `version=GB…` is correct.
3. Publish with "Tag with source branch" **off** → links still render in the pane (today they vanish).
4. Open a case published **before** this change → its links still parse (the unescape must be
   tolerant of already-clean values).
5. `pnpm test` green, including the new suite.

## Commit

`fix(test-plans): repair source-link round-trip, optional branch, and missing sha`
