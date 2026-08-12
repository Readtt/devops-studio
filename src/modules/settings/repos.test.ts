import { beforeEach, describe, expect, it, vi } from "vitest";

// store.ts is hand-maintained with no guard: adding a preference means editing
// six separate places, and missing one fails silently (the pref persists but
// never reaches the other window, or crashes first paint). These tests walk all
// six for `repos`.
const h = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  emitted: [] as { key: string; value: unknown }[],
  listeners: [] as { event: string; handler: (e: unknown) => void }[],
  launchDir: { value: undefined as string | undefined },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries() {
      return [...h.data.entries()];
    }
    async get(key: string) {
      return h.data.get(key);
    }
    async set(key: string, value: unknown) {
      h.data.set(key, value);
    }
    async delete(key: string) {
      return h.data.delete(key);
    }
    async save() {}
    async onChange() {
      return () => {};
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: async (_event: string, payload?: { key: string; value: unknown }) => {
    if (payload) h.emitted.push(payload);
  },
  listen: async (event: string, handler: (e: unknown) => void) => {
    h.listeners.push({ event, handler });
    return () => {};
  },
}));

vi.mock("@/lib/launchDir", () => ({
  consumeLaunchDir: () => {
    const v = h.launchDir.value;
    h.launchDir.value = undefined;
    return v;
  },
}));

import {
  addRepo,
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizeRepos,
  onPreferencesChange,
  primaryRepoRoot,
  removeRepo,
  renameRepo,
  setRepoAdo,
  setRepos,
  setSourceRoot,
  uniqueRepoName,
  validateRepoName,
  type WorkspaceRepo,
} from "./store";

const repo = (over: Partial<WorkspaceRepo> = {}): WorkspaceRepo => ({
  id: "id-one",
  name: "repo-one",
  root: "C:/dev/repo-one",
  ado: null,
  ...over,
});

const stored = () => h.data.get("repos") as WorkspaceRepo[] | undefined;

beforeEach(() => {
  h.data.clear();
  h.emitted.length = 0;
  h.listeners.length = 0;
  h.launchDir.value = undefined;
});

describe("repos preference · shape", () => {
  it("defaults to an empty array, not undefined", () => {
    // preferences.ts spreads DEFAULT_PREFERENCES as the zustand initial state,
    // so a missing default means every consumer maps over undefined on first
    // paint, before hydration finishes.
    expect(DEFAULT_PREFERENCES.repos).toEqual([]);
  });

  it("primaryRepoRoot reads repos[0], and null when there are none", () => {
    expect(primaryRepoRoot([])).toBeNull();
    expect(primaryRepoRoot([repo(), repo({ id: "b", root: "C:/dev/two" })])).toBe(
      "C:/dev/repo-one",
    );
  });
});

describe("repos preference · migration from the single source root", () => {
  it("seeds one repo from a legacy sourceRoot and persists it", async () => {
    h.data.set("sourceRoot", "C:/dev/repo-one");

    const prefs = await loadPreferences();

    expect(prefs.repos).toHaveLength(1);
    expect(prefs.repos[0]).toMatchObject({
      name: "repo-one",
      root: "C:/dev/repo-one",
      ado: null,
    });
    expect(prefs.repos[0].id).toBeTruthy();
    // Persisted, so the next boot doesn't mint a different id.
    expect(stored()).toEqual(prefs.repos);
    // And the single-root surfaces still resolve what sourceRoot used to answer.
    expect(primaryRepoRoot(prefs.repos)).toBe("C:/dev/repo-one");
  });

  it("ignores the legacy key once the registry exists", async () => {
    h.data.set("repos", [repo({ root: "C:/dev/kept" })]);
    h.data.set("sourceRoot", "C:/dev/stale");

    const prefs = await loadPreferences();

    expect(prefs.repos.map((r) => r.root)).toEqual(["C:/dev/kept"]);
    expect(primaryRepoRoot(prefs.repos)).toBe("C:/dev/kept");
  });

  it("does not write when there is nothing to migrate", async () => {
    h.data.set("repos", [repo()]);
    await loadPreferences();
    expect(h.emitted).toEqual([]);
  });

  it("boots clean with no settings at all", async () => {
    const prefs = await loadPreferences();
    expect(prefs.repos).toEqual([]);
    expect(primaryRepoRoot(prefs.repos)).toBeNull();
  });
});

