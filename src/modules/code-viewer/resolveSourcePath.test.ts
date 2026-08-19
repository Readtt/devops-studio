import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  resolveSourcePath,
  resolveSourcePathDeep,
  virtualSourcePath,
} from "./resolveSourcePath";
import { createRepo } from "@/modules/settings/store";

const one = createRepo("C:/dev/repo-one");
const two = createRepo("C:/dev/repo-two");
const REPOS = [one, two];

/** Back the two backend commands with a set of files that "exist". */
function withFiles(files: string[]) {
  const has = (p: string) =>
    files.some((f) => f.toLowerCase() === p.replace(/\\/g, "/").toLowerCase());
  invoke.mockImplementation((cmd: string, args: Record<string, string>) => {
    if (cmd === "fs_stat") {
      return has(args.path)
        ? Promise.resolve({})
        : Promise.reject(new Error("not found"));
    }
    if (cmd === "fs_resolve_source_path") {
      const root = args.root.replace(/\\/g, "/");
      const direct = `${root}/${args.path.replace(/\\/g, "/")}`;
      if (has(direct)) return Promise.resolve(direct.replace(/\//g, "\\"));
      // Fuzzy: any file under this root whose basename matches.
      const base = args.path.split(/[\\/]/).pop()!.toLowerCase();
      const hit = files.find(
        (f) =>
          f.toLowerCase().startsWith(`${root.toLowerCase()}/`) &&
          f.split("/").pop()!.toLowerCase() === base,
      );
      return Promise.resolve(hit ? hit.replace(/\//g, "\\") : null);
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("resolveSourcePath (sync)", () => {
  it("binds a repo-prefixed path to that repo", () => {
    const r = resolveSourcePath(REPOS, "repo-two/src/x.ts");
    expect(r?.repo?.name).toBe(two.name);
    expect(r?.path).toBe("C:\\dev\\repo-two\\src\\x.ts");
  });

  it("attributes an absolute path to the repo containing it", () => {
    const r = resolveSourcePath(REPOS, "C:/dev/repo-one/src/x.ts");
    expect(r?.repo?.name).toBe(one.name);
  });

  it("leaves an absolute path outside every repo unattributed but openable", () => {
    const r = resolveSourcePath(REPOS, "D:/elsewhere/x.ts");
    expect(r?.repo).toBeNull();
    expect(r?.path).toBe("D:\\elsewhere\\x.ts");
  });

  it("tolerates a missing prefix at exactly one repo, refuses past it", () => {
    expect(resolveSourcePath([one], "src/x.ts")?.repo?.name).toBe(one.name);
    expect(resolveSourcePath(REPOS, "src/x.ts")).toBeNull();
  });

  it("refuses a secret file even when the repo is unambiguous", () => {
    expect(resolveSourcePath(REPOS, "repo-one/.env")).toBeNull();
    expect(resolveSourcePath([one], "config/id_rsa")).toBeNull();
  });
});

describe("resolveSourcePathDeep", () => {
  it("opens a prefixed path from its own repo", async () => {
    withFiles(["C:/dev/repo-one/src/x.ts", "C:/dev/repo-two/src/x.ts"]);
    const r = await resolveSourcePathDeep(REPOS, "repo-two/src/x.ts");
    expect(r?.repo?.name).toBe(two.name);
    expect(r?.path).toBe("C:\\dev\\repo-two\\src\\x.ts");
  });

  it("finds an abbreviated citation inside the repo it names", async () => {
    // The model cited `repo-two/Report.cs`; the file is really in a subdir.
    withFiles(["C:/dev/repo-one/Report.cs", "C:/dev/repo-two/deep/dir/Report.cs"]);
    const r = await resolveSourcePathDeep(REPOS, "repo-two/Report.cs");
    expect(r?.repo?.name).toBe(two.name);
    expect(r?.path).toBe("C:\\dev\\repo-two\\deep\\dir\\Report.cs");
  });

  it("searches every repo for a bare path, not just the first", async () => {
    // The legacy-work-item case: no prefix, and the file is in repo-two.
    withFiles(["C:/dev/repo-two/deep/Report.cs"]);
    const r = await resolveSourcePathDeep(REPOS, "Report.cs");
    expect(r?.repo?.name).toBe(two.name);
    expect(r?.path).toBe("C:\\dev\\repo-two\\deep\\Report.cs");
  });

  it("binds a bare path that exists in exactly one repo to that repo", async () => {
    withFiles(["C:/dev/repo-two/src/x.ts"]);
    const r = await resolveSourcePathDeep(REPOS, "src/x.ts");
    expect(r?.repo?.name).toBe(two.name);
  });

  it("refuses a path that climbs out of its repo", async () => {
    withFiles(["C:/dev/secrets.txt"]);
    expect(await resolveSourcePathDeep(REPOS, "repo-one/../secrets.txt")).toBeNull();
  });

  it("refuses a secret file the fuzzy search would otherwise land on", async () => {
    withFiles(["C:/dev/repo-one/.env"]);
    expect(await resolveSourcePathDeep(REPOS, ".env")).toBeNull();
    expect(await resolveSourcePathDeep(REPOS, "repo-one/.env")).toBeNull();
  });

  it("falls back to the naive join when nothing on disk answers", async () => {
    withFiles([]);
    const r = await resolveSourcePathDeep(REPOS, "repo-one/src/gone.ts");
    // Still a path, so the viewer's not-found hint can name it.
    expect(r?.path).toBe("C:\\dev\\repo-one\\src\\gone.ts");
    expect(r?.repo?.name).toBe(one.name);
  });

  it("returns null when there's nowhere to look", async () => {
    withFiles([]);
    expect(await resolveSourcePathDeep([], "src/x.ts")).toBeNull();
  });
});

describe("virtualSourcePath", () => {
  it("renders the <repo>/<path> form of an absolute path", () => {
    expect(virtualSourcePath(REPOS, "C:\\dev\\repo-two\\src\\x.ts")).toBe(
      "repo-two/src/x.ts",
    );
  });

  it("falls back to the absolute path when no repo claims it", () => {
    expect(virtualSourcePath(REPOS, "D:/elsewhere/x.ts")).toBe("D:\\elsewhere\\x.ts");
  });
});
