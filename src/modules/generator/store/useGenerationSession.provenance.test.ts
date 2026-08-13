import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationSessionStore } from "./useGenerationSession";
import type { ReviewedBug, ReviewedCase } from "../lib/draftBatchSchema";
import { parseSourceLinks } from "@/modules/test-plans/lib/sourceLinksParser";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRepo, type WorkspaceRepo } from "@/modules/settings/store";

const BRANCH = "feature/2fa";
const SHA = "9f3c1ab";

const mockRepoInfo: { branch: string | null; commit: string | null } = {
  branch: BRANCH,
  commit: SHA,
};
/** HEAD per repo root. Repos move independently, so a batch spanning them has
 *  to be able to see different answers; anything unlisted falls back to the
 *  single-repo default above. */
const heads = new Map<string, { branch: string | null; commit: string | null }>();
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

function gitRepoInfoPaths(): string[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "git_repo_info")
    .map((c) => (c[1] as { path: string }).path);
}

const createCaseInSuite = vi.fn();
const createBugAndLink = vi.fn();
vi.mock("@/modules/ado", async () => {
  const actual =
    await vi.importActual<typeof import("@/modules/ado")>("@/modules/ado");
  return {
    ...actual,
    getConnection: async () => ({
      orgUrl: "https://dev.azure.com/contoso",
      project: "P",
    }),
    createCaseInSuite: (...args: unknown[]) => createCaseInSuite(...args),
    createBugAndLink: (...args: unknown[]) => createBugAndLink(...args),
  };
});

function mkCase(
  sourceLinks: Record<string, unknown>[] = [
    { repoName: "repo-one", filePath: "src/auth/login.cs" },
  ],
): ReviewedCase {
  return {
    uid: "c0",
    decision: "keep",
    similarMatches: [],
    title: "Case c0",
    description: "Body.",
    steps: [],
    sourceLinks,
  } as unknown as ReviewedCase;
}

function mkBug(
  codeRefs: Record<string, unknown>[] = [
    { file: "src/auth/login.cs", startLine: 12 },
  ],
): ReviewedBug {
  return {
    uid: "b0",
    decision: "keep",
    title: "A bug with a sufficiently long title",
    reproSteps: "x",
    severity: "2 - High",
    linkedDraftCaseIndex: 0,
    codeRefs,
  } as unknown as ReviewedBug;
}

/** Publish one case + one bug and hand back what actually reached ADO. */
async function publish(
  tagSourceBranch: boolean,
  sourceLinks?: Record<string, unknown>[],
  codeRefs?: Record<string, unknown>[],
) {
  const store = createGenerationSessionStore();
  store.setState({
    phase: "review",
    cases: [mkCase(sourceLinks)],
    bugs: [mkBug(codeRefs)],
    planId: 1,
    suiteId: 2,
    targetSuiteType: "staticTestSuite",
    tagSourceBranch,
  });

  await store.getState().publish();

  const draft = createCaseInSuite.mock.calls[0]?.[2] as {
    sourceLinksBlock: string | null;
  };
  const bug = createBugAndLink.mock.calls[0]?.[1] as {
    codeLinks: { commitSha: string | null }[];
  };
  return {
    block: draft?.sourceLinksBlock ?? null,
    link: parseSourceLinks(draft?.sourceLinksBlock ?? "")[0],
    bugCommitSha: bug?.codeLinks[0]?.commitSha ?? null,
  };
}

/** Reset the ADO + git doubles. Every describe below starts from here; only the
 *  repo registry differs. */
function resetDoubles() {
  createCaseInSuite.mockClear().mockResolvedValue({ id: 999, url: "" });
  createBugAndLink.mockClear().mockResolvedValue({ id: 1000, url: "" });
  heads.clear();
  mockRepoInfo.branch = BRANCH;
  mockRepoInfo.commit = SHA;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
    if (cmd !== "git_repo_info") return undefined;
    const head = args?.path ? heads.get(args.path) : undefined;
    return head ?? mockRepoInfo;
  });
}

