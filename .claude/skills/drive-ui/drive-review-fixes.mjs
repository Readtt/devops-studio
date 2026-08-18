// The two UI-visible fixes out of the /code-review pass:
//
//   1. StatusBarGit's repo list conflated "this repo hasn't been polled yet"
//      with "this isn't a git repository" — every row rendered disabled and
//      labelled on every cold start, because `statuses.get(id) ?? EMPTY_STATUS`
//      hands back `isRepo: false` for a repo nobody has read yet.
//   2. CommitReviewPane's empty-workspace guard ran before findings rendered,
//      so a SAVED review reopened from History showed "No source repos yet"
//      instead of the findings already on disk.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-review-fixes.mjs

import { click, clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const BRANCH_SEGMENT = 'button[aria-label="Switch a repo\'s git branch"]';

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const repo = (n) => ({
  id: `r${n}`,
  name: `repo-${n}`,
  root: `C:\\dev\\repo-${n}`,
  ado: null,
});

const st = (branch, isRepo = true) => ({
  isRepo,
  branch,
  commit: "a1b2c3d",
  detached: false,
  upstream: `origin/${branch}`,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  dirty: false,
  parkedHere: false,
});

const REPO_INFO = {
  "C:\\dev\\repo-1": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
  "C:\\dev\\repo-2": { branch: "main", commit: "b2c3d4e", isRepo: true, detached: false },
  "C:\\dev\\repo-3": { branch: "main", commit: "c3d4e5f", isRepo: true, detached: false },
};

async function open(fixture, extra = "") {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { localStorage.clear(); } catch {}",
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(fixture, extra) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1300,
    height: 950,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
  await wait(4000);
  return { cdp, errors };
}

/** Poll for a selector rather than guessing a sleep — the status bar's segments
 *  land a beat after first paint, and a fixed wait races them. */
async function waitFor(cdp, selector, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const there = await evaluate(
      cdp,
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (there) return;
    if (Date.now() > deadline) throw new Error(`never appeared: ${selector}`);
    await wait(250);
  }
}

/** Every repo row in the open switcher, with how it reads and whether it's dead. */
const READ_ROWS = `[...document.querySelectorAll('[cmdk-item]')].map(el => ({
  text: el.textContent.trim(),
  disabled: el.getAttribute("aria-disabled") === "true" || el.dataset.disabled === "true",
  skeleton: !!el.querySelector('[data-slot="skeleton"]'),
}))`;

// ===== 1a. the poll hasn't answered yet ====================================
{
  // `git_status_summary` never resolves: exactly the window between mount and
  // the first poll landing, which on a cold start is every repo at once.
  const HANG = `if (cmd === "git_status_summary") return new Promise(() => {});`;
  const { cdp, errors } = await open(
    {
      prefs: { theme: "dark", repos: [repo(1), repo(2), repo(3)] },
      commands: {
        git_repo_info: REPO_INFO,
        ado_get_connection: { configured: false, hasPat: false, orgUrl: "", project: "" },
      },
    },
    HANG,
  );

  await waitFor(cdp, BRANCH_SEGMENT);
  await click(cdp, BRANCH_SEGMENT);
  await wait(800);
  const rows = JSON.parse(await evaluate(cdp, `JSON.stringify(${READ_ROWS})`));
  console.log("unpolled rows:", JSON.stringify(rows));

  check(
    "an unread repo is not called 'not a git repository'",
    rows.filter((r) => /not a git repository/i.test(r.text)).length,
    0,
  );
  check("an unread repo stays selectable", rows.filter((r) => r.disabled).length, 0);
  check("an unread repo shows a skeleton", rows.filter((r) => r.skeleton).length, 3);

  await shot(cdp, `${OUT}/fix-repos-unpolled.png`, {
    selector: '[data-slot="popover-content"]',
  });
  check("no console errors (unpolled)", errors, []);
}

// ===== 1b. the poll answered, and one really isn't a repo ===================
{
  const { cdp, errors } = await open({
    prefs: { theme: "dark", repos: [repo(1), repo(2), repo(3)] },
    commands: {
      git_repo_info: REPO_INFO,
      git_status_summary: {
        "C:\\dev\\repo-1": st("main"),
        "C:\\dev\\repo-2": st("main"),
        "C:\\dev\\repo-3": st("", false),
      },
      ado_get_connection: { configured: false, hasPat: false, orgUrl: "", project: "" },
    },
  });

  await waitFor(cdp, BRANCH_SEGMENT);
  await click(cdp, BRANCH_SEGMENT);
  await wait(800);
  const rows = JSON.parse(await evaluate(cdp, `JSON.stringify(${READ_ROWS})`));
  console.log("polled rows:", JSON.stringify(rows));

  check(
    "a folder that really isn't a repo still says so",
    rows.filter((r) => /not a git repository/i.test(r.text)).map((r) => r.disabled),
    [true],
  );
  check("the repos that answered are selectable", rows.filter((r) => !r.disabled).length, 2);
  check("nothing is stuck on a skeleton once polled", rows.filter((r) => r.skeleton).length, 0);

  await shot(cdp, `${OUT}/fix-repos-polled.png`, {
    selector: '[data-slot="popover-content"]',
  });
  check("no console errors (polled)", errors, []);
}

// ===== 2. a saved review reopened with an EMPTY workspace ===================
{
  const FINDING = {
    id: "f1",
    title: "Wrong default in the two-repo seam",
    category: "correctness",
    severity: "high",
    file: "repo-two/src/two.ts",
    startLine: 2,
    endLine: 2,
    explanation: "The default contradicts the caller in repo-one.",
    evidence: "repo-one/src/one.ts:4 passes no value.",
    confidence: "high",
    verified: true,
  };
  const ROW = {
    runId: "crun-saved",
    cwd: JSON.stringify(["C:\\dev\\repo-one", "C:\\dev\\repo-two"]),
    commitSha: "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
    commitShort: "bbb1111",
    commitSubject: "two: middle",
    commits: JSON.stringify([
      {
        sha: "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
        short: "bbb1111",
        subject: "two: middle",
        repoId: "r2",
        repoName: "repo-two",
      },
    ]),
    status: "done",
    modelId: null,
    context: null,
    findings: JSON.stringify([FINDING]),
    appliedPatches: "{}",
    error: null,
    findingCount: 1,
    durationMs: 4200,
    createdAt: "2026-01-05T10:00:00Z",
    updatedAt: "2026-01-05T10:05:00Z",
  };

  // The workspace the review ran in is GONE — folders moved, or removed in
  // Settings after the run. The findings are still on disk.
  const { cdp, errors } = await open({
    prefs: { theme: "dark", repos: [], codeSearchEnabled: true, sidebarView: "history" },
    commands: {
      commit_review_list: [
        {
          runId: ROW.runId,
          cwd: ROW.cwd,
          commitSha: ROW.commitSha,
          commitShort: ROW.commitShort,
          commitSubject: ROW.commitSubject,
          commits: ROW.commits,
          status: "done",
          modelId: null,
          findingCount: 1,
          durationMs: 4200,
          createdAt: ROW.createdAt,
          updatedAt: ROW.updatedAt,
        },
      ],
      commit_review_get: ROW,
      commit_review_sweep_stale: 0,
      ai_checkpoint_list: [],
      ai_checkpoint_get: null,
      ado_test_connection: { __reject: "not connected" },
    },
  });

  await clickText(cdp, "History");
  await wait(700);
  await clickText(cdp, "Commit reviews");
  await wait(900);
  await clickText(cdp, "two: middle");
  await wait(2500);

  const pane = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
         finding: document.body.innerText.includes("Wrong default in the two-repo seam"),
         emptyState: document.body.innerText.includes("No source repos yet"),
       })`,
    ),
  );
  console.log("saved review pane:", JSON.stringify(pane));

  check("the saved run's findings render", pane.finding, true);
  check("the empty-workspace state does not hide them", pane.emptyState, false);

  await shot(cdp, `${OUT}/fix-saved-review-no-repos.png`);
  check("no console errors (saved review)", errors, []);
}

console.log("");
if (fail.length) {
  console.log("FAILURES:\n" + fail.join("\n"));
  process.exit(1);
}
console.log("all checks passed");
