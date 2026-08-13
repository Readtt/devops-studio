import { describe, it, expect, vi, beforeEach } from "vitest";

const streamSuiteChatTask = vi.fn();
const listSuiteCases = vi.fn();

vi.mock("@/modules/ado", () => ({
  listSuiteCases: (...a: unknown[]) => listSuiteCases(...a),
  listSuites: vi.fn(async () => []),
  getBug: vi.fn(),
  getCase: vi.fn(async (id: number) => testCase(id)),
  isRequirementSuite: () => false,
  toTargetRequirement: (x: unknown) => x,
  toAdoError: (e: unknown) => ({ message: String(e) }),
  adoErrorMessage: (e: { message: string }) => e.message,
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      selectedModelId: "claude-opus-5",
      ensureApiKeys: async () => ({}),
    }),
  },
}));
vi.mock("@/modules/ai/lib/bestPractices", () => ({
  loadBestPracticeBlocks: async () => ({ blocks: [] }),
}));
vi.mock("@/modules/ado/lib/bugContextBlock", () => ({
  bugsToContextBlocks: () => [],
}));
vi.mock("../lib/confidenceApi", () => ({
  getConfidenceMany: async () => new Map(),
}));
vi.mock("../lib/chatThreadsApi", () => ({
  DEFAULT_THREAD_ID: "default",
  deleteChatThread: vi.fn(async () => {}),
  // `ensure` hydrates the thread through a dynamic import of this module.
  getChatThread: vi.fn(async () => null),
  listChatThreadsForSuite: vi.fn(async () => []),
  newThreadId: () => "t2",
  saveChatThread: vi.fn(async () => {}),
}));
vi.mock("../lib/runSuiteChat", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/runSuiteChat")
  >("../lib/runSuiteChat");
  return {
    ...actual,
    streamSuiteChatTask: (...a: unknown[]) => streamSuiteChatTask(...a),
  };
});

import { useSuiteChat } from "./useSuiteChat";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRepo, type WorkspaceRepo } from "@/modules/settings/store";

/** Enough of an ADO TestCase for the prompt builders the send path runs. */
function testCase(id: number) {
  return {
    id,
    title: `case ${id}`,
    steps: [],
    tags: [],
    linkedWorkItems: [],
  } as never;
}

const PLAN = 1;
const SUITE = 2;
const KEY = `${PLAN}:${SUITE}`;

const one = createRepo("C:/repo-one");
const two = createRepo("C:/repo-two");
const three = createRepo("C:/repo-three");

/** Repos the runner was actually handed on the last send. */
function sentRepos(): WorkspaceRepo[] {
  const calls = streamSuiteChatTask.mock.calls;
  return (calls[calls.length - 1][0] as { repos: WorkspaceRepo[] }).repos;
}

function scope(): string[] | null {
  return useSuiteChat.getState().bySuite.get(KEY)?.repoScope ?? null;
}

async function seedSuite() {
  useSuiteChat.getState().ensure(PLAN, SUITE);
  const slice = useSuiteChat.getState().bySuite.get(KEY)!;
  useSuiteChat.setState((s) => ({
    bySuite: new Map(s.bySuite).set(KEY, {
      ...slice,
      cases: [testCase(10)],
    }),
  }));
}

beforeEach(async () => {
  streamSuiteChatTask.mockReset();
  streamSuiteChatTask.mockResolvedValue({ text: "ok", durationMs: 1 });
  listSuiteCases.mockReset();
  listSuiteCases.mockResolvedValue([{ id: 10, title: "case 10" }]);
  useSuiteChat.setState({
    bySuite: new Map(),
    byThread: new Map(),
    threadListBySuite: new Map(),
    activeThreadBySuite: new Map(),
  });
  usePreferencesStore.setState({
    repos: [one, two, three],
    codeSearchEnabled: true,
    bestPracticeFiles: [],
  });
  await seedSuite();
});

describe("suite chat repo scope", () => {
  it("reads every configured repo by default", async () => {
    await useSuiteChat.getState().sendMessage(PLAN, SUITE, "hi");
    expect(sentRepos().map((r) => r.name)).toEqual([
      one.name,
      two.name,
      three.name,
    ]);
  });

  it("sends only the repos left in scope", async () => {
    useSuiteChat.getState().toggleRepo(PLAN, SUITE, two.id);
    expect(scope()).toEqual([one.id, three.id]);
    await useSuiteChat.getState().sendMessage(PLAN, SUITE, "hi");
    expect(sentRepos().map((r) => r.name)).toEqual([one.name, three.name]);
  });

  it("collapses back to null (all repos) when everything is re-selected", () => {
    const s = useSuiteChat.getState();
    s.toggleRepo(PLAN, SUITE, two.id);
    expect(scope()).not.toBeNull();
    s.toggleRepo(PLAN, SUITE, two.id);
    // Null, not [one, two, three] — a frozen list would silently exclude a
    // repo added in Settings later.
    expect(scope()).toBeNull();
  });

  it("sends no repos at all when every chip is deselected", async () => {
    const s = useSuiteChat.getState();
    for (const r of [one, two, three]) s.toggleRepo(PLAN, SUITE, r.id);
    expect(scope()).toEqual([]);
    await useSuiteChat.getState().sendMessage(PLAN, SUITE, "hi");
    expect(sentRepos()).toEqual([]);
  });

  it("reads nothing with code search off, whatever the scope says", async () => {
    usePreferencesStore.setState({ codeSearchEnabled: false });
    await useSuiteChat.getState().sendMessage(PLAN, SUITE, "hi");
    expect(sentRepos()).toEqual([]);
  });

  it("keeps the scope per suite", async () => {
    const other = `${PLAN}:99`;
    useSuiteChat.getState().ensure(PLAN, 99);
    useSuiteChat.getState().toggleRepo(PLAN, SUITE, one.id);
    expect(useSuiteChat.getState().bySuite.get(other)?.repoScope ?? null).toBeNull();
    expect(scope()).toEqual([two.id, three.id]);
  });
});