describe("publish stamps source provenance", () => {
  beforeEach(() => {
    resetDoubles();
    usePreferencesStore.setState({ repos: [createRepo("C:/src/repo-one")] });
  });

  it("records the branch AND the commit the cases were generated from", async () => {
    // The sha was hardcoded empty for the whole life of the feature, so every
    // published case claimed a branch but no commit to anchor it to.
    const { link, bugCommitSha } = await publish(true);
    expect(link.trackingBranch).toBe(BRANCH);
    expect(link.generationSha).toBe(SHA);
    expect(bugCommitSha).toBe(SHA);
  });

  it("stamps nothing at all when the user opts out", async () => {
    const { link, bugCommitSha } = await publish(false);
    // The link itself must survive — only the provenance goes.
    expect(link.filePath).toBe("src/auth/login.cs");
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe("");
    expect(bugCommitSha).toBeNull();
  });

  it("on a detached HEAD stamps the commit but never invents a branch", async () => {
    // The one state where the two stamps read different things off the same
    // probe: git gives a commit but no branch. The commit is true and useful,
    // so it's still recorded; the branch is unknown, and "main" would be a
    // guess about code the user never generated from.
    mockRepoInfo.branch = null;

    const { link, bugCommitSha } = await publish(true);
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe(SHA);
    expect(bugCommitSha).toBe(SHA);
  });

  it("stamps nothing when the source dir isn't a git repo", async () => {
    mockRepoInfo.branch = null;
    mockRepoInfo.commit = null;

    const { link, bugCommitSha } = await publish(true);
    expect(link.filePath).toBe("src/auth/login.cs");
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe("");
    expect(bugCommitSha).toBeNull();
  });
});

// The prompts stopped asking for a repo name, so the path's `<repo>/…` prefix
// is the only thing left that says which repo a published link belongs to.
describe("publish binds each link to the repo its path names", () => {
  beforeEach(() => {
    resetDoubles();
    usePreferencesStore.setState({
      repos: [createRepo("C:/src/repo-one"), createRepo("C:/src/repo-two")],
    });
  });

  it("reads the repo off the prefix when the model sent no repoName", async () => {
    const { link } = await publish(true, [
      { filePath: "repo-two/src/api/handler.ts" },
    ]);
    expect(link.repoName).toBe("repo-two");
    expect(link.repoId).toBe("repo-two");
  });

  it("prefers the prefix over a repoName carried by an older draft", async () => {
    const { link } = await publish(true, [
      { repoName: "MyApp", filePath: "repo-two/src/api/handler.ts" },
    ]);
    expect(link.repoName).toBe("repo-two");
  });

  // `parseSourceLinks` requires a repo, so a blank one is a line the app can
  // never read back — a dead link in the user's ADO description. Dropping it is
  // the honest outcome for a path that names no repo we know of.
  it("drops a link no configured repo can claim", async () => {
    const { block } = await publish(true, [
      { filePath: "src/auth/login.cs" },
      { filePath: "repo-one/src/auth/login.cs" },
    ]);
    // Asserted against the rendered block, not against what parses back out of
    // it: the parser already skips a repo-less line, so a blank one would still
    // read as "one link" while sitting in the user's description forever.
    expect(block?.match(/^- /gm)).toHaveLength(1);
    expect(block).toContain("repo: repo-one");
    expect(parseSourceLinks(block ?? "")[0].filePath).toBe(
      "repo-one/src/auth/login.cs",
    );
  });

  it("emits no block at all when every link is unclaimable", async () => {
    const { block } = await publish(true, [{ filePath: "src/auth/login.cs" }]);
    expect(block).toBeNull();
  });
});

// A published link is a deep link into ADO Repos, which resolves on the ADO
// repo NAME inside its OWN project — neither of which the workspace folder name
// or the connection's project can be trusted to supply.
describe("publish records the ADO repo a link belongs to", () => {
  const bound = (root: string, name: string, ado: NonNullable<WorkspaceRepo["ado"]>) => ({
    ...createRepo(root),
    name,
    ado,
  });

  beforeEach(() => {
    resetDoubles();
  });

  it("publishes the bound repo's ADO name, project and id", async () => {
    usePreferencesStore.setState({
      repos: [
        bound("C:/src/repo-one", "repo-one", {
          repoId: "guid-one",
          repoName: "Contoso.Api",
          project: "Payments",
        }),
      ],
    });

    const { link } = await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
    ]);
    expect(link.repoName).toBe("Contoso.Api");
    expect(link.project).toBe("Payments");
    expect(link.repoId).toBe("guid-one");
  });

  it("gives each repo its own project when a case spans two", async () => {
    usePreferencesStore.setState({
      repos: [
        bound("C:/src/repo-one", "repo-one", {
          repoId: "guid-one",
          repoName: "Contoso.Api",
          project: "Payments",
        }),
        bound("C:/src/repo-two", "repo-two", {
          repoId: "guid-two",
          repoName: "Contoso.Web",
          project: "Storefront",
        }),
      ],
    });

    const { block } = await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
      { filePath: "repo-two/src/app.ts" },
    ]);
    const links = parseSourceLinks(block ?? "");
    expect(links.map((l) => [l.repoName, l.project])).toEqual([
      ["Contoso.Api", "Payments"],
      ["Contoso.Web", "Storefront"],
    ]);
  });

  it("falls back to the workspace name and no project when unbound", async () => {
    usePreferencesStore.setState({ repos: [createRepo("C:/src/repo-one")] });

    const { link } = await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
    ]);
    expect(link.repoName).toBe("repo-one");
    expect(link.project).toBeUndefined();
  });
});

