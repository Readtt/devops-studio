import { describe, expect, it } from "vitest";
import {
  computeLeafRects,
  dropLeaf,
  findLeaf,
  findLeafByTab,
  findParent,
  focusDirectional,
  insertTabIntoLeaf,
  makeLeaf,
  makeSplit,
  moveTabToLeaf,
  normalize,
  removeTab,
  reorderInLeaf,
  setLeafActive,
  setSplitSizes,
  splitLeaf,
  walkLeaves,
} from "./paneTreeOps";

const leaf = (id: string, tabIds: number[] = [], active: number | null = null) =>
  makeLeaf({ id, tabIds, activeTabId: active });

describe("walkLeaves", () => {
  it("emits leaves left-to-right depth-first", () => {
    const tree = makeSplit("horizontal", [
      leaf("A"),
      makeSplit("vertical", [leaf("B"), leaf("C")]),
      leaf("D"),
    ]);
    const order = walkLeaves(tree).map((l) => l.id);
    expect(order).toEqual(["A", "B", "C", "D"]);
  });
});

describe("findLeaf / findLeafByTab", () => {
  it("locates leaves by id", () => {
    const tree = makeSplit("horizontal", [leaf("A", [1]), leaf("B", [2, 3])]);
    expect(findLeaf(tree, "B")?.id).toBe("B");
    expect(findLeaf(tree, "Z")).toBeNull();
  });
  it("locates leaves by tab id", () => {
    const tree = makeSplit("horizontal", [leaf("A", [1]), leaf("B", [2, 3])]);
    expect(findLeafByTab(tree, 3)?.id).toBe("B");
    expect(findLeafByTab(tree, 99)).toBeNull();
  });
});

describe("findParent", () => {
  it("returns null for root leaf", () => {
    const root = leaf("root");
    expect(findParent(root, "root")).toEqual([null, -1]);
  });
  it("locates the immediate parent split", () => {
    const inner = leaf("inner");
    const tree = makeSplit("horizontal", [leaf("a"), inner]);
    const [parent, idx] = findParent(tree, "inner");
    expect(parent?.id).toBe(tree.id);
    expect(idx).toBe(1);
  });
});

describe("insertTabIntoLeaf", () => {
  it("appends and activates by default", () => {
    const tree = leaf("root", []);
    const next = insertTabIntoLeaf(tree, "root", 42);
    const l = findLeaf(next, "root")!;
    expect(l.tabIds).toEqual([42]);
    expect(l.activeTabId).toBe(42);
  });
  it("inserts at clamped index", () => {
    const tree = leaf("root", [1, 2, 3], 2);
    const next = insertTabIntoLeaf(tree, "root", 99, 1);
    expect(findLeaf(next, "root")!.tabIds).toEqual([1, 99, 2, 3]);
  });
  it("moves a tab that already exists in the leaf", () => {
    const tree = leaf("root", [1, 2, 3], 1);
    const next = insertTabIntoLeaf(tree, "root", 1, 3);
    // From idx 0 to idx 3 (clamped to 2 after removal of itself).
    expect(findLeaf(next, "root")!.tabIds).toEqual([2, 3, 1]);
  });
});

describe("reorderInLeaf", () => {
  it("moves a tab forward", () => {
    const tree = leaf("root", [1, 2, 3, 4], 1);
    const next = reorderInLeaf(tree, "root", 0, 2);
    expect(findLeaf(next, "root")!.tabIds).toEqual([2, 3, 1, 4]);
  });
  it("is a no-op if fromIdx === toIdx", () => {
    const tree = leaf("root", [1, 2, 3]);
    expect(reorderInLeaf(tree, "root", 1, 1)).toBe(tree);
  });
});

describe("removeTab", () => {
  it("removes and re-actives a neighbor", () => {
    const tree = leaf("root", [1, 2, 3], 2);
    const next = removeTab(tree, 2);
    const l = findLeaf(next, "root")!;
    expect(l.tabIds).toEqual([1, 3]);
    expect(l.activeTabId).toBe(1);
  });
  it("collapses an empty leaf when a sibling exists", () => {
    const tree = makeSplit("horizontal", [leaf("A", [1]), leaf("B", [2])]);
    const next = removeTab(tree, 1);
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe("B");
  });
  it("keeps an empty root leaf alive (empty-state anchor)", () => {
    const tree = leaf("root", [1], 1);
    const next = removeTab(tree, 1);
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe("root");
    expect((next as { tabIds: number[] }).tabIds).toEqual([]);
  });
});

describe("splitLeaf", () => {
  it("wraps a leaf in a new split, placing tab in new sibling", () => {
    const tree = leaf("root", [1, 2, 3], 2);
    const { tree: next, newLeafId } = splitLeaf(
      tree,
      "root",
      "horizontal",
      "after",
      2,
    );
    expect(next.kind).toBe("split");
    const leaves = walkLeaves(next);
    expect(leaves).toHaveLength(2);
    const [orig, newSibling] = leaves;
    expect(orig.tabIds).toEqual([1, 3]);
    expect(newSibling.tabIds).toEqual([2]);
    expect(newSibling.id).toBe(newLeafId);
  });
  it("flattens same-direction splits instead of nesting deeper", () => {
    const tree = leaf("A", [1, 2], 2);
    const r1 = splitLeaf(tree, "A", "horizontal", "after", 2);
    // r1 is split[A:[1], new:[2]]; splitting A again "after" should produce
    // a 3-leaf horizontal split, not nested.
    const r2 = splitLeaf(r1.tree, "A", "horizontal", "after");
    expect(r2.tree.kind).toBe("split");
    expect((r2.tree as { children: unknown[] }).children).toHaveLength(3);
  });
});

