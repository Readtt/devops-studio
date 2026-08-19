// Drives Commit Review across two repos: the merged picker, per-repo head
// badges, repo search, and the read-scope chips.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-commit-review.mjs

import {
  click,
  clickText,
  connect,
  evaluate,
  shot,
  typeInto,
  wait,
  watchErrors,
} from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const REPOS = [
  { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
];

const commit = (sha, subject, date) => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject,
  author: "someone",
  date,
  relativeDate: "2 days ago",
  isRoot: false,
});

const FIXTURE = {
  prefs: {
    theme: "dark",
    repos: REPOS,
    codeSearchEnabled: true,
    sidebarView: "test-plans",
  },
  commands: {
    git_repo_info: {
      "C:\\dev\\repo-one": { branch: "main", commit: "aaa1111", isRepo: true, detached: false },
      "C:\\dev\\repo-two": { branch: "feat/x", commit: "bbb1111", isRepo: true, detached: false },
    },
    git_status_summary: {
      "C:\\dev\\repo-one": { dirty: true, ahead: 0, behind: 0, parkedHere: false },
      "C:\\dev\\repo-two": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
    },
    git_list_commits: {
      // Deliberately interleaved by date: repo-two's newest sits BETWEEN
      // repo-one's two, so a merged timeline is visibly not a concatenation.
      "C:\\dev\\repo-one": [
        commit("aaa1111aaa1111aaa1111aaa1111aaa1111aaa1", "one: newest", "2026-01-05T10:00:00Z"),
        commit("aaa3333aaa3333aaa3333aaa3333aaa3333aaa3", "one: oldest", "2026-01-01T10:00:00Z"),
      ],
      "C:\\dev\\repo-two": [
        commit("bbb1111bbb1111bbb1111bbb1111bbb1111bbb1", "two: middle", "2026-01-03T10:00:00Z"),
      ],
    },
    git_working_tree_diff: {
      "C:\\dev\\repo-one": {
        sha: "local",
        shortSha: "local",
        subject: "Uncommitted changes",
        author: "",
        date: "",
        isRoot: false,
        isMerge: false,
        isLocal: true,
        files: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
        rawPatch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        truncated: false,
        headSha: "aaa1111",
      },
    },
    git_commit_diff: {
      "C:\\dev\\repo-one": {
        sha: "aaa1111aaa1111aaa1111aaa1111aaa1111aaa1",
        shortSha: "aaa1111",
        subject: "one: newest",
        author: "someone",
        date: "2026-01-05T10:00:00Z",
        isRoot: false,
        isMerge: false,
        isLocal: false,
        files: [{ path: "src/one.ts", additions: 2, deletions: 0, status: "modified" }],
        rawPatch: "diff --git a/src/one.ts b/src/one.ts\n@@ -1 +1,3 @@\n line\n+added\n+more\n",
        truncated: false,
        headSha: "aaa1111",
      },
      "C:\\dev\\repo-two": {
        sha: "bbb1111bbb1111bbb1111bbb1111bbb1111bbb1",
        shortSha: "bbb1111",
        subject: "two: middle",
        author: "someone",
        date: "2026-01-03T10:00:00Z",
        isRoot: false,
        isMerge: false,
        isLocal: false,
        files: [{ path: "src/two.ts", additions: 1, deletions: 1, status: "modified" }],
        rawPatch: "diff --git a/src/two.ts b/src/two.ts\n@@ -1 +1 @@\n-a\n+b\n",
        truncated: false,
        headSha: "bbb1111",
      },
    },
    commit_review_list: [],
    commit_review_sweep_stale: 0,
    ai_checkpoint_list: [],
    ado_test_connection: { __reject: "not connected" },
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
// The tabs store persists to localStorage, which is per-PROFILE, not per-tab —
// so a previous run's open review (and its selection) would otherwise be
// restored into this one and every assertion below would be about that.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.clear(); } catch {}",
});
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1300,
  height: 950,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(4000);

// Open Commit Review the way a user does: the keyboard shortcut.
await evaluate(
  cdp,
  `(() => {
     const m = window.__DS_LAUNCH ?? null;
     return !!m;
   })()`,
);
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyDown",
  modifiers: 2 | 8, // ctrl + shift
  windowsVirtualKeyCode: 82,
  key: "R",
  code: "KeyR",
});
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  modifiers: 2 | 8,
  windowsVirtualKeyCode: 82,
  key: "R",
  code: "KeyR",
});
await wait(2500);

// --- the pane exists, and the default selection is the dirty repo's tree ---
const trigger = await evaluate(
  cdp,
  `document.querySelector('button[aria-label="Select commits to review"]')?.innerText.replace(/\\s+/g," ").trim() ?? null`,
);
check("picker defaults to the one dirty repo's local changes", trigger, "Local changes · repo-one");

