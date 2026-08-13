// Drives the confidence panel's source-provenance line across repos: a verdict
// stamped per repo goes stale only when ONE OF ITS OWN repos moves, and a
// pre-multi-repo verdict (bare sourceSha) still renders.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-phase11-confidence.mjs

import { connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const REPOS = [
  { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
];

const verdict = (extra) => ({
  predictedOutcome: "Pass",
  passLikelihood: 95,
  evidence: [],
  reasoning: "traced every step",
  caveats: [],
  evaluatedAt: "2026-08-01T10:00:00Z",
  modelId: "claude-opus-5",
  runs: 1,
  ...extra,
});

const SEED_TAB = `try {
  localStorage.setItem("devops-studio.tabs.v1", JSON.stringify({
    state: {
      tabs: { 1: { id: 1, kind: "test-case", title: "#10", caseId: 10, planId: null, suiteId: null, pinned: false } },
      nextId: 2,
      paneTree: { kind: "leaf", id: "root", tabIds: [1], activeTabId: 1 },
      focusedLeafId: "root",
    },
    version: 1,
  }));
} catch {}`;

const fixture = (storedVerdict) => ({
  prefs: { theme: "dark", repos: REPOS, codeSearchEnabled: true, sidebarView: "test-plans" },
  commands: {
    ado_test_connection: { configured: true, hasPat: true, identityName: "QA", orgUrl: "https://dev.azure.com/x", project: "P", defaultTrackingBranch: "$current" },
    ado_get_connection: { configured: true, hasPat: true, identityName: "QA", orgUrl: "https://dev.azure.com/x", project: "P", defaultTrackingBranch: "$current" },
    ado_get_case: {
      id: 10,
      title: "case 10",
      state: "Design",
      descriptionHtml: "",
      url: "https://dev.azure.com/x/_apis/wit/workItems/10",
      priority: 2,
      tags: [],
      steps: [{ index: 1, action: "do a thing", expected: "it happens" }],
      linkedWorkItems: [],
    },
    ado_list_suites_for_case: [],
    ado_list_plans: [],
    confidence_get: { caseId: 10, verdictJson: JSON.stringify(storedVerdict), updatedAt: "2026-08-01T10:00:00Z" },
    commit_review_list: [],
    commit_review_sweep_stale: 0,
    ai_checkpoint_list: [],
    // repo-one has MOVED past what the verdicts recorded; repo-two hasn't.
    git_repo_info: {
      "C:\\dev\\repo-one": { branch: "main", commit: "moved11", isRepo: true, detached: false },
      "C:\\dev\\repo-two": { branch: "feat/x", commit: "bbb2222", isRepo: true, detached: false },
    },
  },
});

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

async function hintFor(storedVerdict, shotName) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.clear(); } catch {}\n${SEED_TAB}`,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(fixture(storedVerdict)) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1300,
    height: 950,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
  await wait(4000);
  // The pass-readiness chip opens the detail panel. It's a plain button, so a
  // DOM click is enough (no Radix pointer sequence needed).
  const opened = await evaluate(
    cdp,
    `(() => {
       const b = [...document.querySelectorAll("button")]
         .find(x => /%/.test(x.innerText) && !x.getAttribute("aria-label"));
       if (!b) return document.body.innerText.slice(0, 400);
       b.click();
       return "clicked";
     })()`,
  );
  if (opened !== "clicked") throw new Error(`no readiness chip:\n${opened}`);
  await wait(800);
  const hint = await evaluate(
    cdp,
    `(() => {
       const p = [...document.querySelectorAll("p")]
         .find(x => /since this ran|current source|right branch/.test(x.innerText));
       return p ? p.innerText.replace(/\\s+/g, " ").trim() : "missing";
     })()`,
  );
  if (shotName) await shot(cdp, `${OUT}/${shotName}`);
  const errs = [...errors];
  cdp.close();
  return { hint, errs };
}

// Graded against repo-two only, which hasn't moved — repo-one moving must not
// make this verdict stale.
{
  const { hint, errs } = await hintFor(
    verdict({
      sources: [{ repoId: "r2", repoName: "repo-two", branch: "feat/x", sha: "bbb2222" }],
    }),
    "phase11-confidence-fresh.png",
  );
  check(
    "a verdict is fresh when ITS repo hasn't moved, though another has",
    hint,
    "Evaluated against your current source (repo-two on feat/x @ bbb2222).",
  );
  check("no console errors (fresh)", errs, []);
}

// Graded against both; repo-one moved.
{
  const { hint, errs } = await hintFor(
    verdict({
      sources: [
        { repoId: "r1", repoName: "repo-one", branch: "main", sha: "old1111" },
        { repoId: "r2", repoName: "repo-two", branch: "feat/x", sha: "bbb2222" },
      ],
    }),
    "phase11-confidence-stale.png",
  );
  check(
    "…and stale when one of them has, naming the one that moved",
    hint,
    "Your source changed since this ran (repo-one on main @ old1111, now at moved11) — re-evaluate to refresh.",
  );
  check("no console errors (stale)", errs, []);
}

// Pre-multi-repo verdict: a bare sourceSha, read as the first repo's.
{
  const { hint, errs } = await hintFor(
    verdict({ sourceSha: "old1111", sourceBranch: "main" }),
    "phase11-confidence-legacy.png",
  );
  check(
    "a verdict saved before multi-repo still renders, read as the first repo's",
    hint,
    "Your source changed since this ran (repo-one on main @ old1111, now at moved11) — re-evaluate to refresh.",
  );
  check("no console errors (legacy)", errs, []);
}

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
