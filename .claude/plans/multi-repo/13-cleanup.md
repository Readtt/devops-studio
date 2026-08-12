# Phase 13 — Cleanup

> Read `00-INDEX.md` first. Requires Phases 7 and 12.

Small, contained, and worth doing: a second dead tool layer is exactly what a future contributor
trips over.

## 1. Delete the orphaned tool stack

Delete:
- `src/modules/ai/tools/tools.ts`
- `src/modules/ai/tools/fs.ts`
- `src/modules/ai/tools/search.ts`
- `src/modules/ai/tools/context.ts`
- `src/modules/ai/lib/native.ts`

`buildTools()` (`tools.ts:14`) has **zero** callers. An exhaustive grep for `ai/tools`,
`buildFsTools`, `buildSearchTools`, `ChatTools`, `ToolContext` finds only those four files
referencing each other, plus two **comment-only** mentions in
`src/modules/generator/lib/activityLog.ts:282` and `activityLog.test.ts:53` — update those comments.

Git history corroborates:
`3b1708d refactor(ai): remove dead general-agent + plan/todo/subagent stack`.

> **Do NOT confuse `src/modules/ai/lib/native.ts` (dead) with `src/modules/ado/native.ts` (live)** —
> the latter is imported by `ado/index.ts:1` and `ado/useTeamMembers.ts:2`. A careless grep hits both.

## 2. Keep security.ts

`src/modules/ai/lib/security.ts` and `security.test.ts` were transitively dead before Phase 7 and are
**live now** via `resolveRepoPath`. Keep both.

Note `checkWritableCanonical` (`:291`) is exported but has no test — either add one or leave it; don't
delete it, `checkWritable` is used by the same module.

## 3. Fix two comments that are now lies

- `src-tauri/src/modules/workspace.rs:10-13` claims "Path safety for AI tool calls is enforced in the
  frontend tool layer (`src/modules/ai/lib/security.ts`)". That was **false** before Phase 7 and is
  **true** afterwards — but it should name `repoPaths.ts` as the entry point.
- `src/modules/test-plans/lib/suiteChatTools.ts:506-507` claims "the Rust side will still enforce the
  workspace boundary so it can't escape". That was false (`workspace.rs:31-33` `resolve_path` is
  `PathBuf::from(path)`, identity) and the code it annotated is gone. Remove or correct it.

## 4. Leave alone

- `WorkspaceEnv` (`workspace.rs:18-29`) — vestigial single-variant enum, but threaded through 10 Rust
  signatures for no gain. Removing it is churn.

## 5. Retire the shim — carefully

Delete `usePrimaryRepoRoot()` / `primaryRepoRoot()` **only if unreferenced**.

Expect legitimate survivors: the terminal's default cwd and `GetSourceCodeDialog`'s
clone-destination seed genuinely want "the first repo", which is **not** the same concept as the old
global source root. Keep those call sites and rename the helper to say what it means (e.g.
`firstRepoRoot`), or leave it — just don't delete a live dependency to hit a tidiness target.

## 6. Optional one-liners

Only if they cost nothing:
- `BuildModelOptions.modelIdOverride` (`agent.ts:26`) is declared and never read anywhere.
- `modelCache` (`agent.ts:33`) is never evicted — unbounded. Its key (`:59`) is space-delimited with
  no escaping, so a key containing a space could theoretically collide. Low risk; note, don't
  necessarily fix.

## Verify

1. `pnpm build` clean, `pnpm test` green.
2. Grep confirms no imports of the deleted files remain.
3. The app runs and every AI surface still works — especially the containment check from Phase 7
   (secret file and out-of-repo path both refused), since that's what proves `security.ts` is still
   wired.

## Commit

`refactor(ai): delete the orphaned tool stack and correct stale security comments`
