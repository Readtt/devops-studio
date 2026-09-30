// Drives the live model catalogue: discovered models in the picker (Settings →
// Models and the main window's status bar), the "N more — type to search"
// preview, picking a discovered model as the default, and "Check now" — which
// Settings hands to the main window, the catalogue's only writer, to re-read
// every connected provider's list through the (mocked) Rust HTTP proxy.
//
//     pnpm dev                                              # one shell
//     node .claude/skills/drive-ui/drive-model-catalogue.mjs

import { clickText, connect, evaluate, shot, wait, watchErrors } from "./cdp.js";
import { lastWrite, MOCK } from "./tauriMock.js";

const OUT = process.env.DRIVE_OUT ?? ".";
const NOW = Date.now();
const H = 3_600_000;
const CHECK_REQUESTED = "devops-studio://model-catalog-check-requested";

// Twelve OpenRouter routes, newest first: five show before a search, seven
// are behind "type to search" — including the oldest, `vendor/zeta-model`.
const openrouter = Array.from({ length: 12 }, (_, i) => ({
  provider: "openrouter",
  apiId: i === 11 ? "vendor/zeta-model" : `vendor/model-${String(i).padStart(2, "0")}`,
  label: i === 11 ? "Zeta Model" : `Model ${String(i).padStart(2, "0")}`,
  createdAt: NOW - i * H,
  contextWindow: 262_144,
  pricing: { input: 1, output: 2 },
}));

