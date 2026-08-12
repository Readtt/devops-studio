// Dependency-free Chrome DevTools Protocol driver.
//
// Node 21+ ships a global WebSocket, so this needs no packages at all — which
// matters, because `pnpm add -D playwright` would put a 300 MB browser download
// and a devDependency into a repo that has no other test-browser story.

const PORT = Number(process.env.CDP_PORT ?? 9333);

const http = (path) =>
  fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((res, rej) => {
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}

function wrap(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    } else {
      events.push(msg);
    }
  };
  return {
    events,
    close: () => ws.close(),
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
  };
}

/**
 * Attach to Chrome and hand back a page session.
 *
 * Always creates a FRESH tab. `Page.addScriptToEvaluateOnNewDocument` is
 * registered per target and never cleared, so reusing a tab across runs leaves
 * the previous run's Tauri mock installed — you get a stale fixture and errors
 * that point at code you already fixed.
 */
export async function connect() {
  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await http("/json/version");
      break;
    } catch {
      await wait(500);
    }
  }
  if (!version) throw new Error(`no Chrome on :${PORT} — see SKILL.md for the launch line`);

  const browser = wrap(await openSocket(version.webSocketDebuggerUrl));
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });

  let target;
  for (let i = 0; i < 20 && !target; i++) {
    target = (await http("/json/list")).find((t) => t.id === targetId);
    if (!target) await wait(200);
  }
  if (!target) throw new Error("fresh target never appeared");

  const page = wrap(await openSocket(target.webSocketDebuggerUrl));
  page.close = () => {
    browser.send("Target.closeTarget", { targetId }).catch(() => {});
    browser.close();
  };
  return page;
}

export async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      "PAGE ERROR: " +
        (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
    );
  }
  return r.result.value;
}

/** Collect console errors and uncaught exceptions. A silent run is the point:
 *  a React render that throws still screenshots as a blank-ish page. */
export function watchErrors(cdp) {
  const errors = [];
  const timer = setInterval(() => {
    for (const e of cdp.events.splice(0)) {
      if (e.method === "Runtime.exceptionThrown") {
        errors.push(
          e.params.exceptionDetails.exception?.description ??
            e.params.exceptionDetails.text,
        );
      }
      if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
        errors.push(e.params.args.map((a) => a.description ?? a.value).join(" "));
      }
    }
  }, 100);
  timer.unref?.();
  return errors;
}

/** Screenshot. Pass `selector` to clip to one element — far more readable than
 *  a full page when you only changed one pane. */
export async function shot(cdp, path, opts = {}) {
  const fs = await import("node:fs");
  let clip;
  if (opts.selector) {
    const r = await evaluate(
      cdp,
      `(() => {
         const el = document.querySelector(${JSON.stringify(opts.selector)});
         if (!el) return null;
         const b = el.getBoundingClientRect();
         return { x: b.x, y: b.y, width: b.width, height: b.height };
       })()`,
    );
    if (!r) throw new Error(`selector not found: ${opts.selector}`);
    clip = { ...r, scale: opts.scale ?? 1 };
  }
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: opts.full ?? false,
    ...(clip ? { clip } : {}),
  });
  fs.writeFileSync(path, Buffer.from(r.data, "base64"));
  return path;
}

/* -------------------------------------------------------------------------- */
/*  Input — synthetic DOM events are not enough                                */
/* -------------------------------------------------------------------------- */

/** Type into an input, replacing its contents.
 *
 *  `new Event("input")` + `new Event("blur")` does NOT work: React delegates
 *  blur through `focusout`, so a hand-built blur event never reaches onBlur and
 *  any commit-on-blur handler silently no-ops. Input.insertText goes through the
 *  browser's real input pipeline instead. */
export async function typeInto(cdp, selector, text, index = 0) {
  await evaluate(
    cdp,
    `(() => {
       const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
       if (!el) throw new Error("no element #${index}: " + ${JSON.stringify(selector)});
       el.focus();
       el.setSelectionRange?.(0, el.value.length);
       return true;
     })()`,
  );
  await cdp.send("Input.insertText", { text });
  await wait(150);
}

export async function pressKey(cdp, key) {
  const map = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Escape: { code: "Escape", vk: 27, text: "" },
    Tab: { code: "Tab", vk: 9, text: "\t" },
  };
  const k = map[key];
  if (!k) throw new Error(`unmapped key: ${key}`);
  for (const type of ["rawKeyDown", "char", "keyUp"]) {
    if (type === "char" && !k.text) continue;
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      text: k.text,
      unmodifiedText: k.text,
    });
  }
  await wait(300);
}

/** Click that Radix actually hears.
 *
 *  Radix menus, popovers and selects open on `pointerdown`, not `click` — an
 *  `el.click()` on a DropdownMenuTrigger does nothing at all. */
export async function click(cdp, selector) {
  await evaluate(
    cdp,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) throw new Error("no element: " + ${JSON.stringify(selector)});
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1,
                   pointerType: "mouse", isPrimary: true };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(400);
}

/** Click the first element whose text contains `text`. Buttons in this codebase
 *  rarely have stable ids; their labels are the reliable handle. */
export async function clickText(cdp, text, tag = "button") {
  await evaluate(
    cdp,
    `(() => {
       const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
         .find(b => b.innerText.includes(${JSON.stringify(text)}));
       if (!el) throw new Error("no ${tag} containing: " + ${JSON.stringify(text)});
       const o = { bubbles: true, cancelable: true, button: 0, buttons: 1,
                   pointerType: "mouse", isPrimary: true };
       el.dispatchEvent(new PointerEvent("pointerdown", o));
       el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  await wait(400);
}

export { wait };
