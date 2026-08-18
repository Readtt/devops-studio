// Verifies the commit picker's Refresh action, and that removing a repo
// updates the picker instead of leaving its rows and selections behind.

import { click, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const st = (branch, dirty = false) => ({
  isRepo: true,
  branch,
  commit: "a1b2c3d",
  detached: false,
  upstream: `origin/${branch}`,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: dirty ? 1 : 0,
  untracked: 0,
  conflicted: 0,
  dirty,
  parkedHere: false,
});

const commit = (sha, subject, date) => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject,
  author: "Ada",
  date,
  relativeDate: "2 days ago",
  isRoot: false,
});

const FIXTURE = {
  prefs: {
    theme: "dark",
    codeSearchEnabled: true,
    repos: [
      { id: "r1", name: "alpha", root: "C:\\dev\\alpha", ado: null },
      { id: "r2", name: "beta", root: "C:\\dev\\beta", ado: null },
    ],
  },
  commands: {
    git_repo_info: {
      "C:\\dev\\alpha": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
      "C:\\dev\\beta": { branch: "main", commit: "b2c3d4e", isRepo: true, detached: false },
    },
    git_status_summary: {
      "C:\\dev\\alpha": st("main", true),
      "C:\\dev\\beta": st("main"),
    },
    git_list_commits: {
      "C:\\dev\\alpha": [
        commit("aaa1111", "alpha: add the thing", "2026-01-03T00:00:00Z"),
        commit("aaa2222", "alpha: fix the thing", "2026-01-01T00:00:00Z"),
      ],
      "C:\\dev\\beta": [commit("bbb1111", "beta: wire it up", "2026-01-02T00:00:00Z")],
    },
    ado_get_connection: { configured: false, hasPat: false, orgUrl: "", project: "" },
    // Nothing interrupted, nothing saved — the plain fresh-tab path.
    ai_checkpoint_list: [],
    commit_review_list: [],
    commit_review_sweep_stale: 0,
    // The dirty repo auto-selects its working tree on open, so this has to
    // answer or the header crashes reducing over a diff that never arrived.
    git_working_tree_diff: {
      "C:\\dev\\alpha": diff("local", "Uncommitted changes", true),
    },
    git_commit_diff: {
      "C:\\dev\\alpha": diff("aaa1111", "alpha: add the thing"),
      "C:\\dev\\beta": diff("bbb1111", "beta: wire it up"),
    },
  },
};

function diff(sha, subject, isLocal = false) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    author: "Ada",
    date: "2026-01-03T00:00:00Z",
    isRoot: false,
    isMerge: false,
    isLocal,
    files: [{ path: "src/a.ts", additions: 2, deletions: 1, status: "modified" }],
    rawPatch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    headSha: sha,
  };
}

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
// The tabs store persists to localStorage, which is per-PROFILE, not per-tab —
// a previous run's open review would otherwise be restored into this one.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.clear(); } catch {}",
});
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1400,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(4000);

// Open Commit Review the way a user does: Ctrl+Shift+R.
for (const type of ["keyDown", "keyUp"]) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    modifiers: 2 | 8, // ctrl + shift
    windowsVirtualKeyCode: 82,
    key: "R",
    code: "KeyR",
  });
}
await wait(2800);

const picker = 'button[aria-label="Select commits to review"]';
const havePicker = await evaluate(cdp, `!!document.querySelector(${JSON.stringify(picker)})`);
console.log("picker present:", havePicker);
if (!havePicker) {
  await shot(cdp, `${OUT}/commit-picker-missing.png`);
  console.log("console errors:", JSON.stringify(errors));
  process.exit(1);
}

await click(cdp, picker);
await wait(900);

const read = async (label) => {
  const out = await evaluate(
    cdp,
    `(() => {
       const pc = document.querySelector('[data-slot="popover-content"]');
       if (!pc) return JSON.stringify({ open: false });
       return JSON.stringify({
         open: true,
         rows: [...pc.querySelectorAll('[cmdk-item]')].map(r => r.textContent.trim().slice(0, 46)),
         footer: (pc.querySelector('.border-t')?.textContent || "").trim(),
         hasRefresh: [...pc.querySelectorAll('button')].some(b => /refresh/i.test(b.textContent||"")),
       });
     })()`,
  );
  const v = JSON.parse(out);
  console.log(`\n--- ${label} ---`);
  console.log("rows      :", JSON.stringify(v.rows));
  console.log("footer    :", JSON.stringify(v.footer));
  console.log("hasRefresh:", v.hasRefresh);
  return v;
};

const before = await read("picker open");
await shot(cdp, `${OUT}/commit-picker.png`, { selector: '[data-slot="popover-content"]' });

// Select one commit from each repo, then drop repo "beta" from the registry and
// confirm its rows AND its selection leave the picker.
await evaluate(
  cdp,
  `(() => {
     const pc = document.querySelector('[data-slot="popover-content"]');
     const rows = [...pc.querySelectorAll('[cmdk-item]')];
     for (const r of rows) {
       const t = r.textContent || "";
       if (/alpha: add the thing|beta: wire it up/.test(t)) r.click();
     }
   })()`,
);
await wait(600);
const picked = await read("after selecting one commit per repo");

// Remove repo beta the way Settings does — through the real store.
await evaluate(
  cdp,
  `(async () => {
     const m = await import("/src/modules/settings/store.ts");
     await m.removeRepo("r2");
     return "removed";
   })()`,
);
await wait(1800);
const after = await read("after removing repo beta");
await shot(cdp, `${OUT}/commit-picker-after-remove.png`, {
  selector: '[data-slot="popover-content"]',
});

const problems = [];
if (!before.hasRefresh) problems.push("no Refresh action in the picker footer");
if (after.rows.some((r) => /beta/i.test(r))) problems.push("removed repo's rows still listed");
if (/2 commits selected|beta/i.test(after.footer)) {
  problems.push(`footer still counts the removed repo: ${after.footer}`);
}

console.log("");
console.log(problems.length ? "PROBLEMS:\n - " + problems.join("\n - ") : "OK: refresh present, removal is reactive");
console.log("console errors:", JSON.stringify(errors));
process.exit(problems.length ? 2 : 0);