describe("repos preference · launched folder", () => {
  it("becomes the registry on a fresh install", async () => {
    h.launchDir.value = "C:/dev/launched";

    const prefs = await loadPreferences();

    expect(prefs.repos.map((r) => r.root)).toEqual(["C:/dev/launched"]);
    expect(primaryRepoRoot(prefs.repos)).toBe("C:/dev/launched");
  });

  it("registers alongside configured repos and takes the front", async () => {
    // Before the registry, launching a folder took over the single source root.
    // Nothing is dropped now, but the launched folder is still what the
    // single-root surfaces see.
    h.data.set("repos", [repo({ root: "C:/dev/existing" })]);
    h.launchDir.value = "C:/dev/launched";

    const prefs = await loadPreferences();

    expect(prefs.repos.map((r) => r.root)).toEqual([
      "C:/dev/launched",
      "C:/dev/existing",
    ]);
  });

  it("moves an already-registered folder to the front without duplicating it", async () => {
    h.data.set("repos", [
      repo({ id: "a", name: "a", root: "C:/dev/a" }),
      repo({ id: "b", name: "b", root: "C:\\dev\\b" }),
    ]);
    h.launchDir.value = "C:/dev/b";

    const prefs = await loadPreferences();

    expect(prefs.repos.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("repos preference · cross-window updates", () => {
  it("maps the repos key so the other window's write lands in the store", async () => {
    // Miss this entry and the pref persists and loads fine, but the Settings
    // window and the main window silently desync.
    const seen: [string, unknown][] = [];
    await onPreferencesChange((key, value) => seen.push([key, value]));

    const bus = h.listeners.find((l) => l.event === "devops-studio://prefs-changed");
    expect(bus).toBeDefined();
    bus?.handler({ payload: { key: "repos", value: [repo()] } });

    expect(seen).toEqual([["repos", [repo()]]]);
  });

  it("emits on every registry write", async () => {
    // Hand-rolling store.set + store.save without the emit is the footgun:
    // the Settings window is a separate webview and never sees such a write.
    await setRepos([repo()]);

    expect(h.emitted).toEqual([{ key: "repos", value: [repo()] }]);
  });
});

describe("repos preference · normalization backstop", () => {
  // preferences.ts blind-sets whatever a change event carries, so a malformed
  // payload from any window would otherwise land in the store verbatim.
  it("forces names unique, case-insensitively", () => {
    const out = normalizeRepos([
      { id: "a", name: "api", root: "C:/dev/a", ado: null },
      { id: "b", name: "API", root: "C:/dev/b", ado: null },
      { id: "c", name: "api", root: "C:/dev/c", ado: null },
    ]);
    expect(out.map((r) => r.name)).toEqual(["api", "API-2", "api-3"]);
  });

  it("strips path separators — the name is a virtual-path namespace", () => {
    const out = normalizeRepos([{ id: "a", name: "team/api", root: "C:/dev/a" }]);
    expect(out[0].name).toBe("team-api");
  });

  it("falls back to the folder basename when the name is unusable", () => {
    const out = normalizeRepos([
      { id: "a", name: "   ", root: "C:/dev/repo-one/" },
      { id: "b", root: "C:\\dev\\repo-two" },
    ]);
    expect(out.map((r) => r.name)).toEqual(["repo-one", "repo-two"]);
  });

  it("drops entries with no root and repeats of one", () => {
    const out = normalizeRepos([
      { id: "a", name: "a", root: "C:/dev/a" },
      { id: "b", name: "b", root: "" },
      { id: "c", name: "c" },
      // Same folder, different spelling — Windows paths are case- and
      // separator-insensitive.
      { id: "d", name: "d", root: "c:\\dev\\a\\" },
      "nonsense",
      null,
    ]);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("mints an id for an entry missing one, and drops a malformed ado binding", () => {
    const out = normalizeRepos([
      { name: "a", root: "C:/dev/a", ado: { repoName: "A" } },
    ]);
    expect(out[0].id).toBeTruthy();
    expect(out[0].ado).toBeNull();
  });

  it("returns an empty list for a non-array payload", () => {
    expect(normalizeRepos(undefined)).toEqual([]);
    expect(normalizeRepos({ root: "C:/dev/a" })).toEqual([]);
  });
});

describe("repos preference · setters", () => {
  it("setSourceRoot writes the registry, not the legacy key", async () => {
    await setSourceRoot("C:/dev/picked");

    expect(stored()?.map((r) => r.root)).toEqual(["C:/dev/picked"]);
    expect(h.data.has("sourceRoot")).toBe(false);
  });

  it("setSourceRoot keeps the entry's id and ADO binding when the folder is unchanged", async () => {
    const ado = { repoId: "r1", repoName: "RepoOne", project: "Proj" };
    h.data.set("repos", [repo({ ado })]);

    await setSourceRoot("C:\\dev\\repo-one");

    expect(stored()?.[0]).toMatchObject({ id: "id-one", ado });
  });

  it("setSourceRoot(null) empties the registry", async () => {
    h.data.set("repos", [repo()]);
    await setSourceRoot(null);
    expect(stored()).toEqual([]);
  });

  it("addRepo is idempotent on a root already registered", async () => {
    h.data.set("repos", [repo()]);

    const added = await addRepo("C:\\dev\\repo-one\\");

    expect(added.id).toBe("id-one");
    expect(stored()).toHaveLength(1);
  });

  it("addRepo defaults the name to the basename and uniquifies it", async () => {
    h.data.set("repos", [repo({ name: "api", root: "C:/one/api" })]);

    const added = await addRepo("C:/two/api");

    expect(added.name).toBe("api-2");
    expect(stored()?.map((r) => r.name)).toEqual(["api", "api-2"]);
  });

  it("renameRepo rejects a duplicate by suffixing, leaving others alone", async () => {
    h.data.set("repos", [
      repo({ id: "a", name: "a", root: "C:/dev/a" }),
      repo({ id: "b", name: "b", root: "C:/dev/b" }),
    ]);

    await renameRepo("b", "a");

    expect(stored()?.map((r) => r.name)).toEqual(["a", "a-2"]);
  });

  it("removeRepo drops just that entry", async () => {
    h.data.set("repos", [
      repo({ id: "a", name: "a", root: "C:/dev/a" }),
      repo({ id: "b", name: "b", root: "C:/dev/b" }),
    ]);

    await removeRepo("a");

    expect(stored()?.map((r) => r.id)).toEqual(["b"]);
  });

  it("setRepoAdo binds one repo and can unbind it", async () => {
    const ado = { repoId: "r1", repoName: "RepoOne", project: "Proj" };
    h.data.set("repos", [repo()]);

    await setRepoAdo("id-one", ado);
    expect(stored()?.[0].ado).toEqual(ado);

    await setRepoAdo("id-one", null);
    expect(stored()?.[0].ado).toBeNull();
  });
});

// The Settings name field validates BEFORE writing, because the write-side
// backstop would otherwise "fix" a collision by renaming behind the user.
describe("repos preference · name validation", () => {
  it("accepts a fresh name", () => {
    expect(validateRepoName("repo-three", ["repo-one", "repo-two"])).toBeNull();
  });

  it("rejects empty and whitespace-only names", () => {
    expect(validateRepoName("", [])).toBe("Name can't be empty.");
    expect(validateRepoName("   ", [])).toBe("Name can't be empty.");
  });

  it("rejects path separators, which would break AI repo-prefixed paths", () => {
    expect(validateRepoName("a/b", [])).toBe("Name can't contain / or \\.");
    expect(validateRepoName("a\\b", [])).toBe("Name can't contain / or \\.");
  });

  it("rejects a name another repo already uses, case-insensitively", () => {
    const taken = ["repo-one"];
    expect(validateRepoName("repo-one", taken)).toBe(
      "Another repo already uses that name.",
    );
    expect(validateRepoName("REPO-ONE", taken)).toBe(
      "Another repo already uses that name.",
    );
    expect(validateRepoName("  repo-one  ", taken)).toBe(
      "Another repo already uses that name.",
    );
    // A stored name should already be trimmed, but preferences.ts blind-sets
    // whatever a change event carries — so the comparison trims both sides.
    expect(validateRepoName("repo-one", ["  repo-one  "])).toBe(
      "Another repo already uses that name.",
    );
  });

  it("agrees with uniqueRepoName: a name it accepts survives the write path", () => {
    // Drift here is the failure mode — the field says OK, then the registry
    // silently stores something else.
    const taken = ["repo-one", "repo-two"];
    expect(validateRepoName("repo-three", taken)).toBeNull();
    expect(uniqueRepoName("repo-three", taken)).toBe("repo-three");
  });
});
