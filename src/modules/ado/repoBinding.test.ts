import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

const setRepoAdo = vi.fn(async () => {});
vi.mock("@/modules/settings/store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/settings/store")>(
    "@/modules/settings/store",
  );
  return { ...actual, setRepoAdo: (...a: unknown[]) => setRepoAdo(...(a as [])) };
});

import {
  autoBindRepos,
  bindRepo,
  matchAdoRepo,
  normalizeRemoteUrl,
  parseAdoRemote,
} from "./repoBinding";
import type { RepoRef } from "./types";
import type { WorkspaceRepo } from "@/modules/settings/store";

function adoRepo(
  name: string,
  project: string | null,
  remoteUrl: string | null,
  id = `guid-${name}-${project ?? "none"}`,
): RepoRef {
  return { id, name, project, remoteUrl, defaultBranch: "main", webUrl: null };
}

function repo(name: string, root: string, ado: WorkspaceRepo["ado"] = null): WorkspaceRepo {
  return { id: `id-${name}`, name, root, ado };
}

/** `git_remote_url` answers per root; anything unlisted has no `origin`.
 *
 *  Asserting the command NAME matters: the remote used to ride along on
 *  `git_repo_info`, which is the status bar's 30 s poll for every repo. If the
 *  binder ever reaches for that again, this throws rather than quietly putting
 *  a fourth git spawn per repo back on the poll path. */
function remotes(byRoot: Record<string, string | null>) {
  invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
    if (cmd !== "git_remote_url") throw new Error(`unexpected command ${cmd}`);
    return byRoot[args.path] ?? null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  setRepoAdo.mockClear();
  remotes({});
});

describe("normalizeRemoteUrl", () => {
  it("reduces ADO's userinfo clone URL to the API's bare one", () => {
    expect(
      normalizeRemoteUrl("https://org@dev.azure.com/org/Project/_git/repo-one.git"),
    ).toBe(normalizeRemoteUrl("https://dev.azure.com/org/Project/_git/repo-one"));
  });

  it("resolves percent-escapes so an encoded project matches a spelled one", () => {
    expect(normalizeRemoteUrl("https://dev.azure.com/org/My%20Project/_git/repo")).toBe(
      "dev.azure.com/org/my project/_git/repo",
    );
  });

  it("rewrites scp-style SSH remotes into host/path form", () => {
    expect(normalizeRemoteUrl("git@ssh.dev.azure.com:v3/org/Project/repo-one")).toBe(
      "ssh.dev.azure.com/v3/org/project/repo-one",
    );
  });

  it("is null for empty and non-string input", () => {
    expect(normalizeRemoteUrl("   ")).toBeNull();
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl(undefined)).toBeNull();
  });
});

describe("parseAdoRemote", () => {
  it("reads project + repo out of every ADO URL shape", () => {
    expect(parseAdoRemote("https://dev.azure.com/org/Proj/_git/repo-one")).toEqual({
      project: "proj",
      repo: "repo-one",
    });
    expect(parseAdoRemote("https://org.visualstudio.com/Proj/_git/repo-one")).toEqual({
      project: "proj",
      repo: "repo-one",
    });
    expect(parseAdoRemote("git@ssh.dev.azure.com:v3/org/Proj/repo-one")).toEqual({
      project: "proj",
      repo: "repo-one",
    });
    expect(
      parseAdoRemote("https://tfs.corp.local/tfs/Collection/Proj/_git/repo-one"),
    ).toEqual({ project: "proj", repo: "repo-one" });
  });

  it("is null for a remote that isn't ADO", () => {
    expect(parseAdoRemote("git@github.com:acme/repo-one.git")).toBeNull();
  });
});

describe("matchAdoRepo", () => {
  const ORG = [
    adoRepo("repo-one", "Alpha", "https://dev.azure.com/org/Alpha/_git/repo-one"),
    adoRepo("repo-two", "Beta", "https://dev.azure.com/org/Beta/_git/repo-two"),
    adoRepo("shared", "Alpha", "https://dev.azure.com/org/Alpha/_git/shared"),
    adoRepo("shared", "Beta", "https://dev.azure.com/org/Beta/_git/shared"),
  ];

  it("matches the exact clone URL even when git records the userinfo form", () => {
    const hit = matchAdoRepo(
      {
        remoteUrl: "https://org@dev.azure.com/org/Beta/_git/repo-two.git",
        basename: "checkout-folder",
      },
      ORG,
    );
    expect(hit?.id).toBe("guid-repo-two-Beta");
  });

  it("matches an SSH remote by project + repo, which never string-matches", () => {
    const hit = matchAdoRepo(
      { remoteUrl: "git@ssh.dev.azure.com:v3/org/Beta/shared", basename: "shared" },
      ORG,
    );
    expect(hit?.id).toBe("guid-shared-Beta");
  });

  it("falls back to the folder name when there is no remote", () => {
    const hit = matchAdoRepo({ remoteUrl: null, basename: "Repo-One" }, ORG);
    expect(hit?.id).toBe("guid-repo-one-Alpha");
  });

  it("refuses a name that several projects use — the project would be a guess", () => {
    expect(matchAdoRepo({ remoteUrl: null, basename: "shared" }, ORG)).toBeNull();
  });

  it("leaves a non-ADO remote with no name match unbound", () => {
    expect(
      matchAdoRepo(
        { remoteUrl: "git@github.com:acme/unrelated.git", basename: "unrelated" },
        ORG,
      ),
    ).toBeNull();
  });

  it("refuses a remote that names an ADO repo we can't see, rather than guessing by name", () => {
    // The PAT can't read project Gamma. The remote says outright which repo
    // this is; binding it to Alpha's same-named one produces a deep link that
    // resolves to a real page showing an unrelated repository's file, so
    // nothing 404s to signal the mistake.
    expect(
      matchAdoRepo(
        {
          remoteUrl: "https://dev.azure.com/org/Gamma/_git/repo-one",
          basename: "repo-one",
        },
        ORG,
      ),
    ).toBeNull();
  });
});