describe("moveTabToLeaf", () => {
  it("moves a tab across leaves", () => {
    const tree = makeSplit("horizontal", [
      leaf("A", [1, 2], 2),
      leaf("B", [3], 3),
    ]);
    const next = moveTabToLeaf(tree, 2, "B", 0);
    expect(findLeaf(next, "A")!.tabIds).toEqual([1]);
    expect(findLeaf(next, "B")!.tabIds).toEqual([2, 3]);
    expect(findLeaf(next, "B")!.activeTabId).toBe(2);
  });
  it("collapses source if it becomes empty", () => {
    const tree = makeSplit("horizontal", [leaf("A", [1], 1), leaf("B", [2])]);
    const next = moveTabToLeaf(tree, 1, "B");
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe("B");
    expect((next as { tabIds: number[] }).tabIds).toEqual([2, 1]);
  });
});

describe("normalize", () => {
  it("collapses 1-child splits", () => {
    const inner = leaf("inner", [1]);
    const tree = makeSplit("horizontal", [inner]);
    expect(normalize(tree).id).toBe("inner");
  });
  it("flattens same-orientation nested splits", () => {
    const tree = makeSplit("horizontal", [
      leaf("A"),
      makeSplit("horizontal", [leaf("B"), leaf("C")]),
    ]);
    const next = normalize(tree);
    expect(next.kind).toBe("split");
    const ids = walkLeaves(next).map((l) => l.id);
    expect(ids).toEqual(["A", "B", "C"]);
  });
  it("preserves orthogonal nesting", () => {
    const tree = makeSplit("horizontal", [
      leaf("A"),
      makeSplit("vertical", [leaf("B"), leaf("C")]),
    ]);
    const next = normalize(tree);
    expect(next.kind).toBe("split");
    const split = next as { children: { kind: string }[] };
    expect(split.children[1].kind).toBe("split");
  });
});

describe("dropLeaf", () => {
  it("hoists the surviving sibling out of the parent split", () => {
    const tree = makeSplit("horizontal", [leaf("A", [1]), leaf("B", [2])]);
    const next = dropLeaf(tree, "A");
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe("B");
  });
  it("empties root leaf rather than dropping it", () => {
    const tree = leaf("root", [1, 2], 1);
    const next = dropLeaf(tree, "root");
    expect(next.kind).toBe("leaf");
    expect((next as { tabIds: number[] }).tabIds).toEqual([]);
  });
});

describe("setLeafActive", () => {
  it("sets the active tab if it lives in the leaf", () => {
    const tree = leaf("root", [1, 2, 3], 1);
    const next = setLeafActive(tree, "root", 3);
    expect(findLeaf(next, "root")!.activeTabId).toBe(3);
  });
  it("is a no-op if the tab is not in the leaf", () => {
    const tree = leaf("root", [1, 2], 1);
    expect(setLeafActive(tree, "root", 99)).toBe(tree);
  });
});

describe("computeLeafRects + focusDirectional", () => {
  it("yields predictable rects for a horizontal split", () => {
    const tree = makeSplit("horizontal", [leaf("L"), leaf("R")]);
    const rects = computeLeafRects(tree);
    expect(rects.find((r) => r.id === "L")).toMatchObject({
      x: 0,
      y: 0,
      w: 50,
      h: 100,
    });
    expect(rects.find((r) => r.id === "R")).toMatchObject({
      x: 50,
      y: 0,
      w: 50,
      h: 100,
    });
  });
  it("finds the leaf to the right", () => {
    const tree = makeSplit("horizontal", [leaf("L"), leaf("R")]);
    expect(focusDirectional(tree, "L", "right")).toBe("R");
    expect(focusDirectional(tree, "R", "right")).toBeNull();
  });
  it("finds the leaf below", () => {
    const tree = makeSplit("vertical", [leaf("T"), leaf("B")]);
    expect(focusDirectional(tree, "T", "down")).toBe("B");
    expect(focusDirectional(tree, "T", "up")).toBeNull();
  });
  it("picks the closest leaf in a 2x2 grid", () => {
    // T-shaped layout: horizontal split → [L, right-vertical-split[TR, BR]]
    const tree = makeSplit("horizontal", [
      leaf("L"),
      makeSplit("vertical", [leaf("TR"), leaf("BR")]),
    ]);
    expect(focusDirectional(tree, "L", "right")).toBe("TR"); // TR is closer to center
    expect(focusDirectional(tree, "TR", "down")).toBe("BR");
    expect(focusDirectional(tree, "BR", "left")).toBe("L");
  });
});

describe("setSplitSizes", () => {
  it("updates only the matching split", () => {
    const tree = makeSplit(
      "horizontal",
      [leaf("A"), leaf("B")],
      [50, 50],
    );
    const next = setSplitSizes(tree, tree.id, [70, 30]);
    expect((next as { sizes: number[] }).sizes).toEqual([70, 30]);
  });
});

describe("round-trip: split → close → collapse", () => {
  it("returns to a single leaf when both halves close", () => {
    const tree = leaf("root", [1, 2], 2);
    // Split off tab 2 to a new pane.
    const { tree: split, newLeafId } = splitLeaf(
      tree,
      "root",
      "horizontal",
      "after",
      2,
    );
    expect(split.kind).toBe("split");
    // Close tab 2 — its leaf empties and collapses.
    const next = removeTab(split, 2);
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe("root");
    expect((next as { tabIds: number[] }).tabIds).toEqual([1]);
    // newLeafId no longer exists.
    expect(findLeaf(next, newLeafId)).toBeNull();
  });
});
