// Two things the multi-repo phase has to get right, driven end to end:
//
//   1. Bug #4 — "Apply this fix" writes into the repo the finding NAMES, not
//      whichever repo the status bar points at. Reopens a saved review whose
//      finding cites repo-two and asserts the fs_write_file path.
//   2. At exactly ONE repo the pane is unchanged: no repo chips in the picker,
//      no read-scope row, the plain "Local changes" trigger.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-commit-review-apply.mjs

import { click, clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const REPO_ONE = { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null };
const REPO_TWO = { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null };

const FINDING = {
  id: "f1",
  title: "Wrong default in the two-repo seam",
  category: "correctness",
  severity: "high",
  // Repo-PREFIXED, as the model emits and the prompts demand.
  file: "repo-two/src/two.ts",
  startLine: 2,
  endLine: 2,
  explanation: "The default contradicts the caller in repo-one.",
  evidence: "repo-one/src/one.ts:4 passes no value.",
  confidence: "high",
  verified: true,
  suggestedFix: {
    path: "repo-two/src/two.ts",
    startLine: 2,
    endLine: 2,
    replacement: "const timeout = 30_000;",
  },
};

const SAVED_ROW = {
  runId: "crun-saved",
  // The workspace this review ran in — a JSON array of roots.
  cwd: JSON.stringify([REPO_ONE.root, REPO_TWO.root]),
  commitSha: "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
  commitShort: "bbb1111",
  commitSubject: "two: middle",
  commits: JSON.stringify([
    {
      sha: "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
      short: "bbb1111",
      subject: "two: middle",
      repoId: REPO_TWO.id,
      repoName: REPO_TWO.name,
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

const commit = (sha, subject, date) => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject,
  author: "someone",
  date,
  relativeDate: "2 days ago",
  isRoot: false,
});

const diffFor = (sha, subject, path) => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject,
  author: "someone",
  date: "2026-01-03T10:00:00Z",
  isRoot: false,
  isMerge: false,
  isLocal: false,
  files: [{ path, additions: 1, deletions: 1, status: "modified" }],
  rawPatch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
  truncated: false,
  headSha: sha.slice(0, 7),
});

function fixture(repos) {
  return {
    prefs: { theme: "dark", repos, codeSearchEnabled: true, sidebarView: "history" },
    commands: {
      git_repo_info: {
        "C:\\dev\\repo-one": { branch: "main", commit: "aaa1111", isRepo: true, detached: false },
        "C:\\dev\\repo-two": { branch: "main", commit: "bbb1111", isRepo: true, detached: false },
      },
      git_status_summary: {
        "C:\\dev\\repo-one": { dirty: true, ahead: 0, behind: 0, parkedHere: false },
        "C:\\dev\\repo-two": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
      },
      git_list_commits: {
        "C:\\dev\\repo-one": [
          commit("aaa1111aaa1111aaa1111aaa1111aaa1111aaa1", "one: newest", "2026-01-05T10:00:00Z"),
        ],
        "C:\\dev\\repo-two": [
          commit("bbb1111bbb1111bbb1111bbb1111bbb1111bbb1", "two: middle", "2026-01-03T10:00:00Z"),
        ],
      },
      git_working_tree_diff: {
        "C:\\dev\\repo-one": {
          ...diffFor("local", "Uncommitted changes", "src/a.ts"),
          shortSha: "local",
          isLocal: true,
          headSha: "aaa1111",
        },
      },
      git_commit_diff: {
        "C:\\dev\\repo-one": diffFor(
          "aaa1111aaa1111aaa1111aaa1111aaa1111aaa1",
          "one: newest",
          "src/one.ts",
        ),
        "C:\\dev\\repo-two": diffFor(
          "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
          "two: middle",
          "src/two.ts",
        ),
      },
      commit_review_list: [
        {
          runId: SAVED_ROW.runId,
          cwd: SAVED_ROW.cwd,
          commitSha: SAVED_ROW.commitSha,
          commitShort: SAVED_ROW.commitShort,
          commitSubject: SAVED_ROW.commitSubject,
          commits: SAVED_ROW.commits,
          status: "done",
          modelId: null,
          findingCount: 1,
          durationMs: 4200,
          createdAt: SAVED_ROW.createdAt,
          updatedAt: SAVED_ROW.updatedAt,
        },
      ],
      commit_review_get: SAVED_ROW,
      commit_review_sweep_stale: 0,
      ai_checkpoint_list: [],
      ai_checkpoint_get: null,
      // Only repo-two's copy exists. A write against repo-one's root would
      // therefore fail loudly rather than silently corrupt the wrong file.
      fs_read_file: {
        "C:\\dev\\repo-two\\src\\two.ts": {
          kind: "text",
          content: "const a = 1;\nconst timeout = 5;\nconst c = 3;\n",
          size: 44,
        },
      },
      fs_write_file: { __value: null },
      ado_test_connection: { __reject: "not connected" },
    },
  };
}

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

async function open(repos) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { localStorage.clear(); } catch {}",
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(fixture(repos)) });
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