// --- read-scope chips are present, labelled, and all on ---
const scope = await evaluate(
  cdp,
  `(() => {
     const label = [...document.querySelectorAll("label")]
       .find(l => l.textContent.includes("Repos the reviewer can read"));
     if (!label) return null;
     const row = label.parentElement;
     return {
       chips: [...row.querySelectorAll("button[aria-pressed]")].map(b => b.textContent.trim()),
       on: [...row.querySelectorAll("button[aria-pressed]")].map(b => b.getAttribute("aria-pressed")),
     };
   })()`,
);
check("read-scope chips list every repo, all on", scope, {
  chips: ["repo-one", "repo-two"],
  on: ["true", "true"],
});

await shot(cdp, `${OUT}/cr-1-pane.png`);

// --- open the picker: merged timeline, repo chips, per-repo head badge ------
await click(cdp, 'button[aria-label="Select commits to review"]');
await wait(700);

// Structured, not a text blob: which repo each row belongs to, in list order.
const READ_ROWS = `[...document.querySelectorAll('[cmdk-item]')].map(el => {
  const spans = [...el.querySelectorAll("span")].map(s => s.textContent.trim());
  return {
    repo: spans.find(t => /^repo-/.test(t)) ?? null,
    sha: spans.find(t => /^[0-9a-f]{7}$/.test(t)) ?? "local",
    head: spans.includes("head"),
  };
})`;

const rows = await evaluate(cdp, READ_ROWS);
// repo-two's only commit sits BETWEEN repo-one's two by date, so this ordering
// is only reachable from a real merge — a per-repo concatenation can't produce it.
check(
  "merged timeline interleaves the repos by date",
  rows.map((r) => `${r.repo}/${r.sha}`),
  ["repo-one/local", "repo-one/aaa1111", "repo-two/bbb1111", "repo-one/aaa3333"],
);

check(
  "each repo's newest commit carries its own head badge",
  rows.filter((r) => r.head).map((r) => r.repo),
  ["repo-one", "repo-two"],
);

await shot(cdp, `${OUT}/cr-2-picker.png`, { selector: "[cmdk-root]" });

// --- searching by repo name narrows to that repo -----------------------------
await typeInto(cdp, "[cmdk-input]", "repo-two");
await wait(500);
const searched = await evaluate(cdp, READ_ROWS);
check(
  "searching a repo name shows only that repo's rows",
  searched.map((r) => r.repo),
  ["repo-two"],
);

await shot(cdp, `${OUT}/cr-3-search.png`, { selector: "[cmdk-root]" });

// --- tick one commit from EACH repo -----------------------------------------
await clickText(cdp, "two: middle", "[cmdk-item]");
await wait(700);
await typeInto(cdp, "[cmdk-input]", "one: newest");
await wait(500);
await clickText(cdp, "one: newest", "[cmdk-item]");
await wait(900);

await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
await wait(700);

const selected = await evaluate(
  cdp,
  `document.querySelector('button[aria-label="Select commits to review"]')?.innerText.replace(/\\s+/g," ").trim() ?? null`,
);
check("a commit from each repo can be selected in one pass", selected, "Local changes · repo-one + 2 commits");

const readCwds = await evaluate(
  cdp,
  `[...new Set(window.__MOCK.calls.filter(c => c.cmd === "git_commit_diff").map(c => c.args.cwd))].sort()`,
);
check("each diff was read from its OWN repo root", readCwds, [
  "C:\\dev\\repo-one",
  "C:\\dev\\repo-two",
]);

// --- the diff panel labels each section with its repo ------------------------
await click(cdp, 'button[aria-label="Show diff"]');
await wait(900);
const sections = await evaluate(
  cdp,
  `[...document.querySelectorAll("section")]
     .map(s => s.innerText.split("\\n").slice(0, 3).join(" | "))
     .filter(t => t.includes("/"))`,
);
console.log("diff sections:", JSON.stringify(sections, null, 1));

await shot(cdp, `${OUT}/cr-4-selected.png`);

// --- deselecting a repo from the read scope keeps the ticked commits ---------
await clickText(cdp, "repo-two");
await wait(700);
const afterScope = await evaluate(
  cdp,
  `(() => {
     const label = [...document.querySelectorAll("label")]
       .find(l => l.textContent.includes("Repos the reviewer can read"));
     const row = label.parentElement;
     return {
       on: [...row.querySelectorAll("button[aria-pressed]")].map(b => b.getAttribute("aria-pressed")),
       trigger: document.querySelector('button[aria-label="Select commits to review"]')
         ?.innerText.replace(/\\s+/g," ").trim(),
     };
   })()`,
);
check("deselecting a repo leaves the ticked commits ticked", afterScope, {
  on: ["true", "false"],
  trigger: "Local changes · repo-one + 2 commits",
});

await shot(cdp, `${OUT}/cr-5-scope-off.png`);

check("no console errors", errors, []);

console.log(fail.length === 0 ? "\nALL PASS" : `\n${fail.length} FAILED:\n${fail.join("\n")}`);
process.exit(fail.length === 0 ? 0 : 1);