const CATALOG = {
  anthropic: {
    checkedAt: NOW - 2 * H,
    fetchedAt: NOW - 2 * H,
    models: [
      {
        provider: "anthropic",
        apiId: "claude-opus-5-6",
        label: "Claude Opus 5.6",
        createdAt: NOW - H,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        vision: true,
      },
      // Curated under the same and a dated id — must not appear twice.
      { provider: "anthropic", apiId: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { provider: "anthropic", apiId: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  openrouter: { checkedAt: NOW - 2 * H, fetchedAt: NOW - 2 * H, models: openrouter },
  // Failed ten minutes ago: inside the one-hour retry window, so the main
  // window mustn't re-check it at launch.
  mistral: {
    checkedAt: NOW - 10 * 60_000,
    fetchedAt: NOW - 3 * H,
    error: "HTTP 401",
    models: [{ provider: "mistral", apiId: "magistral-medium-latest", createdAt: NOW - 50 * H }],
  },
};

const FIXTURE = {
  prefs: {
    theme: "dark",
    defaultModelId: "claude-sonnet-5",
    // The catalogue's own store file; the mock keeps one map for every store.
    catalog: { stamp: 1, catalog: CATALOG },
  },
  commands: {
    // openai, anthropic, google, xai, cerebras, groq, deepseek, mistral,
    // openrouter, openai-compatible — the keyring's account order.
    secrets_get_all: [null, "sk-ant-x", null, null, null, null, null, "mk-x", "sk-or-x", null],
  },
};

// The Rust `ai_http_stream` proxy, answered from `window.__LISTS` by URL prefix
// over the same Channel protocol the real one uses.
const HTTP = `
  if (cmd === "ai_http_stream_cancel") return null;
  if (cmd === "ai_http_stream") {
    const url = String(args.url);
    const lists = window.__LISTS || {};
    const key = Object.keys(lists).find((k) => url.startsWith(k));
    const fire = callbacks.get(args.onEvent.id);
    let i = 0;
    const send = (m) => fire && fire({ message: m, index: i++ });
    const enc = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
    setTimeout(() => {
      const spec = key ? lists[key] : null;
      const status = spec ? (spec.__status ?? 200) : 404;
      send({ kind: "headers", status, headers: { "content-type": "application/json" } });
      send({ kind: "chunk", data: enc(status === 200 ? spec : { error: "nope" }) });
      send({ kind: "end" });
    }, 20);
    return null;
  }
`;

const fail = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) fail.push(`${label}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
};

const pickerRows = (cdp) =>
  evaluate(
    cdp,
    `[...document.querySelectorAll('[cmdk-group]')].map(g => ({
       heading: g.querySelector('[cmdk-group-heading]')?.textContent.trim(),
       rows: [...g.querySelectorAll('[cmdk-item]')].map(i => i.innerText.split("\\n")[0].trim()),
       more: [...g.querySelectorAll('p')].find(p => p.textContent.includes('type to search'))?.textContent.trim() ?? null,
     }))`,
  );

const statusLine = (cdp) =>
  evaluate(
    cdp,
    `[...document.querySelectorAll("span, p")].map(e => e.innerText).filter(t =>
       t.includes("show up in this list") || t.includes("model list") || t.includes("Checking your")).join(" || ")`,
  );

// ── Settings → Models ───────────────────────────────────────────────────────
{
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(FIXTURE, HTTP) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/settings.html?tab=models" });
  await wait(4000);

  const status = await statusLine(cdp);
  // The OLDEST list sets the age, so one fresh provider can't vouch for all.
  check("status line gives the oldest list's age", /Last checked 3 h ago/.test(status), true);
  check(
    "a provider that failed says why, plainly, and that its list may be stale",
    /Couldn't refresh Mistral's model list because it refused the key/.test(status),
    true,
  );
  await shot(cdp, `${OUT}/model-catalogue-settings.png`);

  // Open the default-model picker.
  await clickText(cdp, "Claude Sonnet 5");
  await wait(600);
  const groups = await pickerRows(cdp);
  const anthropic = groups.find((g) => g.heading?.toLowerCase() === "anthropic");
  const or = groups.find((g) => g.heading?.toLowerCase() === "openrouter");
  check(
    "a discovered Claude model is offered, once, after the curated ones",
    anthropic?.rows.filter((r) => r.startsWith("Claude Opus 5.6")).length === 1 &&
      anthropic.rows.indexOf(anthropic.rows.find((r) => r.startsWith("Claude Opus 5.6"))) >
        anthropic.rows.indexOf(anthropic.rows.find((r) => r.startsWith("Claude Haiku 4.5"))),
    true,
  );
  check(
    "curated models aren't listed twice",
    anthropic?.rows.filter((r) => r.startsWith("Claude Sonnet 5") && !r.startsWith("Claude Sonnet 5.5")).length,
    1,
  );
  check(
    "OpenRouter shows 5 discovered routes before a search",
    or?.rows.filter((r) => r.startsWith("Model ")).length,
    5,
  );
  check("…and says how many more a search reaches", or?.more, "7 more from OpenRouter — type to search");
  await shot(cdp, `${OUT}/model-catalogue-picker.png`, { selector: "[cmdk-root]" });

  // A search reaches past the preview.
  await evaluate(
    cdp,
    `(() => {
       const input = document.querySelector("[cmdk-input]");
       const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       set.call(input, "zeta");
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  await wait(500);
  const searched = await pickerRows(cdp);
  check(
    "searching finds a route the preview hid",
    searched.flatMap((g) => g.rows).some((r) => r.startsWith("Zeta Model")),
    true,
  );

  await evaluate(
    cdp,
    `(() => {
       const row = [...document.querySelectorAll("[cmdk-item]")].find(i => i.innerText.startsWith("Zeta Model"));
       row.click();
       return true;
     })()`,
  );
  await wait(600);
  check(
    "picking it saves the discovered id as the default",
    await lastWrite(cdp, evaluate, "defaultModelId"),
    "openrouter:vendor/zeta-model",
  );

  // Reopen: the last search must not still be sitting in the box.
  await clickText(cdp, "Zeta Model");
  await wait(600);
  check(
    "the picker reopens with an empty search",
    await evaluate(cdp, `document.querySelector("[cmdk-input]")?.value ?? null`),
    "",
  );
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await wait(400);

  // Check now: Settings doesn't fetch or write — it asks the main window.
  await clickText(cdp, "Check now");
  await wait(300);
  check(
    "Check now asks the main window to run the check",
    await evaluate(
      cdp,
      `window.__MOCK.calls.filter(c => c.cmd === "plugin:event|emit" && c.args.event === ${JSON.stringify(CHECK_REQUESTED)}).length`,
    ),
    1,
  );
  check(
    "…and Settings itself makes no provider calls",
    await evaluate(cdp, `window.__MOCK.calls.filter(c => c.cmd === "ai_http_stream").length`),
    0,
  );
  check("…while it waits, it says it's checking", /Checking your providers/.test(await statusLine(cdp)), true);

  check("no console errors (settings)", errors, []);
  cdp.close();
}

// ── Main window: a discovered default, and the check Settings asked for ─────
{
  const cdp = await connect();
  const errors = watchErrors(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const main = {
    ...FIXTURE,
    prefs: { ...FIXTURE.prefs, defaultModelId: "anthropic:claude-opus-5-6" },
  };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK(main, HTTP) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1300,
    height: 850,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:1420/index.html" });
  await wait(5000);

  const pill = await evaluate(
    cdp,
    `[...document.querySelectorAll("span")].find(s => s.textContent.startsWith("default"))?.textContent.replace(/\\s+/g, " ")`,
  );
  check("the status bar names the discovered default by its real name", /Claude Opus 5\.6/.test(pill ?? ""), true);
  check(
    "fresh lists, and a failure inside its retry window, aren't re-read at launch",
    await evaluate(cdp, `window.__MOCK.calls.filter(c => c.cmd === "ai_http_stream").length`),
    0,
  );
  await shot(cdp, `${OUT}/model-catalogue-statusbar.png`);

  // Settings' request arrives: every connected provider is asked again.
  await evaluate(
    cdp,
    `window.__LISTS = {
       "https://api.anthropic.com/v1/models": { data: [
         { type: "model", id: "claude-opus-6", display_name: "Claude Opus 6",
           created_at: new Date().toISOString(), max_input_tokens: 1000000, max_tokens: 128000,
           capabilities: { image_input: { supported: true } } } ], has_more: false },
       "https://openrouter.ai/api/v1/models": { data: [
         { id: "vendor/brand-new", name: "Vendor: Brand New", created: Math.floor(Date.now() / 1000),
           context_length: 200000, architecture: { input_modalities: ["text"], output_modalities: ["text"] },
           pricing: { prompt: "0.000001", completion: "0.000002" },
           top_provider: { max_completion_tokens: 8192 }, supported_parameters: ["tools"] } ] },
       "https://api.mistral.ai/v1/models": { __status: 401 },
     };
     window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: ${JSON.stringify(CHECK_REQUESTED)}, payload: null });
     true`,
  );
  await wait(1500);
  const urls = await evaluate(
    cdp,
    `window.__MOCK.calls.filter(c => c.cmd === "ai_http_stream").map(c => c.args.url.split("?")[0]).sort()`,
  );
  check("the main window asks every connected provider (OpenRouter's key-scoped list)", urls, [
    "https://api.anthropic.com/v1/models",
    "https://api.mistral.ai/v1/models",
    "https://openrouter.ai/api/v1/models/user",
  ]);
  const saved = (await lastWrite(cdp, evaluate, "catalog"))?.catalog;
  check(
    "the new lists are saved to the catalogue's own file",
    [saved?.anthropic?.models.map((m) => m.apiId), saved?.openrouter?.models.map((m) => m.apiId)],
    [["claude-opus-6"], ["vendor/brand-new"]],
  );
  check(
    "a provider that failed keeps its last good list",
    [saved?.mistral?.models.map((m) => m.apiId), saved?.mistral?.error?.startsWith("HTTP 401")],
    [["magistral-medium-latest"], true],
  );
  check(
    "nothing about the catalogue went into the settings file",
    await evaluate(
      cdp,
      `window.__MOCK.calls.some(c => c.cmd === "plugin:store|set" && c.args.key === "modelCatalog")`,
    ),
    false,
  );
  check("no console errors (main)", errors, []);
  cdp.close();
}

console.log(fail.length ? `\n${fail.length} FAILED:\n${fail.join("\n")}` : "\nall good");
process.exit(fail.length ? 1 : 0);
