---
name: drive-ui
description: Launch and drive DevOps Studio's UI to verify a frontend change actually works — clicks, typing, dialogs, screenshots, and assertions against the real React tree. Use when asked to run the app, screenshot a pane, or confirm a UI change works outside the test suite. Needs only `pnpm dev` (no Rust build), because it drives the webview in Chrome with the Tauri IPC boundary mocked.
---

# Driving this app's UI

`tsc` and vitest cannot see a pane that renders blank, a Radix menu that never
opens, or a form that looks right and silently fails to persist. This harness
drives the actual UI and asserts on what came out.

**It needs `pnpm dev` only.** The frontend is two plain Vite entries
(`index.html`, `settings.html`), so you do not need `pnpm tauri dev` or a Rust
build to verify a frontend change. Everything above the IPC boundary is real —
real React tree, real Tailwind, real Radix, real zustand stores, real
`store.ts`. Only the Rust side is faked.

That mock is a feature, not a compromise: it drives states this machine cannot
otherwise produce — twenty repos, a detached HEAD, an offline network share, an
ADO call that 500s.

## Run it

```bash
pnpm dev                                     # shell 1 — serves :1420

# shell 2
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --remote-debugging-port=9333 \
  --user-data-dir=/tmp/drive-ui-profile --no-first-run --hide-scrollbars \
  about:blank &

node .claude/skills/drive-ui/example.mjs     # confirms the harness still works
```

`example.mjs` drives Settings → General → Source repos and asserts six things.
Run it before trusting a run against your own change — if it fails, the harness
drifted from the app, not your feature.

Then copy it, swap the fixture and assertions, keep the shape.

## Stop what you started

Neither process reaps itself. A driver script connects over CDP and
disconnects; it never owns the lifecycle of the server or the browser, so
`pnpm dev` keeps holding :1420 and Chrome keeps holding :9333 long after the
last assertion printed — including past the end of the session that started
them, if it was backgrounded. **Kill both explicitly when you're done driving.**

```powershell
Get-NetTCPConnection -State Listen -LocalPort 1420,9333 -EA SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Leaving :1420 held is worse than untidy: `vite.config.ts` sets
`strictPort: true`, so the next `pnpm dev` doesn't fall back to another port —
it fails outright, and the failure reads like a broken install rather than a
server you forgot about.

## Writing a driver

```js
import { clickText, connect, evaluate, pressKey, shot, typeInto, wait, watchErrors } from "./cdp.js";
import { lastWrite, MOCK } from "./tauriMock.js";

const cdp = await connect();                 // always a FRESH tab — see below
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
await cdp.send("Page.navigate", { url: "http://localhost:1420/settings.html" });
await wait(3500);                            // hydration + first paint
```

`http://localhost:1420/index.html` for the main window instead.

### The fixture

```js
const FIXTURE = {
  prefs: { theme: "dark", repos: [...] },    // seeds the Tauri store = preferences
  commands: {
    // Path-keyed: the call's path/root/cwd picks the answer. A key with no
    // entry REJECTS, which is exactly what a missing file or non-repo does.
    git_repo_info: { "C:\\dev\\one": { branch: "main", isRepo: true, ... } },
    // Not path-shaped? give the value directly.
    ado_list_plans: [{ id: 1, name: "Plan" }],
    // Force a failure.
    ado_publish_case: { __reject: "TF401019: repository not found" },
  },
  dialog: "C:\\dev\\clones",                 // what the next file picker returns
};
```

Add commands as you need them. `MOCK(fixture, extraSource)` takes a second
argument of raw JS spliced into the command switch (with `cmd` and `args` in
scope) for anything the table can't express — stateful sequences, say.

### Asserting

Read facts out of the live DOM with `evaluate`, and check that a change actually
*persisted* with `lastWrite(cdp, evaluate, "repos")` — the difference between a
UI that looks right and one that works. `watchErrors` must come back empty; a
React render that throws still screenshots as a plausible-looking page.

`shot(cdp, path, { selector: "..." })` clips to one element, which is far more
readable than a full page when you changed one pane. **Then actually look at the
PNG** — assertions don't catch a control that rendered off-screen or unreadable.

## Four things that will waste an hour if you don't know them

1. **Screen capture of the real Tauri window does not work from an agent
   shell.** `CopyFromScreen` throws "The handle is invalid" — the shell has no
   interactive window station. Don't try to screenshot the desktop; drive the
   webview instead. This is the whole reason this harness exists.

2. **React's `onBlur` is `focusout`-delegated.** `el.dispatchEvent(new
   Event("blur"))` fires nothing, so any commit-on-blur handler silently
   no-ops and you'll conclude the feature is broken when it isn't. Use
   `typeInto` / `pressKey`, which go through CDP's real input pipeline.

3. **Radix opens on `pointerdown`, not `click`.** `el.click()` on a
   `DropdownMenuTrigger`, popover or select does nothing at all. Use `click` /
   `clickText`, which send the pointer sequence.

4. **`Page.addScriptToEvaluateOnNewDocument` is never cleared.** Reusing a tab
   across runs leaves the *previous* run's mock installed and you debug errors
   you already fixed. `connect()` creates a fresh target every time, so this is
   handled — but if you hand-roll a connection, it will bite.

Tauri v2 specifics the mock already encodes: `plugin:store|get` returns
`[value, exists]` (not a bare value), `plugin:event|emit` carries the payload as
a live object (not a JSON string), and `fs_stat` **rejects** on a missing path
rather than returning null.

## What this can't do

- **Cross-window liveness.** The settings window and main window syncing through
  `PREFS_CHANGED_EVENT` needs two real Tauri webviews. Verify that by hand, or
  lean on the store-level tests in `src/modules/settings/repos.test.ts`.
- **Anything whose behaviour is the Rust side.** You're asserting the frontend
  handles a given backend answer correctly, not that the backend gives it.
  Rust logic belongs in `cargo test`.
- **Real native dialogs, PTY, updater.** All mocked at the boundary.

Say so plainly when you report: "driven in the real webview against a mocked
Tauri IPC boundary" — not "tested in the app".

## Safety

The harness never touches the user's real settings: the mock keeps its own
in-memory store and the app under test is a browser tab. If you *do* run the
real app (`pnpm tauri dev`), back up
`%APPDATA%/app.devopsstudio.app/devops-studio-settings.json` first — the repo
registry and ADO binding live there.
