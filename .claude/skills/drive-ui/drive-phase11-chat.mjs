// Drives Phase 11's Suite Chat repo-scope chips, plus the two edge counts the
// design principle turns on: at ONE repo nothing new appears, and at ZERO the
// developer commands say why they're off.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-phase11-chat.mjs

import { click, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const THREE = [
  { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
  { id: "r3", name: "repo-three", root: "C:\\dev\\repo-three", ado: null },
];

// Matches TestCaseSchema — a missing descriptionHtml/url fails the zod parse at
// the IPC boundary and the suite loads zero cases.
const testCase = (id) => ({
  id,
  title: `case ${id}`,
  state: "Design",
  descriptionHtml: "",
  url: "https://dev.azure.com/x/_apis/wit/workItems/10",
  priority: 2,
  tags: [],
  steps: [{ index: 1, action: "do a thing", expected: "it happens" }],
  linkedWorkItems: [],
});

const commands = {
  ado_test_connection: { configured: true, orgUrl: "https://dev.azure.com/x", project: "P" },
  ado_get_connection: { configured: true, orgUrl: "https://dev.azure.com/x", project: "P" },
  ado_list_plans: [{ id: 1, name: "Plan", rootSuiteId: 2 }],
  ado_list_suites: [{ id: 2, name: "Suite", parentId: null, suiteType: "StaticTestSuite" }],
  ado_list_suite_cases: [{ id: 10, title: "case 10", state: "Design" }],
  ado_get_case: testCase(10),
  ado_list_suites_for_case: [],
  confidence_get_many: [],
  chat_thread_list_for_suite: [],
  chat_thread_get: null,
  chat_thread_save: null,
  commit_review_list: [],
  commit_review_sweep_stale: 0,
  ai_checkpoint_list: [],
};

const gitFor = (repos) =>
  Object.fromEntries(
    repos.map((r, i) => [
      r.root,
      { branch: ["main", "feat/x", "main"][i] ?? "main", commit: `${i}${i}${i}1111`, isRepo: true, detached: false },
    ]),
  );

const fixture = (repos) => ({
  prefs: { theme: "dark", repos, codeSearchEnabled: true, sidebarView: "test-plans" },
  commands: { ...commands, git_repo_info: gitFor(repos) },
});

// Open the suite chat by seeding the persisted tab store — the in-app routes to
// it all need a live ADO tree, which isn't what this is checking.
const SEED_TAB = `try {
  localStorage.setItem("devops-studio.tabs.v1", JSON.stringify({
    state: {
      tabs: { 1: { id: 1, kind: "suite-chat", title: "Suite", planId: 1, suiteId: 2, threadId: null, pinned: false } },
      nextId: 2,
      paneTree: { kind: "leaf", id: "root", tabIds: [1], activeTabId: 1 },
      focusedLeafId: "root",
    },
    version: 1,
  }));
} catch {}`;

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

async function open(repos, { seedTab = true } = {}) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.clear(); } catch {}\n${seedTab ? SEED_TAB : ""}`,
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

const chipRow = (cdp) =>
  evaluate(
    cdp,
    `(() => {
       const label = [...document.querySelectorAll("label")]
         .find(l => l.textContent.trim() === "Repos this chat can read");
       if (!label) return null;
       const row = label.parentElement;
       return {
         chips: [...row.querySelectorAll("button")].map(b => b.innerText.trim() + (b.getAttribute("aria-pressed") === "true" ? "*" : "")),
         hint: row.querySelector("p").innerText.trim(),
       };
     })()`,
  );

// ---------------------------------------------------------------------------
// Three repos: the chips are there, and deselecting says what it means
// ---------------------------------------------------------------------------

{
  const { cdp, errors } = await open(THREE);
  check(
    "the composer offers a repo scope, all on by default",
    await chipRow(cdp),
    {
      chips: ["repo-one*", "repo-two*", "repo-three*"],
      hint: "Applies to the next message. Deselect one to keep this chat out of it.",
    },
  );
  await shot(cdp, `${OUT}/phase11-chat-chips.png`);

  await evaluate(
    cdp,
    `[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "repo-two").click(); true`,
  );
  await wait(400);
  check(
    "deselecting one drops just that chip",
    (await chipRow(cdp)).chips,
    ["repo-one*", "repo-two", "repo-three*"],
  );

  for (const name of ["repo-one", "repo-three"]) {
    await evaluate(
      cdp,
      `[...document.querySelectorAll("button")].find(b => b.innerText.trim() === ${JSON.stringify(name)}).click(); true`,
    );
    await wait(250);
  }
  check(
    "deselecting everything says the chat reads no code at all",
    (await chipRow(cdp)).hint,
    "Nothing selected — answers can't cite code at all.",
  );
  await shot(cdp, `${OUT}/phase11-chat-chips-none.png`);
  check("no console errors (3 repos)", errors, []);
  cdp.close();
}

// ---------------------------------------------------------------------------
// One repo: identical to before — no scope row anywhere
// ---------------------------------------------------------------------------

{
  const { cdp, errors } = await open([THREE[0]]);
  check("at one repo the composer has no scope row", await chipRow(cdp), null);
  check(
    "…and the onboarding still promises code grounding",
    await evaluate(
      cdp,
      `(() => {
         const p = [...document.querySelectorAll("p")]
           .find(x => x.innerText.includes("The full case list is in scope"));
         return p ? p.innerText.trim() : "missing";
       })()`,
    ),
    "The full case list is in scope. Your source repos are readable — answers can reference real code.",
  );
  await shot(cdp, `${OUT}/phase11-chat-one-repo.png`);
  check("no console errors (1 repo)", errors, []);
  cdp.close();
}

// ---------------------------------------------------------------------------
// Zero repos: the developer commands are off, and say why
// ---------------------------------------------------------------------------

{
  const { cdp, errors } = await open([], { seedTab: false });
  await evaluate(
    cdp,
    `window.dispatchEvent(new CustomEvent("devops-studio:open-command-palette")); true`,
  );
  await wait(900);
  check(
    "with no repos the developer commands are disabled with a reason",
    await evaluate(
      cdp,
      `[...document.querySelectorAll('[cmdk-item]')]
         .filter(i => /Review a commit|Open Terminal/.test(i.innerText))
         .map(i => (i.getAttribute("data-disabled") === "true" ? "OFF " : "ON  ") +
                   i.innerText.trim().split("\\n").join(" · "))`,
    ),
    [
      "OFF Review a commit · Add a source repo in Settings first",
      "OFF Open Terminal · Add a source repo in Settings to land there",
      "ON  Open Terminal (default directory) · Launches in the app's process cwd — ignore source root",
    ],
  );
  await shot(cdp, `${OUT}/phase11-palette-empty.png`);
  check("no console errors (0 repos)", errors, []);
  cdp.close();
}

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
