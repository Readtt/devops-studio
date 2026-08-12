import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationSessionStore } from "./useGenerationSession";
import type { ReviewedBug, ReviewedCase } from "../lib/draftBatchSchema";
import { parseSourceLinks } from "@/modules/test-plans/lib/sourceLinksParser";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRepo } from "@/modules/settings/store";

const BRANCH = "feature/2fa";
const SHA = "9f3c1ab";

const mockRepoInfo: { branch: string | null; commit: string | null } = {
  branch: BRANCH,
  commit: SHA,
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "git_repo_info" ? mockRepoInfo : undefined,
  ),
}));

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

function mkBug(): ReviewedBug {
  return {
    uid: "b0",
    decision: "keep",
    title: "A bug with a sufficiently long title",
    reproSteps: "x",
    severity: "2 - High",
    linkedDraftCaseIndex: 0,
    codeRefs: [{ file: "src/auth/login.cs", startLine: 12 }],
  } as unknown as ReviewedBug;
}

/** Publish one case + one bug and hand back what actually reached ADO. */
async function publish(
  tagSourceBranch: boolean,
  sourceLinks?: Record<string, unknown>[],
) {
  const store = createGenerationSessionStore();
  store.setState({
    phase: "review",
    cases: [mkCase(sourceLinks)],
    bugs: [mkBug()],
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

describe("publish stamps source provenance", () => {
  beforeEach(() => {
    createCaseInSuite.mockClear().mockResolvedValue({ id: 999, url: "" });
    createBugAndLink.mockClear().mockResolvedValue({ id: 1000, url: "" });
    usePreferencesStore.setState({ repos: [createRepo("C:/src/repo-one")] });
    mockRepoInfo.branch = BRANCH;
    mockRepoInfo.commit = SHA;
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
    createCaseInSuite.mockClear().mockResolvedValue({ id: 999, url: "" });
    createBugAndLink.mockClear().mockResolvedValue({ id: 1000, url: "" });
    usePreferencesStore.setState({
      repos: [createRepo("C:/src/repo-one"), createRepo("C:/src/repo-two")],
    });
    mockRepoInfo.branch = BRANCH;
    mockRepoInfo.commit = SHA;
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
