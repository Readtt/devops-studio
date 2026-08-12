# Phase 12 — ADO repo binding

> Read `00-INDEX.md` first. Requires Phases 2, 5, 9.

## Goal

Stop guessing the repo behind a published code link. Today `repoName` is model-invented and the
project comes from the global connection — wrong for any repo living in another ADO project.

## 1. Rust — the plan's only Rust change outside Phase 1

Add `remote_url: Option<String>` to `GitRepoInfo` (`src-tauri/src/modules/git.rs:33-44`), populated
from `git config --get remote.origin.url`. Additive to a `Serialize` struct, so all four existing
consumers are unaffected.

Use `hide_console()` for the spawn, like every other command in this file.

## 2. Matching

Normalise both sides — strip a trailing `.git`, strip `user:pass@` userinfo, lowercase host and path
— then compare against `RepoRef.remoteUrl` from `listRepos()` (`ado/native.ts:508-511`, takes no
arguments, org-wide).

`RepoRef` (`ado/types.ts:286-297`) carries **both** `remoteUrl` and `project`, each
`.nullable().optional()` — so handle `string | null | undefined` on both. Backed by Rust at
`src-tauri/src/modules/ado/repos.rs:588-599`.

Fallback order: exact normalised remote match → repo basename match → leave unbound.

Bind on repo add, and offer a manual re-run from the repo row (remotes change).

## 3. Manual override

A cmdk-in-Popover picker modelled on `BranchPicker.tsx:111-199`, listing `listRepos()` grouped by
project. Wire it to the `⋯` → "Set ADO repo…" item stubbed in Phase 5.

With no ADO connection configured, the row reads "connect Azure DevOps to link repos" rather than
showing an empty picker.

## 4. Link construction

- `SourceLink` (`ado/types.ts:348-360`) has **no** `project` field today and all five string fields
  are required. Add `project` as **optional**.
- `buildAdoReposWebUrl` (`ado/native.ts:615-633`) takes `project` from the repo binding instead of
  the connection. The call site is `TestCasePane.tsx:425-435`, where `project` currently comes from
  `conn` (`:54`, populated `:200`, guarded `:426`) — the single globally-configured connection
  project.
- Note it keys on **`repoName`, not `repoId`**, even though `SourceLink` carries both. Keep that;
  just make the name come from the binding.
- `sourceLinksParser.ts` emits `project:` and **tolerates its absence**. `parseLine:75-80` builds a
  `Map` from every `key: value` part and reads only known keys, so adding a key won't break an older
  build, and reading it as `fields.get("project") ?? <connection fallback>` won't break on older
  rows.

  **Do NOT make `project` a required key.** `:84` drops the entire line when a required key is
  missing — that would erase the links on every previously-published case. The Phase 2 round-trip
  tests cover exactly this; extend them with a `project` case.

## Scope limit — state this plainly

`ado_list_repos` is org-wide (`repos.rs:22-24` says so explicitly), but **every other repo API is
project-scoped to the connection** via `project_api(&conn, …)`: `get_file` (`:37`),
`list_commits_since` (`:78`), and the branches / PR / diff calls.

So adding `project` to `SourceLink` fixes the **web URL** only. Making `getFile` and diffs work
cross-project requires Rust signature changes and is **out of scope for this plan.** Don't start it;
note it if it comes up.

## Verify

1. Add three repos with real ADO remotes → all three auto-bind to the right ADO repo and project.
2. Add a repo with a non-ADO remote (or none) → it stays unbound, with a clear row state, and
   publishing still works using the repo's display name.
3. Manually override one binding → it persists and is used on the next publish.
4. Publish a batch whose cases reference two repos → each link opens the right file in the right
   repo. If one repo lives in a different ADO project than the connection, its link is now correct
   (it was broken before).
5. Open a case published **before** this phase → its links still resolve (the `project` fallback).
6. `pnpm test` green, including the extended `sourceLinksParser.test.ts`.

## Commit

`feat(ado): bind each source repo to its ADO repo and project`
