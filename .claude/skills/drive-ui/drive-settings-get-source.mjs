// Settings → General → Source repos now offers Get source code… alongside Add
// folder and Scan a folder, so the wizard is reachable once repos exist.
// Asserts the button renders and that pressing it asks the MAIN window (a Tauri
// emit) rather than trying to run the clone in this webview.

import { clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const FIXTURE = {
  prefs: {
    theme: "dark",
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
    ado_get_connection: {
      configured: true,
      hasPat: true,
      orgUrl: "https://dev.azure.com/contoso",
      project: "Payments",
      defaultTrackingBranch: "$current",
    },
  },
};

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
// Record every Tauri event emit so we can prove the button delegates.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.__EMITS = [];",
});
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/settings.html" });
await wait(3800);

// The mock routes `plugin:event|emit` through invoke; tap it.
await evaluate(
  cdp,
  `(() => {
     const core = window.__TAURI_INTERNALS__;
     const orig = core.invoke;
     core.invoke = (cmd, args) => {
       if (cmd === "plugin:event|emit") window.__EMITS.push(args?.event ?? JSON.stringify(args));
       return orig(cmd, args);
     };
     return "tapped";
   })()`,
);

const row = await evaluate(
  cdp,
  `(() => {
     const btns = [...document.querySelectorAll('button')]
       .map(b => (b.textContent || "").trim())
       .filter(t => /add folder|scan a folder|get source code/i.test(t));
     return JSON.stringify(btns);
   })()`,
);
console.log("source-repo actions:", row);

await shot(cdp, `${OUT}/settings-repo-actions.png`, {
  selector: "main, [data-slot='settings-content'], body",
});

await clickText(cdp, "Get source code…");
await wait(900);
const emits = await evaluate(cdp, `JSON.stringify(window.__EMITS ?? [])`);
console.log("tauri emits after click:", emits);

const problems = [];
if (!/get source code/i.test(row)) problems.push("no Get source code action in the Source repos row");
if (!/get-source-code-requested/.test(emits)) {
  problems.push("Get source code did not ask the main window (no get-source-code-requested emit)");
}

console.log("");
console.log(problems.length ? "PROBLEMS:\n - " + problems.join("\n - ") : "OK: Get source code present and delegates to the main window");
console.log("console errors:", JSON.stringify(errors));
process.exit(problems.length ? 2 : 0);
