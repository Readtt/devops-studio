// Drives Phase 11's surfaces across three repos: the code viewer's cross-repo
// resolution and collision titles, the terminal's own-cwd Quick Prompts
// (bug #6), the launcher's repo submenu, and the command palette's subtitles.
//
//     pnpm dev
//     node .claude/skills/drive-ui/drive-phase11.mjs

import {
  click,
  clickText,
  connect,
  evaluate,
  pressKey,
  shot,
  wait,
  watchErrors,
} from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const REPOS = [
  { id: "r1", name: "repo-one", root: "C:\\dev\\repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:\\dev\\repo-two", ado: null },
  { id: "r3", name: "repo-three", root: "C:\\dev\\repo-three", ado: null },
];

const FIXTURE = {
  prefs: {
    theme: "dark",
    repos: REPOS,
    codeSearchEnabled: true,
    sidebarView: "test-plans",
    developerMode: true,
  },
  commands: {
    git_repo_info: {
      "C:\\dev\\repo-one": { branch: "main", commit: "aaa1111", isRepo: true, detached: false },
      "C:\\dev\\repo-two": { branch: "feat/x", commit: "bbb1111", isRepo: true, detached: false },
      "C:\\dev\\repo-three": { branch: "main", commit: "ccc1111", isRepo: true, detached: false },
    },
    git_status_summary: {
      "C:\\dev\\repo-one": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
      "C:\\dev\\repo-two": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
      "C:\\dev\\repo-three": { dirty: false, ahead: 0, behind: 0, parkedHere: false },
    },
    // Bug #6: each repo reports a DIFFERENT set of branches, so the base the
    // Quick Prompts strip picks says which repo it actually asked.
    git_branch_list: {
      "C:\\dev\\repo-one": ["main", "feature/a"],
      "C:\\dev\\repo-two": ["develop", "feature/b"],
      "C:\\dev\\repo-three": ["trunk"],
    },
    fs_read_file: { __value: { kind: "text", content: "export const x = 1;\n", size: 20 } },
    pty_spawn: { __value: { shellKind: "powershell", pid: 1234 } },
    pty_write: null,
    pty_resize: null,
    pty_kill: null,
    detect_shells: [],
    commit_review_list: [],
    commit_review_sweep_stale: 0,
    ai_checkpoint_list: [],
    ado_test_connection: { __reject: "not connected" },
  },
};

// fs_resolve_source_path is root+path shaped, which the table's single-key
// resolver can't express — answer it here instead. Only repo-two holds
// `src/index.ts`; repo-one holds it too, so the two collide on basename.
const EXTRA = `
  if (cmd === "fs_resolve_source_path") {
    const files = {
      "C:\\\\dev\\\\repo-one": ["src/index.ts", "src/only-one.ts"],
      "C:\\\\dev\\\\repo-two": ["src/index.ts"],
      "C:\\\\dev\\\\repo-three": [],
    };
    const here = files[args.root] || [];
    if (here.includes(args.path)) return args.root + "\\\\" + args.path.replace(/\\//g, "\\\\");
    const base = args.path.split("/").pop();
    const hit = here.find((f) => f.split("/").pop() === base);
    return hit ? args.root + "\\\\" + hit.replace(/\\//g, "\\\\") : null;
  }
  if (cmd === "fs_stat") {
    const files = {
      "C:\\\\dev\\\\repo-one\\\\src\\\\index.ts": 1,
      "C:\\\\dev\\\\repo-one\\\\src\\\\only-one.ts": 1,
      "C:\\\\dev\\\\repo-two\\\\src\\\\index.ts": 1,
    };
    if (files[args.path]) return { size: 20 };
    throw new Error("no such file");
  }
`;

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const openViewer = (path) =>
  `window.dispatchEvent(new CustomEvent("devops-studio:open-code-viewer", { detail: ${JSON.stringify(
    { path },
  )} })); true`;

// Tab-strip rows are the app's only [data-allow-context-menu] elements.
const tabTitles = (cdp) =>
  evaluate(
    cdp,
    `[...document.querySelectorAll('[data-allow-context-menu="true"]')]
       .map(t => t.innerText.trim().split("\\n")[0]).filter(Boolean)`,
  );

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: "try { localStorage.clear(); } catch {}",
});
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE, EXTRA) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1300,
  height: 950,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(4000);

// ---------------------------------------------------------------------------
// Code viewer: two repos, one basename
// ---------------------------------------------------------------------------

