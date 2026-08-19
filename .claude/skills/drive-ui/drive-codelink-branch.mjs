// Code-review fixes: the Settings "Code-link branch" readout no longer promises
// a `main` fallback (publish stamps NO branch when none resolves), and it now
// describes every repo rather than repos[0]. Driven at 0 / 1 / 3 repos.
//
// Also asserts the status-bar "Get source code" segment opens the ONE wizard
// StatusBarGit hosts, rather than a second copy of its own.

import { clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const ADO = {
  configured: true,
  hasPat: true,
  orgUrl: "https://dev.azure.com/contoso",
  project: "Payments",
  defaultTrackingBranch: "$current",
};

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const NOW_ROW = `
  (() => {
    const label = [...document.querySelectorAll("label")]
      .find(l => l.textContent.trim() === "Code-link branch");
    if (!label) return "NO SECTION";
    const block = label.closest("div.flex.flex-col");
    return block.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(" | ");
  })()`;

async function readNow(fixture, shotName) {
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(fixture) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1100, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/settings.html" });
  await wait(3800);
  // The readout lives in the Azure DevOps section, not General. Radix
  // TabsTrigger activates on mousedown, which clickText's pointer sequence
  // doesn't send — dispatch it here rather than changing the shared harness.
  await evaluate(cdp, `
    (() => {
      const el = [...document.querySelectorAll('[role="tab"]')]
        .find(b => b.innerText.includes("Azure DevOps"));
      if (!el) throw new Error("no Azure DevOps tab");
      const o = { bubbles: true, cancelable: true, button: 0, buttons: 1,
                  pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    })()`);
  await wait(1500);
  await evaluate(cdp, `
    const l = [...document.querySelectorAll("label")]
      .find(x => x.textContent.trim() === "Code-link branch");
    if (l) { l.scrollIntoView({ block: "center" }); }
    true`);
  await wait(500);
  const text = await evaluate(cdp, NOW_ROW);
  if (shotName) await shot(cdp, `${OUT}/${shotName}`);
  const errs = errors.list ? errors.list() : errors;
  await cdp.close?.();
  return { text, errs };
}

// ---- 3 repos, two different branches + one detached -------------------------
const THREE = await readNow({
  prefs: {
    theme: "dark",
    repos: [
      { id: "r1", name: "alpha", root: "C:\dev\alpha", ado: null },
      { id: "r2", name: "beta", root: "C:\dev\beta", ado: null },
      { id: "r3", name: "gamma", root: "C:\dev\gamma", ado: null },
    ],
  },
  commands: {
    ado_get_connection: ADO,
    git_repo_info: {
      "C:\dev\alpha": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
      "C:\dev\beta": { branch: "feat/multi-repo", commit: "b2c3d4e", isRepo: true, detached: false },
      "C:\dev\gamma": { branch: null, commit: "c3d4e5f", isRepo: true, detached: true },
    },
  },
}, "codelink-3repos.png");
console.log("3 repos →", JSON.stringify(THREE.text));
check("3 repos: never promises a `main` fallback", /fall back to/.test(THREE.text), false);
check("3 repos: names both live branches", /main/.test(THREE.text) && /feat\/multi-repo/.test(THREE.text), true);
check("3 repos: says the detached one publishes without a branch", /gamma/.test(THREE.text) && /without one/.test(THREE.text), true);

// ---- 1 repo, ordinary branch ------------------------------------------------
const ONE = await readNow({
  prefs: { theme: "dark", repos: [{ id: "r1", name: "alpha", root: "C:\dev\alpha", ado: null }] },
  commands: {
    ado_get_connection: ADO,
    git_repo_info: {
      "C:\dev\alpha": { branch: "main", commit: "a1b2c3d", isRepo: true, detached: false },
    },
  },
}, "codelink-1repo.png");
console.log("1 repo →", JSON.stringify(ONE.text));
check("1 repo: reads as it always did (branch + sha)", /main/.test(ONE.text) && /a1b2c3d/.test(ONE.text), true);
check("1 repo: no `main` fallback promise", /fall back to/.test(ONE.text), false);

// ---- 1 repo, not a git repository ------------------------------------------
const NONGIT = await readNow({
  prefs: { theme: "dark", repos: [{ id: "r1", name: "alpha", root: "C:\dev\alpha", ado: null }] },
  commands: { ado_get_connection: ADO }, // git_repo_info rejects → not a repo
}, "codelink-nongit.png");
console.log("non-git →", JSON.stringify(NONGIT.text));
check("non-git: says links publish with no branch, not `main`", /without one/.test(NONGIT.text) && !/fall back to/.test(NONGIT.text), true);

// ---- 0 repos ----------------------------------------------------------------
const ZERO = await readNow({
  prefs: { theme: "dark", repos: [] },
  commands: { ado_get_connection: ADO },
}, "codelink-0repos.png");
console.log("0 repos →", JSON.stringify(ZERO.text));
check("0 repos: unchanged call to action", /Set a source directory/.test(ZERO.text), true);

const allErrs = [...THREE.errs, ...ONE.errs, ...NONGIT.errs, ...ZERO.errs];
check("no react errors in any state", allErrs, []);

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
