// Drives the per-tab error boundary: a tab whose render throws shows its own
// fallback while the rest of the window keeps working, "Try again" re-renders
// it, and "Close tab" closes it — pinned or not.
//
// The throw is real: the generator's per-tab store is given a model id nothing
// serves, which `getModel` refuses — the shape of the retired-model crash that
// used to blank the whole main window on every launch.
//
//     pnpm dev                                              # one shell
//     node .claude/skills/drive-ui/drive-tab-error-boundary.mjs

import { clickText, connect, evaluate, shot, wait } from "./cdp.js";
import { MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";

const FIXTURE = {
  prefs: { theme: "dark", defaultModelId: "claude-sonnet-5" },
  commands: {
    secrets_get_all: [null, "sk-ant-x", null, null, null, null, null, null, null, null],
  },
};

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const cdp = await connect();
const pageErrors = [];
cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE) });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1300,
  height: 850,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
await wait(5000);

// Open a generator tab through the same tabs store the app uses.
const tabId = await evaluate(
  cdp,
  `(async () => {
     const { useTabsStore } = await import("/src/modules/tabs/store/useTabsStore.ts");
     window.__tabs = useTabsStore;
     return useTabsStore.getState().openTab({
       kind: "generator", title: "Generator", initialPlanId: null, initialSuiteId: null, runId: null,
     });
   })()`,
);
await wait(1500);

// The tab's session store lives in React context; reach it from the fiber.
const setModel = (id) =>
  evaluate(
    cdp,
    `(() => {
       const el = document.querySelector("textarea");
       if (!el) throw new Error("no generator form on screen");
       let f = el[Object.keys(el).find((k) => k.startsWith("__reactFiber$"))];
       while (f && typeof f.memoizedProps?.value?.getOrCreate !== "function") f = f.return;
       if (!f) throw new Error("no generator stores context above the form");
       window.__genStore = f.memoizedProps.value.getOrCreate(${tabId});
       window.__genStore.setState({ overrideModelId: ${JSON.stringify(id)} });
       return true;
     })()`,
  );
const setModelAgain = (id) =>
  evaluate(cdp, `window.__genStore.setState({ overrideModelId: ${JSON.stringify(id)} }); true`);

const fallbacks = () =>
  evaluate(
    cdp,
    `[...document.querySelectorAll("p")].filter((p) => p.textContent === "This tab couldn't be shown").length`,
  );
const fallbackMessage = () =>
  evaluate(
    cdp,
    `[...document.querySelectorAll("p.font-mono")].map((p) => p.textContent).join(" | ")`,
  );
const tabOpen = () =>
  evaluate(cdp, `${tabId} in window.__tabs.getState().tabs`);
const statusBarAlive = () =>
  evaluate(
    cdp,
    `[...document.querySelectorAll("span")].some((s) => s.textContent.startsWith("default"))`,
  );

check("the generator tab opened with its form", await evaluate(cdp, `!!document.querySelector("textarea")`), true);

// Break it.
await setModel("gone-model");
await wait(800);
check("the broken tab shows its own fallback", await fallbacks(), 1);
check("…naming what went wrong", await fallbackMessage(), "Unknown model: gone-model");
check("the rest of the window keeps working (status bar still there)", await statusBarAlive(), true);
await shot(cdp, `${OUT}/tab-error-boundary.png`);

// Try again while the cause is still there: it fails again, still contained.
await clickText(cdp, "Try again");
await wait(600);
check("Try again with the cause still present fails again, still in the tab", await fallbacks(), 1);

// Fix the cause, then Try again: the tab comes back.
await setModelAgain(null);
await clickText(cdp, "Try again");
await wait(800);
check("Try again after the cause is gone shows the tab again", await fallbacks(), 0);
check("…with its form", await evaluate(cdp, `!!document.querySelector("textarea")`), true);

// A pinned tab's normal close is a no-op; the fallback's close must still work.
await evaluate(cdp, `window.__tabs.getState().pinTab(${tabId}); true`);
await setModel("gone-model");
await wait(800);
check("the pinned tab breaks into the fallback too", await fallbacks(), 1);
await clickText(cdp, "Close tab");
await wait(800);
check("Close tab closes it, pinned or not", await tabOpen(), false);
check("…and nothing is left showing the fallback", await fallbacks(), 0);
check("the window is still alive afterwards", await statusBarAlive(), true);

cdp.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