// =====================  1. Bug #4, at two repos  ============================
{
  const { cdp, errors } = await open([REPO_ONE, REPO_TWO]);

  // History → Reviews → the saved run.
  await clickText(cdp, "History");
  await wait(700);
  await clickText(cdp, "Commit reviews");
  await wait(900);
  await clickText(cdp, "two: middle");
  await wait(2500);

  const restored = await evaluate(
    cdp,
    `(() => {
       // Scoped to the read-scope row: [aria-pressed] alone also matches the
       // sidebar rail and the show-diff toggle.
       const label = [...document.querySelectorAll("label")]
         .find(l => l.textContent.includes("Repos the reviewer can read"));
       return {
         chips: label
           ? [...label.parentElement.querySelectorAll("button[aria-pressed]")]
               .map(b => b.textContent.trim())
           : null,
         finding: document.body.innerText.includes("Wrong default in the two-repo seam"),
         loc: [...document.querySelectorAll("button")]
           .map(b => b.textContent.trim())
           .find(t => t.startsWith("repo-two/src/two.ts")) ?? null,
       };
     })()`,
  );
  // The row's `cwd` names both repos — the reopened tab is bound to THOSE, not
  // to whatever the registry happens to hold today.
  check("a reopened saved run restores its own repo set", restored.chips, [
    "repo-one",
    "repo-two",
  ]);
  check("its findings render", restored.finding, true);
  check("the finding's location keeps the repo prefix", restored.loc, "repo-two/src/two.ts:2");

  await shot(cdp, `${OUT}/cr-apply-1-reopened.png`);

  // The before/after diff had to read the file to render — from repo-two.
  const reads = await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "fs_read_file").map(c => c.args.path)`,
  );
  check("the before-read resolved into repo-two", reads, ["C:\\dev\\repo-two\\src\\two.ts"]);

  await clickText(cdp, "Apply");
  await wait(1500);

  const writes = await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "fs_write_file")
       .map(c => ({ path: c.args.path, content: c.args.content }))`,
  );
  check("Apply writes into the repo the finding names (bug #4)", writes.map((w) => w.path), [
    "C:\\dev\\repo-two\\src\\two.ts",
  ]);
  check(
    "…and splices the replacement into the right line",
    writes[0]?.content,
    "const a = 1;\nconst timeout = 30_000;\nconst c = 3;\n",
  );

  await shot(cdp, `${OUT}/cr-apply-2-applied.png`);
  check("no console errors (two repos)", errors, []);
}

// =====================  2. One repo: unchanged  =============================
{
  const { cdp, errors } = await open([REPO_ONE]);

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: 2 | 8, windowsVirtualKeyCode: 82, key: "R", code: "KeyR",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: 2 | 8, windowsVirtualKeyCode: 82, key: "R", code: "KeyR",
  });
  await wait(2500);

  const one = await evaluate(
    cdp,
    `(() => ({
       trigger: document.querySelector('button[aria-label="Select commits to review"]')
         ?.innerText.replace(/\\s+/g, " ").trim() ?? null,
       scopeRow: document.body.innerText.includes("Repos the reviewer can read"),
     }))()`,
  );
  check("one repo: the trigger says just 'Local changes'", one.trigger, "Local changes");
  check("one repo: no read-scope row — there's nothing to choose", one.scopeRow, false);

  await click(cdp, 'button[aria-label="Select commits to review"]');
  await wait(700);
  const chips = await evaluate(
    cdp,
    `[...document.querySelectorAll('[cmdk-item] span')]
       .map(s => s.textContent.trim()).filter(t => /^repo-/.test(t))`,
  );
  check("one repo: no repo chips in the picker", chips, []);

  await shot(cdp, `${OUT}/cr-apply-3-single-repo.png`, { selector: "[cmdk-root]" });
  check("no console errors (one repo)", errors, []);
}

console.log(fail.length === 0 ? "\nALL PASS" : `\n${fail.length} FAILED:\n${fail.join("\n")}`);
process.exit(fail.length === 0 ? 0 : 1);
