import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { resolveRepoPath } from "./repoPaths";
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
  it("resolves a repo-prefixed path without touching the filesystem", async () => {
    const out = await resolveRepoPath("repo-two/src/app.ts", MANY);
    expect(out).toMatchObject({
      ok: true,
      absPath: "C:\\src\\repo-two\\src\\app.ts",
      virtualPath: "repo-two/src/app.ts",
    });
    expect(invoke).not.toHaveBeenCalled();
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
