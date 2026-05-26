import { beforeEach, describe, expect, it } from "vitest";
import { useTabsStore, ROOT_LEAF_ID } from "./useTabsStore";
import type { LeafNode, TestCaseTab } from "./types";

function reset() {
  const rootLeaf: LeafNode = {
    kind: "leaf",
    id: ROOT_LEAF_ID,
    tabIds: [],
    activeTabId: null,
  };
  useTabsStore.setState({
    tabs: {},
    nextId: 1,
    paneTree: rootLeaf,
    focusedLeafId: ROOT_LEAF_ID,
    recentlyClosed: [],
  });
}

describe("duplicateTab", () => {
  beforeEach(reset);

  it("clones a test-case tab into a distinct second tab", () => {
    const id1 = useTabsStore
      .getState()
      .openTab({ kind: "test-case", caseId: 15310, title: "#15310", planId: 1, suiteId: 2 });
    const id2 = useTabsStore.getState().duplicateTab(id1);

    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id1);

    const { tabs, paneTree } = useTabsStore.getState();
    expect(Object.keys(tabs)).toHaveLength(2);

    const clone = tabs[id2!] as TestCaseTab;
    expect(clone.kind).toBe("test-case");
    expect(clone.caseId).toBe(15310);
    expect(clone.planId).toBe(1);
    expect(clone.suiteId).toBe(2);

    const leaf = paneTree as LeafNode;
    expect(leaf.tabIds).toContain(id1);
    expect(leaf.tabIds).toContain(id2);
    expect(leaf.activeTabId).toBe(id2);
  });

  it("clones a bug tab into a distinct second tab", () => {
    const id1 = useTabsStore
      .getState()
      .openTab({ kind: "bug", bugId: 42, title: "Bug #42" });
    const id2 = useTabsStore.getState().duplicateTab(id1);
    expect(id2).not.toBe(id1);
    expect(Object.keys(useTabsStore.getState().tabs)).toHaveLength(2);
  });
});
