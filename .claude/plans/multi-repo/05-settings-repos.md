# Phase 5 — Settings: "Source repos" block

> Read `00-INDEX.md` first. Requires Phases 3–4.

## Goal

Give the user a place to add, name, and remove source repos. Also closes **bug #7**: `App.tsx:502`
already bounces to `openSettingsWindow("general")` when no repo is set, onto a page that has nothing
to set today.

**File:** `src/settings/sections/GeneralSection.tsx` — a **7th block**, not a new section. Append it
as a sibling before the closing `</div>` at `:356`.

## Current structure of GeneralSection

Six blocks inside one `<div className="flex flex-col gap-6">` (`:120`):
`SectionHeader` (`:121-124`), Appearance (`:126-146`), Display (`:148-169`),
Startup (`:171-193`), Code editor (`:195-288`), External editor (`:290-355`).

## What to copy — and what NOT to

**Do NOT use `SettingRow`** (`src/settings/components/SettingRow.tsx:14-33`). It is
`flex items-start justify-between` with `shrink-0` on the control (`:18`, `:30`) — built for one
label + one control, not a variable-length list of paths with per-row actions.

**Copy `src/settings/sections/BestPracticesSection.tsx`** instead. It is the existing precedent for a
list-of-file-paths preference: `openDialog` at `:32`, list read at `:61`, nested block layout at
`:143` / `:188` / `:201`.

The outer block wrapper follows `GeneralSection.tsx:171-193`:

```tsx
<div className="flex flex-col gap-2">
  <Label>Source repos</Label>
  <div className="flex flex-col gap-2">
    {/* rows */}
  </div>
</div>
```

`Label` is a **file-local, non-exported** helper at `GeneralSection.tsx:379-385` — reuse it in-file.

## Layout

```
┌ Source repos ───────────────────────────────────────────────────┐
│  repo-one     C:\dev\repo-one      main    ADO: RepoOne    ⋯     │
│  repo-two     C:\dev\repo-two      feat/x  ADO: RepoTwo    ⋯     │
│  repo-three   C:\dev\repo-three    main    not linked      ⋯     │
│                                                                 │
│  + Add folder…       ⌕ Scan a folder…                           │
└─────────────────────────────────────────────────────────────────┘
```

Per row: name (editable), absolute path (muted, truncating, full path in a tooltip), current branch,
ADO binding, and a `⋯` menu.

- **Branch** comes from `git_repo_info` per repo. Show a `<Skeleton>` while loading, and a muted
  "not a git repository" when `isRepo` is false — a non-git folder is allowed as a source repo.
- **ADO binding** renders "not linked" until Phase 12 wires it. The `⋯` → "Set ADO repo…" item can be
  present-but-disabled this phase, or added in Phase 12 — either is fine, just don't ship a menu item
  that silently does nothing.

## Actions

- **Add folder…** — reuse the existing `openDialog({ directory: true, multiple: false, title, defaultPath })`
  from `App.tsx:898-912`. Default the name to the folder basename; ensure uniqueness by appending a
  numeric suffix if it collides.
- **Scan a folder…** — pick a parent directory, `fs_read_dir` **one level**, keep entries containing
  a `.git` child, present them as checkboxes with an "Add N repos" confirm. This covers the
  clone-many-into-one-parent flow that `GetSourceCodeDialog` already produces.
- **`⋯` menu** — Rename, Set ADO repo… (Phase 12), Remove. Removing is not destructive to disk; say
  so in the item's `description`.

Name edits validate: non-empty, unique (case-insensitive), no `/` or `\`. Show the error inline; the
`setRepos` validation added in Phase 3 is the backstop, not the UX.

## Verify

1. Add, rename, and remove a repo. Each change persists across a settings-window reopen.
2. Adding a repo updates the **main window** live — that exercises the Phase 3 key-map entry. If it
   doesn't, edit #5 of Phase 3 is missing.
3. "Scan a folder…" on a directory containing several clones offers exactly the git repos, not every
   subfolder.
4. Rename to a duplicate name → rejected with an inline message.
5. With zero repos configured, trigger "Review a commit" from the command palette → it bounces to
   Settings → General and the block is right there (bug #7 closed).
6. `pnpm test` green.

## Commit

`feat(settings): add a source repos block to General`
