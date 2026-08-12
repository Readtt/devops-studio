# Phase 4 — Mechanical sweep: delete `sourceRoot`

> Read `00-INDEX.md` first. Requires Phase 3 (the `usePrimaryRepoRoot()` shim).

## Goal

Remove `sourceRoot` from `Preferences`. TypeScript then errors at every read site; each becomes
`usePrimaryRepoRoot()` (in components) or `primaryRepoRoot(getRepos())` (outside React).

**This phase is behaviour-preserving by construction** — the shim returns exactly what `sourceRoot`
used to return. Nothing user-visible changes. Let the compiler drive it.

## Scope

31 non-test files. Grouped by module:

| Module | Files |
|---|---|
| app | `app/App.tsx` |
| git | `useSourceDirGitInfo.ts`, `useSourceDirStatus.ts`, `StatusBarGit.tsx`, `GetSourceCodeDialog.tsx` |
| commit-review | `useCommitReview.ts`, `ApplyPatchCard.tsx`, `runCommitReview.ts` |
| generator | `store/useGenerationSession.ts`, `lib/qaAnalystRun.ts`, `lib/qaChatRun.ts`, `components/RefineComposer.tsx` |
| test-plans | `SuiteChatPane.tsx`, `BugPane.tsx`, `hooks/useSuiteChat.ts`, `hooks/useSuiteConfidence.ts`, `lib/evaluateCaseConfidence.ts`, `lib/runConfidenceEval.ts`, `lib/runSuiteChat.ts`, `lib/suiteChatTools.ts` |
| code-viewer | `resolveSourcePath.ts` |
| terminal | `QuickPromptsStrip.tsx` |
| tabs | `launchActions.ts`, `LaunchMenu.tsx`, `LeafPane.tsx`, `PaneTreeRenderer.tsx`, `TabContent.tsx` |
| command-palette | `CommandPalette.tsx` |
| settings | `sections/AzureDevOpsSection.tsx` |
| ai | `lib/checkpointApi.ts` |

Every AI call site keeps its existing gate — `prefs.codeSearchEnabled ? <root> : null`. Do not change
that logic; only change where the root comes from.

## Also: drop the prop drill

`sourceRoot` is threaded `App.tsx:1535` → `PaneTreeRenderer` → `LeafPane` → `TabContent` → `BugPane`
to serve **one** consumer. Delete the prop from all five files and have `BugPane` read the store
directly (every other surface already does).

## Do not do in this phase

- Do **not** start making anything actually multi-repo. That's Phases 5–12.
- Do **not** fix any of the pre-existing bugs listed in `00-INDEX.md`, even though you'll walk past
  several. Each has an assigned phase, and mixing them in makes this sweep unreviewable.
- Do **not** rename `useSourceDirGitInfo` / `useSourceDirStatus` yet — Phase 6 does that.

## Verify

1. `pnpm build` clean — zero remaining references to `Preferences.sourceRoot`.
2. `pnpm test` green.
3. Launch the app and exercise every surface: status bar branch + switcher, generator analyze +
   publish, commit review, suite chat, confidence, code viewer, terminal, command palette. All must
   behave **exactly** as before. This phase's whole value is that nothing changed.

## Commit

`refactor(settings): route every source-root read through the repo registry`
