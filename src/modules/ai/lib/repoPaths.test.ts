import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { REPO_PATH_RULE, resolveRepoPath, splitRepoPath } from "./repoPaths";
import type { WorkspaceRepo } from "@/modules/settings/store";

function repo(name: string, root: string): WorkspaceRepo {
  return { id: `id-${name}`, name, root, ado: null };
}

const ONE = repo("repo-one", "C:\\src\\repo-one");
const TWO = repo("repo-two", "C:\\src\\repo-two");
const THREE = repo("repo-three", "C:\\src\\repo-three");
const MANY = [ONE, TWO, THREE];

/** Make the fs_stat probe answer for a given set of existing paths. Rust
 *  REJECTS on a missing path — it does not return null — which is the whole
 *  reason the probe has to catch. */
function existing(...paths: string[]) {
  const set = new Set(paths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
    if (cmd !== "fs_stat") throw new Error(`unexpected command ${cmd}`);
    const key = args.path.replace(/\\/g, "/").toLowerCase();
    if (!set.has(key)) throw `no such file or directory: ${args.path}`;
    return { size: 10, mtime: 0, kind: "file" };
  });
}

beforeEach(() => {
  invoke.mockReset();
  existing();
});

describe("resolveRepoPath · addressing", () => {
  it("resolves a repo-prefixed path without probing for it", async () => {
    const out = await resolveRepoPath("repo-two/src/app.ts", MANY);
    expect(out).toMatchObject({
      ok: true,
      absPath: "C:\\src\\repo-two\\src\\app.ts",
      virtualPath: "repo-two/src/app.ts",
    });
    // The prefix names the repo outright, so the ambiguity probe never runs.
    // The canonical read gate still does — see the symlink case below.
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "fs_stat"),
    ).toHaveLength(0);
  });

  it("refuses a path whose canonical form escapes into a protected dir", async () => {
    // `vendor/cache` is a junction to the user's home; nothing about the
    // literal path says so, and Rust follows it.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "fs_canonicalize") throw new Error(`unexpected ${cmd}`);
      return "/home/me/.ssh/id_rsa";
    });
    const out = await resolveRepoPath("repo-two/vendor/cache/id_rsa", MANY);
    expect(out.ok).toBe(false);
  });

  it("reads through to the canonical path when it is still allowed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "fs_canonicalize") throw new Error(`unexpected ${cmd}`);
      return "C:\\real\\repo-two\\src\\app.ts";
    });
    const out = await resolveRepoPath("repo-two/src/app.ts", MANY);
    expect(out).toMatchObject({
      ok: true,
      absPath: "C:\\real\\repo-two\\src\\app.ts",
      virtualPath: "repo-two/src/app.ts",
    });
  });

  it("matches the repo name case-insensitively", async () => {
    const out = await resolveRepoPath("REPO-TWO/src/app.ts", MANY);
    expect(out.ok && out.repo.id).toBe(TWO.id);
  });

  // The prefix is the canonical form at every repo count, so a bare path at
  // N=1 is a tolerated shorthand that gets corrected rather than an error.
  it("tolerates a forgotten prefix when only one repo is configured", async () => {
    const out = await resolveRepoPath("src/app.ts", [ONE]);
    expect(out).toMatchObject({
      ok: true,
      absPath: "C:\\src\\repo-one\\src\\app.ts",
      virtualPath: "repo-one/src/app.ts",
      corrected: "repo-one/src/app.ts",
    });
  });

  it("leaves `corrected` off a path that was already canonical", async () => {
    const out = await resolveRepoPath("repo-one/src/app.ts", [ONE]);
    expect(out.ok && out.corrected).toBeUndefined();
  });

  it("accepts an absolute path inside a configured repo", async () => {
    const out = await resolveRepoPath("C:/src/repo-three/lib/x.cs", MANY);
    expect(out).toMatchObject({
      ok: true,
      virtualPath: "repo-three/lib/x.cs",
      corrected: "repo-three/lib/x.cs",
    });
  });

  it("matches an absolute path whichever separator it arrives in", async () => {
    const out = await resolveRepoPath("c:\\SRC\\repo-one\\a.ts", MANY);
    expect(out.ok && out.repo.id).toBe(ONE.id);
  });

  it("resolves a bare repo name to the repo root", async () => {
    const out = await resolveRepoPath("repo-two", MANY);
    expect(out).toMatchObject({
      ok: true,
      absPath: "C:\\src\\repo-two",
      virtualPath: "repo-two",
    });
  });
});