describe("bindRepo", () => {
  const ORG = [
    adoRepo("repo-one", "Alpha", "https://dev.azure.com/org/Alpha/_git/repo-one"),
  ];

  it("writes the ADO repo id, name and OWNING project", async () => {
    remotes({ "C:\\src\\one": "https://dev.azure.com/org/Alpha/_git/repo-one" });
    const out = await bindRepo(repo("one", "C:\\src\\one"), ORG);
    expect(out).toEqual({
      status: "bound",
      ado: { repoId: "guid-repo-one-Alpha", repoName: "repo-one", project: "Alpha" },
    });
    expect(setRepoAdo).toHaveBeenCalledWith("id-one", {
      repoId: "guid-repo-one-Alpha",
      repoName: "repo-one",
      project: "Alpha",
    });
  });

  it("writes nothing when nothing matches", async () => {
    remotes({ "C:\\src\\other": "git@github.com:acme/other.git" });
    expect(await bindRepo(repo("other", "C:\\src\\other"), ORG)).toEqual({
      status: "no-match",
    });
    expect(setRepoAdo).not.toHaveBeenCalled();
  });

  it("still binds by folder name when the root isn't a git repo at all", async () => {
    invoke.mockImplementation(async () => {
      throw "not a repo";
    });
    const out = await bindRepo(repo("repo-one", "C:\\src\\repo-one"), ORG);
    expect(out.status).toBe("bound");
  });

  it("reports an unreachable ADO instead of claiming no match", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ado_list_repos") throw { kind: "not-configured" };
      throw new Error(`unexpected command ${cmd}`);
    });
    const out = await bindRepo(repo("one", "C:\\src\\one"));
    expect(out).toEqual({
      status: "unavailable",
      message: "Connect Azure DevOps to link repos.",
    });
    expect(setRepoAdo).not.toHaveBeenCalled();
  });

  it("skips a repo whose ADO entry has no resolvable project", async () => {
    remotes({ "C:\\src\\one": null });
    const out = await bindRepo(repo("one", "C:\\src\\one"), [
      adoRepo("one", null, null),
    ]);
    expect(out).toEqual({ status: "no-match" });
  });
});

describe("autoBindRepos", () => {
  it("binds only the unbound repos, with one org-wide fetch", async () => {
    const listed: string[] = [];
    invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
      if (cmd === "ado_list_repos") {
        listed.push("fetch");
        return [
          {
            id: "guid-a",
            name: "repo-one",
            project: "Alpha",
            remoteUrl: "https://dev.azure.com/org/Alpha/_git/repo-one",
          },
          {
            id: "guid-b",
            name: "repo-two",
            project: "Beta",
            remoteUrl: "https://dev.azure.com/org/Beta/_git/repo-two",
          },
        ];
      }
      if (cmd === "git_remote_url") {
        return args.path === "C:\\src\\two"
          ? "https://dev.azure.com/org/Beta/_git/repo-two"
          : "https://dev.azure.com/org/Alpha/_git/repo-one";
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    // The bound repo would match repo-one perfectly — the only thing keeping it
    // out of the sweep is that it is already bound.
    await autoBindRepos([
      repo("already", "C:\\src\\already", {
        repoId: "kept",
        repoName: "kept",
        project: "Kept",
      }),
      repo("two", "C:\\src\\two"),
    ]);

    expect(listed).toHaveLength(1);
    expect(setRepoAdo).toHaveBeenCalledTimes(1);
    expect(setRepoAdo).toHaveBeenCalledWith("id-two", {
      repoId: "guid-b",
      repoName: "repo-two",
      project: "Beta",
    });
  });

  it("never touches ADO when every repo is already bound", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      throw new Error(`unexpected command ${cmd}`);
    });
    await autoBindRepos([
      repo("a", "C:\\src\\a", { repoId: "x", repoName: "x", project: "P" }),
    ]);
    // Not just "wrote nothing" — an org-wide REST call per settings visit is
    // the cost this skip exists to avoid.
    expect(invoke).not.toHaveBeenCalled();
    expect(setRepoAdo).not.toHaveBeenCalled();
  });

  it("is silent when ADO can't be reached", async () => {
    invoke.mockImplementation(async () => {
      throw { kind: "not-configured" };
    });
    await expect(autoBindRepos([repo("a", "C:\\src\\a")])).resolves.toBeUndefined();
    expect(setRepoAdo).not.toHaveBeenCalled();
  });
});
