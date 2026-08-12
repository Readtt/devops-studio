// Worked example: drives Settings → General → Source repos.
//
// Run it to confirm the harness itself still works before you trust a run
// against your own change:
//     pnpm dev                                    # in one shell
//     node .claude/skills/drive-ui/example.mjs    # in another
//
// Copy this file, swap the fixture and the assertions, keep the shape.

import {
  clickText,
  connect,
  evaluate,
  pressKey,
  shot,
  typeInto,
  wait,
  watchErrors,
} from "./cdp.js";
import { lastWrite, MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const NAME_INPUT = 'input[aria-label="Repo name"]';

const FIXTURE = {
  prefs: {
    theme: "dark",
    repos: [
      { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
      { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
    ],
  },
  commands: {
    // Path-keyed: a root with no entry rejects, which is what a non-repo does.
    git_repo_info: {
      "C:\\dev\\repo-one": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
      "C:\\dev\\repo-two": { branch: null, commit: "d4e5f6a", isRepo: true, detached: true },
    },
    fs_read_dir: {
      "C:\\dev\\clones": [
        { name: "alpha", kind: "dir", size: 0, mtime: 0 },
        { name: "not-a-repo", kind: "dir", size: 0, mtime: 0 },
        { name: "README.md", kind: "file", size: 12, mtime: 0 },
      ],
    },
    fs_stat: { "C:\\dev\\clones\\alpha\\.git": { size: 4096 } },
  },
};

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
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
await shot(cdp, `${OUT}/drive-ui-example.png`);

check(
  "each repo row shows its branch",
  await evaluate(
    cdp,
    `[...document.querySelectorAll('${NAME_INPUT}')]
       .map(i => i.closest("div.rounded-lg").innerText.split("\\n").slice(0,2).join(" | "))`,
  ),
  ["main", "d4e5f6a (detached)"].map((b, i) => `${b} | ${["not linked", "not linked"][i]}`),
);

// Rename row 2 onto row 1's name, different case — refused inline, never written.
await typeInto(cdp, NAME_INPUT, "REPO-ONE", 1);
await pressKey(cdp, "Enter");

check(
  "duplicate rename is refused inline",
  await evaluate(
    cdp,
    `document.querySelectorAll('${NAME_INPUT}')[1]
       .closest("div.rounded-lg").innerText.includes("already uses that name")`,
  ),
  true,
);
check(
  "...and nothing was persisted",
  (await lastWrite(cdp, evaluate, "repos")) ?? "no write",
  "no write",
);

// Scan a folder: only directories carrying a .git are offered.
await evaluate(cdp, `window.__MOCK.dialog = "C:\\\\dev\\\\clones"; true`);
await clickText(cdp, "Scan a folder");
await wait(1000);
check(
  "scan lists only git repositories",
  await evaluate(
    cdp,
    `[...document.querySelector('[role="dialog"]').querySelectorAll("label")]
       .map(l => l.innerText.trim())`,
  ),
  ["alpha"],
);
await shot(cdp, `${OUT}/drive-ui-example-dialog.png`);

await clickText(cdp, "Add 1 repo");
await wait(1000);
check(
  "confirming writes the new root to the registry",
  (await lastWrite(cdp, evaluate, "repos")).map((r) => r.root),
  ["C:\\dev\\repo-one", "C:\\dev\\repo-two", "C:\\dev\\clones\\alpha"],
);

check("no console errors", errors, []);
cdp.close();

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