await evaluate(cdp, openViewer("repo-one/src/index.ts"));
await wait(900);
check("first viewer opens with a bare basename title", await tabTitles(cdp), ["index.ts"]);
check(
  "…and reads the file from ITS OWN repo",
  await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "fs_read_file").map(c => c.args.path)`,
  ),
  ["C:\\dev\\repo-one\\src\\index.ts"],
);
check(
  "the pane header shows the <repo>/<path> form, not the absolute path",
  await evaluate(
    cdp,
    `document.querySelector(".cv-pane header span").innerText.trim()`,
  ),
  "repo-one/src/index.ts",
);

await evaluate(cdp, openViewer("repo-two/src/index.ts"));
await wait(900);
check(
  "the second repo's index.ts opens as its own tab, both titles disambiguated",
  (await tabTitles(cdp)).sort(),
  ["repo-one/index.ts", "repo-two/index.ts"],
);
check(
  "…each reading from its own repo",
  await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "fs_read_file").map(c => c.args.path)`,
  ),
  ["C:\\dev\\repo-one\\src\\index.ts", "C:\\dev\\repo-two\\src\\index.ts"],
);
await shot(cdp, `${OUT}/phase11-viewer-collision.png`);

// A bare (legacy work-item) path is searched across every repo, not just the
// first: only repo-one has `only-one.ts`.
await evaluate(cdp, openViewer("only-one.ts"));
await wait(900);
check(
  "a bare path is found in whichever repo holds it",
  await evaluate(
    cdp,
    `(() => { const c = window.__MOCK.calls.filter(x => x.cmd === "fs_read_file");
       return c[c.length - 1].args.path; })()`,
  ),
  "C:\\dev\\repo-one\\src\\only-one.ts",
);
check(
  "…and stays a bare basename, since nothing else is called that",
  (await tabTitles(cdp)).includes("only-one.ts"),
  true,
);

// ---------------------------------------------------------------------------
// Launcher: repo submenu + terminal in a non-first repo (bug #6)
// ---------------------------------------------------------------------------

await click(cdp, 'button[aria-label="New tab"]');
await wait(600);
check(
  "the launcher offers to pick a repo for the shell",
  await evaluate(
    cdp,
    `[...document.querySelectorAll('[data-slot="popover-content"] button')]
       .map(b => b.innerText.trim().split("\\n").join(" · "))`,
  ),
  [
    "New generation · Generate test cases from a feature spec — the QA workflow this app was built for.",
    "New terminal · Pick which of your 3 repos the shell opens in",
    "Commit review · AI bug review of selected commits — severity-ranked findings with one-click fixes",
  ],
);
await clickText(cdp, "New terminal");
await wait(500);
check(
  "…drilling in lists every repo with its path",
  await evaluate(
    cdp,
    `[...document.querySelectorAll('[data-slot="popover-content"] button')]
       .slice(1).map(b => b.innerText.trim().split("\\n").join(" · "))`,
  ),
  [
    "repo-one · C:\\dev\\repo-one",
    "repo-two · C:\\dev\\repo-two",
    "repo-three · C:\\dev\\repo-three",
  ],
);
await shot(cdp, `${OUT}/phase11-launcher-repos.png`, {
  selector: '[data-slot="popover-content"]',
});

await clickText(cdp, "repo-two");
await wait(1500);
check(
  "the terminal spawns in the repo that was picked",
  await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "pty_spawn").map(c => c.args.input.cwd)`,
  ),
  ["C:\\dev\\repo-two"],
);
// Bug #6: the strip must ask ITS OWN repo for branches, not the first one.
check(
  "Quick Prompts reads the terminal's own repo for base branches (bug #6)",
  await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "git_branch_list").map(c => c.args.cwd)`,
  ),
  ["C:\\dev\\repo-two"],
);
// The user-visible half of bug #6: click a Quick Prompt and the text typed
// into the shell must carry THIS repo's base branch. repo-one's list would
// give "main"; repo-two's gives "develop".
await clickText(cdp, "Review", "button");
await wait(600);
check(
  "…so the text a chip types names repo-two's base branch, not repo-one's",
  await evaluate(
    cdp,
    `(() => {
       const w = window.__MOCK.calls.filter(c => c.cmd === "pty_write");
       if (!w.length) return "no write";
       const text = atob(w[w.length - 1].args.input.data);
       return [/develop/.test(text), /\bmain\b/.test(text)];
     })()`,
  ),
  [true, false],
);
await shot(cdp, `${OUT}/phase11-terminal.png`);

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

await pressKey(cdp, "Escape");
await wait(300);
await evaluate(
  cdp,
  `window.dispatchEvent(new CustomEvent("devops-studio:open-command-palette")); true`,
);
await wait(900);
check(
  "the palette's developer commands describe the workspace, not one path",
  await evaluate(
    cdp,
    `[...document.querySelectorAll('[cmdk-item]')]
       .filter(i => /Review a commit|Open Terminal/.test(i.innerText))
       .map(i => i.innerText.trim().split("\\n").join(" · "))`,
  ),
  [
    "Review a commit · Bug-scan selected commits · repo-one, repo-two, repo-three",
    "Open Terminal · C:\\dev\\repo-one · use the + launcher to pick another of your 3 repos",
    "Open Terminal (default directory) · Launches in the app's process cwd — ignore source root",
  ],
);
await shot(cdp, `${OUT}/phase11-palette.png`);

check("no console errors", errors, []);
cdp.close();

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
