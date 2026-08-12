# Phase 6 — Status bar: multi-repo

> Read `00-INDEX.md` first. Requires Phases 3–5.

## Do this first — it blocks everything else in the phase

**Bug #9: there is already a split source of truth in the status bar.**

`StatusBarGit` takes `sourceRoot` as a **prop** (`App.tsx:1548`) but reads status from the store:

```ts
const status = useSourceDirStatus();          // StatusBarGit.tsx:60
```

and `useSourceDirStatus.ts:21` is hardwired to the **global** pref. Meanwhile `gitBranches(cwd)`
(`:215`) *does* honour the prop.

So a second segment rendered for repo B would list **B's branches** while showing **A's** branch
label, dirty dot, ahead/behind and `parkedHere` — and `requestSwitch(cwd, item.name, status)`
(`:376`, `:391`) would feed A's status into a B checkout decision, which is how you get a wrong
carry/stash choice.

**Thread a cwd into `useSourceDirStatus` before touching any UI.**

## Target UI

- **N = 1: pixel-identical to today.** Folder segment + branch pill, same tooltips, same copy.
- **N > 1:** the folder segment shows `3 repos`; the branch segment shows `3 repos · 1 dirty` and
  opens a popover with one row per repo — name, branch, dirty dot, ahead/behind chips, parked-stash
  pill. Clicking a row drills into that repo's existing `BranchSwitcher` content with
  `cwd={repo.root}`. Footer keeps Fetch / Pull latest, acting on the drilled-into repo.
  `+ Add folder…` at the bottom.

## Existing structure (don't break these)

`src/modules/git/StatusBarGit.tsx`:

- Container `:67` — `flex h-5 items-stretch overflow-hidden rounded-md border border-border/60 bg-card text-[10.5px]`
- Folder button `:70-80`; basename computed `:62-64`, rendered `:77-79`; tooltip `:82-109`
- **TWO identical dividers**: `:114` (repo branch) and `:119` (non-repo branch). Both are
  `<span aria-hidden className="w-px self-stretch bg-border/70" />`. Handle **both** arms or you get
  a doubled or missing hairline.
- `<BranchSwitcher cwd={sourceRoot} status={status} />` at `:115`, inside the
  `sourceRoot && status.isRepo` branch `:112-116`
- `<GetSourceCodeButton …>` at `:120`, inside the else branch `:117-122`
- Popover `:336-473`. Easy to miss inside it: `CommandEmpty` (`:340-342`), the "fetched Xm ago"
  readout (`:445-449`), and the amber fetch-note strip (`:453-468`) sharing the footer container
  with a conditional `border-t`.
- Groups: "Stashed here" `:345`, "Local" `:370`, "Remote" `:385`. Footer: Fetch `:408-415`,
  Pull latest `:418-443`.

## Supporting changes

**Hooks** — `useSourceDirGitInfo` / `useSourceDirStatus` → `useReposGitInfo()` / `useReposStatus()`
returning `Map<repoId, …>`. Keep the same cadence: 30 s poll (`REFRESH_MS`, `:23` and `:12`), window
focus, and the change event. Fan out with `Promise.all`.

**Fix bug #10 while here.** The two hooks subscribe to *different halves* of a dual emit:

- `useSourceDirGitInfo.ts:71` → Tauri bus (`void listen(SOURCE_GIT_CHANGED_EVENT, …)`) — cross-window
- `useSourceDirStatus.ts:55` → DOM only (`window.addEventListener(…)`) — same-window

So a git action from another window refreshes the branch label but not the dirty chips (which then
wait up to 30 s or a refocus). Make both listen to both.

**Event payload** — `emitSourceGitChanged()` (`gitOps.ts:140-149`) is payload-less on both buses:

```ts
export function emitSourceGitChanged(): void {
  window.dispatchEvent(new CustomEvent(SOURCE_GIT_CHANGED_EVENT));
  void emit(SOURCE_GIT_CHANGED_EVENT).catch(() => {});
}
```

Add `{ root: string }` so listeners refresh only that repo. **Listeners must tolerate a missing
payload** and treat it as "refresh all" — `cloneProgressStore.ts:219` and any future caller would
otherwise silently stop refreshing.

**Branch switching** — `useBranchSwitch.ts` has a module-global `let opToken = 0` (`:58`). Today
starting an op on repo B cancels an in-flight op on repo A at every one of `:122, :128, :145, :175,
:194, :199, :235` (`if (token !== opToken) return`). Make it `Map<cwd, number>`.

`toast` / `confirm` are singletons initialized at `:267-269`. Make them `Map<cwd, …>`; render toasts
as a vertical stack of capsules (`BranchSwitchToast` currently positions one). `BranchSwitchDialog`
copy (`:66-83`) names the branch and the source branch but never the repo — add it.

**Clone** — `cloneProgressStore.ts:212-233` calls `setSourceRoot(path)` at `:219`, which is what
forces one clone to become *the* root. Make it **append** a repo instead. `GetSourceCodeDialog`
already clones N selected repos into one parent (`:112-273`), so all N get added. Toast copy
"Now working in X" → "Added X" / "Added N repos".

## Intermediate state (expected)

After this phase the user can configure N repos and see all of them, but the AI still reads only
`repos[0]` until Phase 7. That's deliberate — building the UI first makes Phase 7 testable the
moment it lands.

## Verify

1. **N=1 regression:** with one repo, the status bar is visually identical to before. Switch a
   branch, park a dirty tree, restore it — all unchanged.
2. Three repos on different branches with different dirty states → each row shows **its own** state
   (this is the bug #9 check; before the fix every row showed repo[0]'s).
3. Drilling into a repo lists that repo's branches and switches only that repo.
4. Start a branch switch in one repo and immediately another in a second repo → both complete, two
   toasts, neither cancels the other.
5. A git change made from the Settings window refreshes **both** the branch label and the dirty chips
   (bug #10).
6. Clone two repos from the wizard → both are added; neither replaces the existing list.
7. `pnpm test` green.

## Commit

`feat(git): show and switch branches for every configured repo`
