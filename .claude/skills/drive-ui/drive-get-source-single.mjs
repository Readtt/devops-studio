// Code-review fix: StatusBarGit hosted a GetSourceCodeDialog AND GetSourceCodeButton
// mounted a second one, so the zero-repo state had two copies of the wizard with
// independent state — the Settings-window request opened one while a click on the
// segment opened the other. The button now delegates to the hosted instance.

import { connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const FIXTURE = {
  prefs: { theme: "dark", repos: [] },   // the zero-repo state that showed both
  commands: {
    ado_get_connection: { configured: false, hasPat: false, orgUrl: "", project: "" },
  },
};

const cdp = await connect();
const errors = watchErrors(cdp);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1400, height: 900, deviceScaleFactor: 2, mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(4200);

const SEGMENT = 'button[aria-label="Get source code"]';
check("the segment renders with no repos configured",
  await evaluate(cdp, `!!document.querySelector('${SEGMENT}')`), true);

// Click it the way a user does — Radix Dialog opens on click.
await evaluate(cdp, `
  (() => {
    const el = document.querySelector('${SEGMENT}');
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1,
                pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  })()`);
await wait(1200);

check("clicking it opens exactly ONE wizard",
  await evaluate(cdp, `document.querySelectorAll('[role="dialog"]').length`), 1);
check("...and it is the Get source code wizard",
  await evaluate(cdp, `
    (document.querySelector('[role="dialog"]') || {}).innerText
      ? document.querySelector('[role="dialog"]').innerText.includes("source code")
        || document.querySelector('[role="dialog"]').innerText.includes("Clone")
      : false`), true);
await shot(cdp, `${OUT}/get-source-click.png`);

// Close, then ask the way the Settings window does: the same hosted dialog must open.
await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
await wait(900);
check("escape closes it", await evaluate(cdp, `document.querySelectorAll('[role="dialog"]').length`), 0);

// The Settings window asks by Tauri emit; push it through the same bridge the
// app's own `emit` uses so the real listener runs.
await evaluate(cdp, `
  window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "devops-studio://get-source-code-requested",
    payload: null,
  }).then(() => true)`);
await wait(1200);
check("the Settings-window request opens the same single wizard",
  await evaluate(cdp, `document.querySelectorAll('[role="dialog"]').length`), 1);
await shot(cdp, `${OUT}/get-source-event.png`);

check("no react errors", errors.list ? errors.list() : errors, []);
console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
