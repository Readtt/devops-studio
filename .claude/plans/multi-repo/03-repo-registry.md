# Phase 3 — Repo registry + compatibility shim

> Read `00-INDEX.md` first — especially the **data model** section, which defines `WorkspaceRepo`.
> This is the first multi-repo phase. Phases 3→7 are strictly ordered.

## Goal

Introduce `repos: WorkspaceRepo[]` alongside a shim that returns `repos[0].root`, so Phase 4 can
delete `sourceRoot` mechanically with zero behaviour change.

**Files:** `src/modules/settings/store.ts`, `src/modules/settings/preferences.ts`

## `store.ts` needs SIX edits

This file is hand-maintained with no guard — the only test in the module is
`codeSearchPref.test.ts` (14 lines, asserts one default). Missing an edit fails **silently**.

1. **The type** — `WorkspaceRepo` + `repos: WorkspaceRepo[]` on `Preferences` (near `:122`, where
   `sourceRoot: string | null` lives).

2. **`const KEY_REPOS = "repos";`** alongside the other `KEY_*` consts (near `:181`, where
   `KEY_SOURCE_ROOT` is).

3. **`repos: []` in `DEFAULT_PREFERENCES`** (near `:245`). **Not optional.** `preferences.ts:36`
   spreads `DEFAULT_PREFERENCES` as the zustand initial state, so without this every consumer reads
   `undefined` until hydration finishes and the first `.map()` throws on first paint.

4. **The `loadPreferences` return entry** (near `:363-369`), with the migration below.

5. **The `onPreferencesChange` key map entry** (near `:630`). Existing shape, verbatim:
   ```ts
   [KEY_SOURCE_ROOT]: "sourceRoot",
   ```
   Miss this and the pref persists and loads fine, but **cross-window live updates never fire** —
   the Settings window and the main window silently desync.

6. **Setters routed through `writePref`** (`:265-269`) — `setRepos` / `addRepo` / `removeRepo` /
   `renameRepo` / `setRepoAdo`. Hand-rolling `store.set` + `store.save` without the `emit` is a
   footgun the file documents twice (`:259-262`, `:586-588`): the Settings window is a separate
   webview and never sees a write that skips `writePref`.

## Migration

In `loadPreferences` (`:363-369`), which currently reads:

```ts
sourceRoot:
  consumeLaunchDir() ??
  get<string | null>(KEY_SOURCE_ROOT) ??
  DEFAULT_PREFERENCES.sourceRoot,
```

If `repos` is absent or empty **and** a legacy `sourceRoot` (or `consumeLaunchDir()`) is present,
seed `[{ id, name: basename(root), root, ado: null }]` and persist it once.

Keep reading `KEY_SOURCE_ROOT` **only** for this migration. Stop writing it. `consumeLaunchDir()`
(`src/lib/launchDir.ts:17-21`) is one-shot — it drains on first read — so consume it exactly once.

## Validate in the setter, not the store

`preferences.ts:35-47` blind-sets whatever arrives on a change event:

```ts
void onPreferencesChange((key, value) => {
  set({ [key]: value } as Partial<State>);
});
```

No validation, cast straight through, and the subscription is fire-and-forget (`void`, `:43`) and
never unsubscribed. So a malformed `repos` payload emitted by *any* window lands verbatim in the
store. Enforce name uniqueness and slug-safety (no `/`) inside `setRepos`.

`preferences.ts` itself needs **no change** — `State = Preferences & {…}` picks the new field up for
free.

## The shim

Export from `store.ts` (or a small sibling):

```ts
export function primaryRepoRoot(repos: WorkspaceRepo[]): string | null {
  return repos[0]?.root ?? null;
}
```

plus a `usePrimaryRepoRoot()` selector hook. This is what makes Phase 4 a mechanical,
behaviour-preserving sweep.

## Verify

1. Boot with an existing `sourceRoot` in `devops-studio-settings.json` → one repo appears in the
   persisted JSON under `repos`, and every surface behaves exactly as before.
2. Delete the settings file → boots clean with `repos: []`, no crash on first paint (that's edit #3).
3. Launch via the "Open in DevOps Studio" shell verb on a folder → it becomes the seeded repo.
4. Change a repo from the Settings window (temporarily, via devtools if there's no UI yet) → the
   main window's store updates live. That exercises edit #5.
5. `pnpm build` clean, `pnpm test` green.

## Commit

`feat(settings): add a multi-repo registry with a single-root compatibility shim`