// Repos move independently: one can sit on a feature branch while another is on
// main, three commits behind. A batch that cites both has to record what each
// link was actually read from, or half its links point at code that never
// existed in that state.
describe("publish stamps every link with its OWN repo's HEAD", () => {
  const ONE_ROOT = "C:/src/repo-one";
  const TWO_ROOT = "C:/src/repo-two";
  const THREE_ROOT = "C:/src/repo-three";

  beforeEach(() => {
    resetDoubles();
    usePreferencesStore.setState({
      repos: [
        createRepo(ONE_ROOT),
        createRepo(TWO_ROOT),
        createRepo(THREE_ROOT),
      ],
    });
    heads.set(ONE_ROOT, { branch: "feature/2fa", commit: "aaa1111" });
    heads.set(TWO_ROOT, { branch: "main", commit: "bbb2222" });
    heads.set(THREE_ROOT, { branch: "release/9", commit: "ccc3333" });
  });

  it("gives each link in one case the branch and sha of the repo it names", async () => {
    const { block } = await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
      { filePath: "repo-two/src/api/handler.ts" },
    ]);
    const links = parseSourceLinks(block ?? "");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      repoName: "repo-one",
      trackingBranch: "feature/2fa",
      generationSha: "aaa1111",
    });
    expect(links[1]).toMatchObject({
      repoName: "repo-two",
      trackingBranch: "main",
      generationSha: "bbb2222",
    });
  });

  it("anchors a bug's code refs to the commit of the repo each ref names", async () => {
    await publish(true, [{ filePath: "repo-one/src/auth/login.cs" }], [
      { file: "repo-two/src/api/handler.ts", startLine: 4 },
      { file: "repo-three/src/lib/util.ts", startLine: 9 },
    ]);
    const { codeLinks } = createBugAndLink.mock.calls[0][1] as {
      codeLinks: { file: string; commitSha: string | null }[];
    };
    expect(codeLinks[0].commitSha).toBe("bbb2222");
    expect(codeLinks[1].commitSha).toBe("ccc3333");
  });

  it("probes only the repos the batch actually names, once each", async () => {
    // A git probe is a subprocess spawn. Publishing three cases that all cite
    // repo-one must cost one, and the two repos nobody linked to must cost none.
    await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
      { filePath: "repo-one/src/auth/session.cs" },
    ]);
    expect(gitRepoInfoPaths()).toEqual([ONE_ROOT]);
  });

  it("keeps a repo whose probe fails from costing the others their stamp", async () => {
    // A root that moved or unmounted is still in the registry. Its links lose
    // their provenance; the repos that answered keep theirs.
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd !== "git_repo_info") return undefined;
      if (args?.path === ONE_ROOT) throw new Error("not a directory");
      return heads.get(args?.path ?? "") ?? mockRepoInfo;
    });

    const { block } = await publish(true, [
      { filePath: "repo-one/src/auth/login.cs" },
      { filePath: "repo-two/src/api/handler.ts" },
    ]);
    const links = parseSourceLinks(block ?? "");
    expect(links[0].trackingBranch).toBe("");
    expect(links[0].generationSha).toBe("");
    expect(links[1].trackingBranch).toBe("main");
    expect(links[1].generationSha).toBe("bbb2222");
  });

  it("spawns no git at all when the user opted out of tagging", async () => {
    await publish(false, [
      { filePath: "repo-one/src/auth/login.cs" },
      { filePath: "repo-two/src/api/handler.ts" },
    ]);
    expect(gitRepoInfoPaths()).toEqual([]);
  });

  it("resolves a legacy draft's repoName to that repo's HEAD, not the first repo's", async () => {
    // Drafts generated before the prompts dropped `repoName` carry an
    // unprefixed path plus the name. Stamping repos[0]'s branch on those would
    // be a guess dressed up as provenance.
    const { block } = await publish(true, [
      { repoName: "repo-three", filePath: "src/lib/util.ts" },
    ]);
    const link = parseSourceLinks(block ?? "")[0];
    expect(link.repoName).toBe("repo-three");
    expect(link.trackingBranch).toBe("release/9");
    expect(link.generationSha).toBe("ccc3333");
  });
});
