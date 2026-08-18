// Repro: opening the multi-repo branch switcher pops the "Add folder…" tooltip.
//
// The repo list has no CommandInput below seven repos, so Radix's open-autofocus
// lands on the first tabbable node in the content — the footer's Add folder
// button — and Radix Tooltip opens on focus. Asserts the tooltip is NOT showing
// right after the popover opens, and that arrow keys still move the list.

import { click, connect, evaluate, pressKey, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const BRANCH_SEGMENT = 'button[aria-label="Switch a repo\'s git branch"]';

const repo = (n, branch) => ({
  id: `r${n}`,
  name: `repo-${n}`,
  root: `C:\\dev\\repo-${n}`,
  ado: null,
});

const FIXTURE = {
  prefs: {
    theme: "dark",
    repos: [repo(1), repo(2), repo(3)],
  },
  commands: {
    git_repo_info: {
      "C:\\dev\\repo-1": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
      "C:\\dev\\repo-2": { branch: "main", commit: "b2c3d4e", isRepo: true, detached: false },
      "C:\\dev\\repo-3": { branch: "dev", commit: "c3d4e5f", isRepo: true, detached: false },
    },
    git_status_summary: {
      "C:\\dev\\repo-1": st("main"),
      "C:\\dev\\repo-2": st("main"),
      "C:\\dev\\repo-3": st("dev"),
    },
    ado_get_connection: { configured: false, hasPat: false, orgUrl: "", project: "" },
  },
};

function st(branch) {
  return {
    isRepo: true,
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
  };
}

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(4000);

const seg = await evaluate(cdp, `!!document.querySelector(${JSON.stringify(BRANCH_SEGMENT)})`);
if (!seg) {
  console.log("FAIL: multi-repo branch segment not found — fixture didn't take");
  process.exit(1);
}

await click(cdp, BRANCH_SEGMENT);
await wait(700);

// What Radix put focus on, and whether any tooltip is showing.
const state = await evaluate(
  cdp,
  `(() => {
     const active = document.activeElement;
     const tips = [...document.querySelectorAll('[role="tooltip"]')]
       .map(t => t.textContent.trim()).filter(Boolean);
     const popover = document.querySelector('[data-slot="popover-content"]')
       || document.querySelector('[data-radix-popper-content-wrapper]');
     return JSON.stringify({
       activeTag: active?.tagName ?? null,
       activeText: (active?.textContent ?? "").trim().slice(0, 40),
       tooltips: tips,
       popoverOpen: !!popover,
       rows: [...document.querySelectorAll('[cmdk-item]')].map(r => r.textContent.trim().slice(0, 20)),
     });
   })()`,
);
const s = JSON.parse(state);
console.log("popover open :", s.popoverOpen);
console.log("focus        :", s.activeTag, JSON.stringify(s.activeText));
console.log("tooltips     :", JSON.stringify(s.tooltips));
console.log("rows         :", JSON.stringify(s.rows));

await shot(cdp, `${OUT}/statusbar-popover.png`);

// Keyboard still has to work: arrow down must move the cmdk selection.
await pressKey(cdp, "ArrowDown");
await wait(250);
const selected = await evaluate(
  cdp,
  `(() => {
     const el = document.querySelector('[cmdk-item][data-selected="true"]');
     return el ? el.textContent.trim().slice(0, 20) : "<none>";
   })()`,
);
console.log("after ArrowDown, selected:", JSON.stringify(selected));

// The footer must offer BOTH ways to get a repo now that the "Get source code"
// segment is gone once one is configured.
const footer = await evaluate(
  cdp,
  `(() => {
     const btns = [...document.querySelectorAll('[data-slot="popover-content"] button')];
     return JSON.stringify(btns.map(b => b.textContent.trim()));
   })()`,
);
console.log("footer actions:", footer);
await shot(cdp, `${OUT}/statusbar-popover-footer.png`, {
  selector: '[data-slot="popover-content"]',
});

const addTip = s.tooltips.some((t) => /add another repository|add folder/i.test(t));
console.log("");
console.log(addTip ? "REPRO: Add-folder tooltip is open on popover open" : "OK: no stray tooltip");
console.log("console errors:", JSON.stringify(errors));
process.exit(addTip ? 2 : 0);
