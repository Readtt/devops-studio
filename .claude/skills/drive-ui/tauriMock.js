// A stand-in for the Tauri IPC boundary, injected via
// Page.addScriptToEvaluateOnNewDocument so it is in place BEFORE the app's
// modules run and `@tauri-apps/api` reads window.__TAURI_INTERNALS__.
//
// Everything above the boundary is real: the real React tree, real Tailwind,
// real Radix, real zustand stores, real store.ts logic. Only the Rust side is
// faked — which is the point, because it lets you drive states the machine you
// are on cannot produce (twenty repos, a detached HEAD, an offline share).

/**
 * @param fixture {{
 *   prefs?: Record<string, unknown>,   // seeds the Tauri store (i.e. preferences)
 *   commands?: Record<string, unknown>,// command -> value, or path-keyed map, or {__reject: msg}
 *   dialog?: string | string[] | null, // what plugin:dialog|open returns next
 * }}
 * @param extraSource {string} raw JS spliced into the command switch, for
 *   anything the data-driven form can't express. Runs BEFORE the table lookup
 *   and has `cmd` and `args` in scope; `return` a value to answer the call.
 */
export const MOCK = (fixture, extraSource = "") => `
(() => {
  const F = ${JSON.stringify(fixture)};
  const state = { ...F, calls: [] };
  window.__MOCK = state;

  const listeners = new Map();   // event name -> Set(callbackId)
  const callbacks = new Map();   // callbackId -> fn
  let cbId = 0;

  const storeData = new Map(Object.entries(F.prefs ?? {}));
  state.store = storeData;

  async function invoke(cmd, args = {}) {
    state.calls.push({ cmd, args });

    ${extraSource}

    // ---- event plugin ---------------------------------------------------
    if (cmd === "plugin:event|listen") {
      const set = listeners.get(args.event) ?? new Set();
      set.add(args.handler);
      listeners.set(args.event, set);
      // The callback id IS the event id: it's what unregisterListener gets back.
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      // v2 hands the payload over as a live object, NOT a JSON string.
      for (const id of listeners.get(args.event) ?? []) {
        const fn = callbacks.get(id);
        if (fn) fn({ event: args.event, id, payload: args.payload ?? null });
      }
      return null;
    }

    // ---- store plugin ---------------------------------------------------
    if (cmd.startsWith("plugin:store|")) {
      const op = cmd.slice("plugin:store|".length);
      // v2's get returns a [value, exists] pair, not a bare value.
      if (op === "get") return [storeData.get(args.key) ?? null, storeData.has(args.key)];
      if (op === "set") { storeData.set(args.key, args.value); return null; }
      if (op === "delete") return storeData.delete(args.key);
      if (op === "entries") return [...storeData.entries()];
      if (op === "keys") return [...storeData.keys()];
      if (op === "values") return [...storeData.values()];
      if (op === "length") return storeData.size;
      if (op === "has") return storeData.has(args.key);
      if (op === "reset" || op === "clear") { storeData.clear(); return null; }
      return null;   // load / save / create_store / onChange
    }

    if (cmd === "plugin:dialog|open") {
      const d = state.dialog ?? null;
      state.dialog = null;          // one-shot, like a real picker
      return d;
    }
    if (cmd === "plugin:autostart|is_enabled") return false;
    if (cmd === "plugin:os|platform") return "windows";

    // ---- app commands, from the fixture table ---------------------------
    if (Object.prototype.hasOwnProperty.call(state.commands ?? {}, cmd)) {
      const spec = state.commands[cmd];
      const resolved = resolve(spec, args);
      if (resolved && resolved.__reject) throw new Error(resolved.__reject);
      if (resolved === undefined) {
        // A path-keyed table with no entry means "this path does not exist".
        // Several Rust commands REJECT rather than return null (fs_stat is the
        // one that bites); mirroring that is what makes probe code testable.
        throw new Error(cmd + ": no fixture for " + JSON.stringify(args));
      }
      return resolved;
    }

    return null;
  }

  // A fixture entry is either the answer itself, or a map keyed by the call's
  // first string argument (path / root / cwd), which is how nearly every
  // fs_*/git_* command in this app is addressed.
  function resolve(spec, args) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return spec;
    if (spec.__reject) return spec;
    const key = args.path ?? args.root ?? args.cwd;
    if (typeof key === "string" && !("__value" in spec)) {
      return Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : undefined;
    }
    return "__value" in spec ? spec.__value : spec;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(fn, once) {
      const id = ++cbId;
      callbacks.set(id, (...a) => { if (once) callbacks.delete(id); return fn(...a); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    plugins: {},
  };

  // The unlisten returned by listen() goes through here, NOT through invoke.
  // Without it every Tauri-bus subscriber throws on unmount — which in React
  // dev mode is the very first thing that happens.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      listeners.get(event)?.delete(eventId);
      callbacks.delete(eventId);
    },
  };
})();
`;

/** Last value written to a preference key — the assertion for "did this
 *  actually persist, or did the UI just look right?" */
export const lastWrite = (cdp, evaluate, key) =>
  evaluate(
    cdp,
    `(() => {
       const w = window.__MOCK.calls
         .filter(c => c.cmd === "plugin:store|set" && c.args.key === ${JSON.stringify(key)});
       return w.length ? w[w.length - 1].args.value : null;
     })()`,
  );
