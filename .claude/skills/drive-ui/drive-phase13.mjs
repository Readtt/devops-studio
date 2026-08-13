// Phase 13 smoke: five modules were deleted, so the question is whether every
// window still boots and the two surfaces whose repo reads changed still say
// the right thing.
//
//   1. Azure DevOps → code-link explainer at ZERO repos (the branch that used
//      to read a root to answer "is the workspace empty?").
//   2. Same explainer with a repo that isn't a git repo.
//   3. The main window boots clean with the ai/tools stack gone.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-phase13.mjs

import { connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok)
    fail.push(
      `${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`,
    );
};

async function open(fixture, url, { freshStorage = false } = {}) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // The tab tree persists to localStorage, which is per-ORIGIN and so survives
  // between drivers — a leftover tab from another run would boot this one into
  // a pane the fixture never described.
  if (freshStorage)
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.clear(); } catch {}`,
    });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: MOCK(fixture),
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url });
  await wait(3500);
  return { cdp, errors };
}

/** The "now" capsule under Code-link branch — one line of explainer text.
 *  The label is uppercased in CSS, so innerText hands back "NOW". */
const NOW_LINE = `[...document.querySelectorAll("span")]
   .find(s => s.textContent.trim() === "now")
   .parentElement.innerText.replace(/\\s+/g, " ").replace(/^NOW /i, "").trim()`;

const ADO = {
  ado_get_connection: {
    configured: true,
    hasPat: true,
    orgUrl: "https://dev.azure.com/contoso",
    project: "Payments",
    defaultTrackingBranch: "$current",
  },
};

/* 1 — no repos at all. */
{
  const { cdp, errors } = await open(
    { prefs: { theme: "dark", repos: [], codeSearchEnabled: true }, commands: ADO },
    "http://localhost:1420/settings.html?tab=azure-devops",
  );
  check(
    "zero repos → asks the user to set one up",
    await evaluate(cdp, NOW_LINE),
    "Set a source directory to enable code links.",
  );
  await shot(cdp, `${OUT}/drive-phase13-no-repos.png`);
  check("no console errors (zero repos)", errors, []);
  cdp.close();
}

/* 2 — one repo, and it isn't a git repo (git_repo_info rejects for its root). */
{
  const { cdp, errors } = await open(
    {
      prefs: {
        theme: "dark",
        repos: [
          { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
        ],
        codeSearchEnabled: true,
      },
      commands: { ...ADO, git_repo_info: {} },
    },
    "http://localhost:1420/settings.html?tab=azure-devops",
  );
  check(
    "a configured non-git repo gets the fallback copy, not the empty-workspace copy",
    await evaluate(cdp, NOW_LINE),
    "Not a git repository — links fall back to main.",
  );
  await shot(cdp, `${OUT}/drive-phase13-non-git.png`);
  check("no console errors (non-git repo)", errors, []);
  cdp.close();
}

/* 3 — the main window still boots with the ai/tools stack deleted. */
{
  const { cdp, errors } = await open(
    {
      prefs: {
        theme: "dark",
        repos: [
          { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
          { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
        ],
        codeSearchEnabled: true,
        sidebarView: "test-plans",
        developerMode: true,
      },
      commands: {
        ...ADO,
        git_repo_info: {
          "C:\\dev\\repo-one": {
            branch: "main",
            commit: "aaa1111",
            isRepo: true,
            detached: false,
          },
          "C:\\dev\\repo-two": {
            branch: "feat/x",
            commit: "bbb1111",
            isRepo: true,
            detached: false,
          },
        },
        git_status_summary: {
          "C:\\dev\\repo-one": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
          "C:\\dev\\repo-two": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
        },
        commit_review_list: [],
        commit_review_sweep_stale: 0,
        ai_checkpoint_list: [],
        detect_shells: [],
        ado_list_plans: [],
        ado_test_connection: { __reject: "not connected" },
      },
    },
    "http://localhost:1420/index.html",
    { freshStorage: true },
  );
  check(
    "the main window renders its shell",
    await evaluate(
      cdp,
      `document.querySelector("#root").innerText.length > 40`,
    ),
    true,
  );
  check(
    "the status bar summarises both repos",
    await evaluate(
      cdp,
      `document.body.innerText.includes("2 repos")`,
    ),
    true,
  );
  await shot(cdp, `${OUT}/drive-phase13-main.png`);
  check("no console errors (main window)", errors, []);
  cdp.close();
}

console.log(
  fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good",
);
process.exit(fail.length ? 1 : 0);