describe("resolveRepoPath · the ambiguity probe", () => {
  it("adopts the single repo that actually has the file", async () => {
    existing("C:/src/repo-three/src/app.ts");
    const out = await resolveRepoPath("src/app.ts", MANY);
    expect(out).toMatchObject({
      ok: true,
      virtualPath: "repo-three/src/app.ts",
      corrected: "repo-three/src/app.ts",
    });
  });

  it("refuses a bare path that exists in several repos, naming them", async () => {
    existing("C:/src/repo-one/src/app.ts", "C:/src/repo-two/src/app.ts");
    const out = await resolveRepoPath("src/app.ts", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toContain("repo-one");
    expect(out.reason).toContain("repo-two");
    expect(out.reason).not.toContain("repo-three");
  });

  it("refuses a bare path no repo has, listing the repos to prefix with", async () => {
    const out = await resolveRepoPath("src/app.ts", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toContain("repo-one, repo-two, repo-three");
  });

  // fs_stat rejects on a missing path rather than resolving to null, so a
  // probe that doesn't catch takes the whole resolution down with it.
  it("survives an fs_stat rejection instead of throwing", async () => {
    invoke.mockRejectedValue("Access is denied. (os error 5)");
    await expect(resolveRepoPath("src/app.ts", MANY)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("resolveRepoPath · containment", () => {
  it("refuses an absolute path outside every repo", async () => {
    const out = await resolveRepoPath("C:/Windows/System32/drivers/etc/hosts", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toMatch(/outside every configured repo/);
  });

  // A sibling directory sharing a name prefix is not "inside" the repo.
  it("does not treat a name-prefix neighbour as inside the repo", async () => {
    const out = await resolveRepoPath("C:/src/repo-one-backup/secrets.txt", [ONE]);
    expect(out.ok).toBe(false);
  });

  it("refuses a `..` traversal out of the repo", async () => {
    const out = await resolveRepoPath("repo-one/../repo-two/app.ts", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toMatch(/outside repo-one/);
  });

  it("still allows a `..` that stays inside the repo", async () => {
    const out = await resolveRepoPath("repo-one/src/../lib/x.ts", MANY);
    expect(out).toMatchObject({ ok: true, virtualPath: "repo-one/lib/x.ts" });
  });

  it("refuses a secret basename even inside a configured repo", async () => {
    const out = await resolveRepoPath("repo-one/.env.production", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toMatch(/sensitive-file pattern/);
  });

  it("refuses a protected directory inside a configured repo", async () => {
    const out = await resolveRepoPath("repo-one/.git/config", MANY);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toMatch(/protected directory/);
  });

  it("refuses an empty path", async () => {
    expect(await resolveRepoPath('""', MANY)).toMatchObject({ ok: false });
  });

  it("refuses everything when no repos are configured", async () => {
    const out = await resolveRepoPath("C:/src/repo-one/a.ts", []);
    expect(out.ok).toBe(false);
  });
});

// Publish reads a link's repo binding off the path it was emitted with. It has
// to agree with the resolver above — a path the model was allowed to read must
// be a path publish can attribute — but it never touches the disk to do it.
describe("splitRepoPath · the sync repo binding", () => {
  it("reads the repo off the prefix and returns the rest", () => {
    expect(splitRepoPath("repo-two/src/app.ts", MANY)).toEqual({
      repo: TWO,
      within: "src/app.ts",
    });
  });

  it("matches the prefix case-insensitively, like the resolver", () => {
    expect(splitRepoPath("REPO-TWO/src/app.ts", MANY)?.repo.id).toBe(TWO.id);
  });

  it("tolerates a missing prefix at one repo", () => {
    expect(splitRepoPath("src/app.ts", [ONE])).toEqual({
      repo: ONE,
      within: "src/app.ts",
    });
  });

  // The ambiguity the resolver settles with an fs probe has no sync answer, so
  // this refuses rather than guessing — publish drops the link instead of
  // stamping some other repo's branch onto it.
  it("returns null for an unprefixed path once several repos exist", () => {
    expect(splitRepoPath("src/app.ts", MANY)).toBeNull();
  });

  it("returns null when the prefix names no configured repo", () => {
    expect(splitRepoPath("repo-four/src/app.ts", MANY)).toBeNull();
  });

  it("returns null with no repos configured", () => {
    expect(splitRepoPath("repo-one/src/app.ts", [])).toBeNull();
  });

  it("normalises separators before splitting", () => {
    expect(splitRepoPath("./repo-two\\src\\app.ts", MANY)).toEqual({
      repo: TWO,
      within: "src/app.ts",
    });
  });
});

// The rule ships on every request of every AI surface. These pin the two facts
// a surface prompt leans on when it references it, so a rewrite can't quietly
// drop them.
describe("REPO_PATH_RULE", () => {
  it("states the prefixed form and names run_command's repo argument", () => {
    expect(REPO_PATH_RULE).toContain("<repo>/<path within repo>");
    expect(REPO_PATH_RULE).toMatch(/run_command\` runs inside ONE repo/);
  });

  it("makes no claim about how the repos relate", () => {
    expect(REPO_PATH_RULE).toMatch(/may relate to each other in any way/);
  });
});
