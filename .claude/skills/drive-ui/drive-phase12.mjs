// Drives Phase 12's ADO repo binding in Settings → General → Source repos:
// auto-detect from the git remote, the manual picker grouped by project, and
// the two states that must not offer a picker at all (no match, no connection).
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-phase12.mjs

import { click, clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { lastWrite, MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const NAME_INPUT = 'input[aria-label="Repo name"]';

const REPOS = [
  // Already bound — the row shows what it points at.
  {
    id: "r1",
    name: "repo-one",
    root: "C:\\dev\\repo-one",
    ado: { repoId: "guid-api", repoName: "Contoso.Api", project: "Payments" },
  },
  // Unbound, ADO remote → detects.
  { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
  // Unbound, GitHub remote and a name no ADO repo carries → stays unbound.
  { id: "r3", name: "repo-three", root: "C:\\dev\\repo-three", ado: null },
];

const GIT = {
  "C:\\dev\\repo-one": {
    branch: "main",
    commit: "a1b2c3d",
    isRepo: true,
    detached: false,
    remoteUrl: "https://contoso@dev.azure.com/contoso/Payments/_git/Contoso.Api",
  },
  "C:\\dev\\repo-two": {
    branch: "main",
    commit: "b2c3d4e",
    isRepo: true,
    detached: false,
    // The userinfo form git records, vs the bare one ADO's API reports.
    remoteUrl: "https://contoso@dev.azure.com/contoso/Storefront/_git/Contoso.Web.git",
  },
  "C:\\dev\\repo-three": {
    branch: "main",
    commit: "c3d4e5f",
    isRepo: true,
    detached: false,
    remoteUrl: "git@github.com:acme/unrelated.git",
  },
};

// Two projects, and a name that repeats across them — the case where a
// basename match must refuse to guess.
const ADO_REPOS = [
  {
    id: "guid-api",
    name: "Contoso.Api",
    project: "Payments",
    remoteUrl: "https://dev.azure.com/contoso/Payments/_git/Contoso.Api",
    defaultBranch: "main",
  },
  {
    id: "guid-web",
    name: "Contoso.Web",
    project: "Storefront",
    remoteUrl: "https://dev.azure.com/contoso/Storefront/_git/Contoso.Web",
    defaultBranch: "main",
  },
  {
    id: "guid-shared-p",
    name: "shared",
    project: "Payments",
    remoteUrl: "https://dev.azure.com/contoso/Payments/_git/shared",
    defaultBranch: "main",
  },
  {
    id: "guid-shared-s",
    name: "shared",
    project: "Storefront",
    remoteUrl: "https://dev.azure.com/contoso/Storefront/_git/shared",
    defaultBranch: "main",
  },
];

const CONNECTED = {
  configured: true,
  hasPat: true,
  orgUrl: "https://dev.azure.com/contoso",
  project: "Payments",
  defaultTrackingBranch: "$current",
};

const fixture = (connected) => ({
  prefs: { theme: "dark", repos: REPOS },
  commands: {
    git_repo_info: GIT,
    ado_list_repos: { __value: ADO_REPOS },
    ado_get_connection: connected
      ? CONNECTED
      : { ...CONNECTED, configured: false, hasPat: false },
  },
});

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

/** The ADO cell of every row, in order. */
const adoCells = (cdp) =>
  evaluate(
    cdp,
    `[...document.querySelectorAll('[aria-label^="Azure DevOps repository for"], span')]
       .filter(el => el.getAttribute("aria-label")?.startsWith("Azure DevOps repository for")
                  || el.textContent.trim() === "connect Azure DevOps to link repos")
       .map(el => el.innerText.trim())`,
  );

/** Open the ⋯ menu of row `i` (0-based). */
async function openRowMenu(cdp, i) {
  await evaluate(
    cdp,
    `(() => {
       const rows = [...document.querySelectorAll('${NAME_INPUT}')].map(el => el.closest("div.rounded-lg"));
       const btn = rows[${i}].querySelector('button[aria-label^="Actions for"]');
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true };
       btn.dispatchEvent(new PointerEvent("pointerdown", o));
       btn.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(500);
}

async function menuItem(cdp, label) {
  return evaluate(
    cdp,
    `(() => {
       const el = [...document.querySelectorAll('[role="menuitem"]')]
         .find(m => m.innerText.includes(${JSON.stringify(label)}));
       return el ? { disabled: el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled") } : null;
     })()`,
  );
}

async function clickMenuItem(cdp, label) {
  await evaluate(
    cdp,
    `(() => {
       const el = [...document.querySelectorAll('[role="menuitem"]')]
         .find(m => m.innerText.includes(${JSON.stringify(label)}));
       if (!el) throw new Error("no menu item: " + ${JSON.stringify(label)});
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(900);
}

async function boot(connected) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(fixture(connected)) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/settings.html" });
  await wait(3500);
  await evaluate(
    cdp,
    `[...document.querySelectorAll("span")]
       .find(s => s.textContent.trim() === "Source repos")
       .scrollIntoView({ block: "start" });
     window.scrollBy(0, -12); true`,
  );
  await wait(400);
  return { cdp, errors };
}

// ── connected ────────────────────────────────────────────────────────────
{
  const { cdp, errors } = await boot(true);

  check("a bound row names its ADO repo; unbound rows say so", await adoCells(cdp), [
    "ADO: Contoso.Api",
    "not linked",
    "not linked",
  ]);
  await shot(cdp, `${OUT}/drive-phase12-rows.png`);

  // ── detect from the remote (row 2: userinfo HTTPS remote) ──────────────
  await openRowMenu(cdp, 1);
  await clickMenuItem(cdp, "Detect from remote");
  check(
    "detecting binds repo-two to the repo its remote names",
    (await lastWrite(cdp, evaluate, "repos"))?.map((r) => r.ado?.repoName ?? null),
    ["Contoso.Api", "Contoso.Web", null],
  );
  check(
    "...with the OWNING project, not the connection's",
    (await lastWrite(cdp, evaluate, "repos"))?.[1]?.ado,
    { repoId: "guid-web", repoName: "Contoso.Web", project: "Storefront" },
  );

  // ── a repo nothing matches stays unbound and says why ──────────────────
  await openRowMenu(cdp, 2);
  await clickMenuItem(cdp, "Detect from remote");
  check(
    "an unmatched repo is told, not guessed at",
    await evaluate(
      cdp,
      `[...document.querySelectorAll('${NAME_INPUT}')][2]
         .closest("div.rounded-lg").innerText.includes("No Azure DevOps repository matches")`,
    ),
    true,
  );
  check(
    "...and nothing was written for it",
    (await lastWrite(cdp, evaluate, "repos"))?.[2]?.ado ?? null,
    null,
  );
  await shot(cdp, `${OUT}/drive-phase12-no-match.png`);

  // ── manual override, grouped by project ────────────────────────────────
  await click(cdp, '[aria-label="Azure DevOps repository for repo-three"]');
  await wait(900);
  check(
    "the picker groups the org's repos by project",
    await evaluate(
      cdp,
      // textContent, not innerText: the heading is CSS-uppercased, and the
      // assertion is about which projects are there, not their casing.
      `[...document.querySelectorAll('[cmdk-group-heading]')].map(h => h.textContent.trim())`,
    ),
    ["Payments", "Storefront"],
  );
  check(
    "...and lists every repo, including the name two projects share",
    await evaluate(
      cdp,
      `[...document.querySelectorAll('[cmdk-item]')].map(i => i.innerText.trim())`,
    ),
    ["Contoso.Api", "shared", "Contoso.Web", "shared"],
  );
  await shot(cdp, `${OUT}/drive-phase12-picker.png`);

  // Pick the "shared" under Storefront — the second of the two, which is the
  // pick a basename match would have had to guess at.
  await evaluate(
    cdp,
    `(() => {
       const el = [...document.querySelectorAll('[cmdk-item]')]
         .filter(i => i.innerText.trim() === "shared")[1];
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(900);
  check(
    "a hand-picked repo persists with its own project",
    (await lastWrite(cdp, evaluate, "repos"))?.[2]?.ado,
    { repoId: "guid-shared-s", repoName: "shared", project: "Storefront" },
  );
  check("the row now names it", (await adoCells(cdp))[2], "ADO: shared");

  // ── unlink ─────────────────────────────────────────────────────────────
  await click(cdp, '[aria-label="Azure DevOps repository for repo-three"]');
  await wait(900);
  await evaluate(
    cdp,
    `(() => {
       const el = [...document.querySelectorAll('[cmdk-item]')]
         .find(i => i.innerText.trim() === "Not linked");
       if (!el) throw new Error("no 'Not linked' item");
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(900);
  check(
    "unlinking clears the binding",
    (await lastWrite(cdp, evaluate, "repos"))?.[2]?.ado ?? null,
    null,
  );

  check("no console errors", errors, []);
  cdp.close();
}

// ── not connected ────────────────────────────────────────────────────────
{
  const { cdp, errors } = await boot(false);

  check("with no connection the row says what to do instead", await adoCells(cdp), [
    "connect Azure DevOps to link repos",
    "connect Azure DevOps to link repos",
    "connect Azure DevOps to link repos",
  ]);
  await shot(cdp, `${OUT}/drive-phase12-disconnected.png`);

  await openRowMenu(cdp, 0);
  check("...and the linking actions are disabled, not silently dead", {
    set: (await menuItem(cdp, "Set ADO repo"))?.disabled,
    detect: (await menuItem(cdp, "Detect from remote"))?.disabled,
    rename: (await menuItem(cdp, "Rename"))?.disabled,
  }, { set: true, detect: true, rename: false });

  check("no console errors (disconnected)", errors, []);
  cdp.close();
}

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
