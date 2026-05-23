import { genId } from "@/lib/id";
import type { LeafNode, PaneNode, SplitNode } from "./types";

export function makeLeaf(opts?: Partial<LeafNode>): LeafNode {
  return {
    kind: "leaf",
    id: opts?.id ?? genId(),
    tabIds: opts?.tabIds ?? [],
    activeTabId: opts?.activeTabId ?? null,
  };
}

export function makeSplit(
  direction: SplitNode["direction"],
  children: PaneNode[],
  sizes?: number[],
): SplitNode {
  const n = children.length;
  const evenSizes =
    sizes && sizes.length === n
      ? sizes
      : Array.from({ length: n }, () => 100 / n);
  return {
    kind: "split",
    id: genId(),
    direction,
    sizes: evenSizes,
    children,
  };
}

/** Depth-first walk emitting every leaf in tree order (matches tab cycle). */
export function walkLeaves(root: PaneNode): LeafNode[] {
  const out: LeafNode[] = [];
  const stack: PaneNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === "leaf") {
      out.push(n);
    } else {
      // push in reverse so visit order is left-to-right
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  return out;
}

export function findLeaf(root: PaneNode, leafId: string): LeafNode | null {
  if (root.kind === "leaf") return root.id === leafId ? root : null;
  for (const child of root.children) {
    const hit = findLeaf(child, leafId);
    if (hit) return hit;
  }
  return null;
}

export function findLeafByTab(root: PaneNode, tabId: number): LeafNode | null {
  for (const leaf of walkLeaves(root)) {
    if (leaf.tabIds.includes(tabId)) return leaf;
  }
  return null;
}

/** Returns [parent, indexInParent] or [null, -1] if leaf is root. */
export function findParent(
  root: PaneNode,
  nodeId: string,
): [SplitNode | null, number] {
  if (root.kind === "leaf") return [null, -1];
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i].id === nodeId) return [root, i];
    const sub = findParent(root.children[i], nodeId);
    if (sub[0]) return sub;
  }
  return [null, -1];
}

/**
 * Pure tree replacement: returns a new tree where the node with `targetId`
 * is replaced by `replacement` (or removed entirely if `replacement` is
 * null and target is a split child). Used by all structural ops below.
 */
function replaceNode(
  root: PaneNode,
  targetId: string,
  replacement: PaneNode,
): PaneNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  const idx = root.children.findIndex((c) => c.id === targetId);
  if (idx >= 0) {
    const nextChildren = root.children.slice();
    nextChildren[idx] = replacement;
    return { ...root, children: nextChildren };
  }
  return {
    ...root,
    children: root.children.map((c) => replaceNode(c, targetId, replacement)),
  };
}

/**
 * Collapse 1-child splits and merge same-orientation splits upward.
 * Always returns a valid tree; never returns null (the root leaf is
 * the empty-state anchor).
 */
export function normalize(root: PaneNode): PaneNode {
  if (root.kind === "leaf") return root;
  // Recurse first.
  let children = root.children.map(normalize);
  // Flatten same-direction child splits.
  const flattened: PaneNode[] = [];
  const flattenedSizes: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const parentSize = root.sizes[i] ?? 100 / children.length;
    if (child.kind === "split" && child.direction === root.direction) {
      // Distribute parent's slot proportionally across grandchildren.
      const sub = child.children;
      const subSizesTotal = child.sizes.reduce((a, b) => a + b, 0) || 1;
      for (let j = 0; j < sub.length; j++) {
        flattened.push(sub[j]);
        flattenedSizes.push((child.sizes[j] / subSizesTotal) * parentSize);
      }
    } else {
      flattened.push(child);
      flattenedSizes.push(parentSize);
    }
  }
  children = flattened;
  let sizes = flattenedSizes;
  // Collapse single-child split → just the child.
  if (children.length === 1) {
    return children[0];
  }
  // Normalize sizes to sum to 100.
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  sizes = sizes.map((s) => (s / total) * 100);
  return { ...root, children, sizes };
}

/**
 * Insert `tabId` into `leafId` at `index` (clamped). Also marks it active
 * in that leaf. Pure — returns a new tree.
 */
export function insertTabIntoLeaf(
  root: PaneNode,
  leafId: string,
  tabId: number,
  index?: number,
): PaneNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return root;
  const insertAt =
    typeof index === "number"
      ? Math.max(0, Math.min(index, leaf.tabIds.length))
      : leaf.tabIds.length;
  // Don't double-insert.
  const existingIdx = leaf.tabIds.indexOf(tabId);
  let nextIds: number[];
  if (existingIdx >= 0) {
    nextIds = leaf.tabIds.slice();
    nextIds.splice(existingIdx, 1);
    const adjustedInsert = existingIdx < insertAt ? insertAt - 1 : insertAt;
    nextIds.splice(adjustedInsert, 0, tabId);
  } else {
    nextIds = leaf.tabIds.slice();
    nextIds.splice(insertAt, 0, tabId);
  }
  const nextLeaf: LeafNode = {
    ...leaf,
    tabIds: nextIds,
    activeTabId: tabId,
  };
  return replaceNode(root, leafId, nextLeaf);
}

/**
 * Remove `tabId` from whichever leaf currently holds it. If that empties
 * the leaf, the parent split collapses via `normalize`. Returns the new
 * tree (root leaf stays as the empty anchor if necessary).
 */
export function removeTab(root: PaneNode, tabId: number): PaneNode {
  const leaves = walkLeaves(root);
  const owner = leaves.find((l) => l.tabIds.includes(tabId));
  if (!owner) return root;
  const idx = owner.tabIds.indexOf(tabId);
  const nextIds = owner.tabIds.slice();
  nextIds.splice(idx, 1);

  let nextActive: number | null = owner.activeTabId;
  if (owner.activeTabId === tabId) {
    nextActive = nextIds[Math.max(0, idx - 1)] ?? nextIds[idx] ?? null;
  }

  const nextLeaf: LeafNode = {
    ...owner,
    tabIds: nextIds,
    activeTabId: nextActive,
  };

  // If the leaf is now empty AND it's not the only leaf, drop it entirely
  // so the sibling expands into the freed space.
  if (nextIds.length === 0 && leaves.length > 1) {
    return dropLeaf(root, owner.id);
  }

  return replaceNode(root, owner.id, nextLeaf);
}

/**
 * Drop a leaf from the tree entirely. The parent split simplifies via
 * `normalize`. If the leaf has no parent (it IS the root), returns the
 * leaf with cleared tabs — root always survives.
 */
export function dropLeaf(root: PaneNode, leafId: string): PaneNode {
  const [parent, idx] = findParent(root, leafId);
  if (!parent) {
    // Root leaf — keep it but empty it.
    return makeLeaf({ id: leafId });
  }
  const nextChildren = parent.children.slice();
  const nextSizes = parent.sizes.slice();
  nextChildren.splice(idx, 1);
  nextSizes.splice(idx, 1);
  const nextParent: SplitNode = {
    ...parent,
    children: nextChildren,
    sizes: nextSizes,
  };
  return normalize(replaceNode(root, parent.id, nextParent));
}

/**
 * Split `leafId` into a 50/50 pair. The side ("before" / "after") controls
 * whether the new sibling is to the left/top or right/bottom of the
 * original. If `movedTabId` is given, that tab moves into the new sibling
 * (so the original leaf loses it). Otherwise the new sibling starts empty.
 */
export function splitLeaf(
  root: PaneNode,
  leafId: string,
  direction: "horizontal" | "vertical",
  side: "before" | "after",
  movedTabId?: number,
): { tree: PaneNode; newLeafId: string } {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return { tree: root, newLeafId: leafId };

  // Build the new sibling first.
  const newLeaf = makeLeaf();
  let updatedOriginal: LeafNode = leaf;

  if (typeof movedTabId === "number" && leaf.tabIds.includes(movedTabId)) {
    const remaining = leaf.tabIds.filter((id) => id !== movedTabId);
    const nextActive =
      leaf.activeTabId === movedTabId
        ? (remaining[Math.max(0, leaf.tabIds.indexOf(movedTabId) - 1)] ??
          remaining[0] ??
          null)
        : leaf.activeTabId;
    updatedOriginal = {
      ...leaf,
      tabIds: remaining,
      activeTabId: nextActive,
    };
    newLeaf.tabIds = [movedTabId];
    newLeaf.activeTabId = movedTabId;

    // Edge case: the moved tab was the leaf's only tab. The "split"
    // collapses to just the new sibling — keeping an empty source half
    // would leave a useless 0-tab pane next to it.
    if (remaining.length === 0) {
      return {
        tree: normalize(replaceNode(root, leafId, newLeaf)),
        newLeafId: newLeaf.id,
      };
    }
  }

  // If the parent already splits in the same direction, just insert as a
  // sibling — keeps the tree flat and avoids deep nesting for line-up splits.
  const [parent, idx] = findParent(root, leafId);
  if (parent && parent.direction === direction) {
    const insertIdx = side === "after" ? idx + 1 : idx;
    const nextChildren = parent.children.slice();
    nextChildren[idx] = updatedOriginal;
    nextChildren.splice(insertIdx, 0, newLeaf);
    const half = parent.sizes[idx] / 2;
    const nextSizes = parent.sizes.slice();
    nextSizes[idx] = half;
    nextSizes.splice(insertIdx, 0, half);
    const nextParent: SplitNode = {
      ...parent,
      children: nextChildren,
      sizes: nextSizes,
    };
    return {
      tree: normalize(replaceNode(root, parent.id, nextParent)),
      newLeafId: newLeaf.id,
    };
  }

  // Otherwise wrap the leaf in a new split.
  const children =
    side === "after" ? [updatedOriginal, newLeaf] : [newLeaf, updatedOriginal];
  const nextSplit = makeSplit(direction, children, [50, 50]);
  return {
    tree: normalize(replaceNode(root, leafId, nextSplit)),
    newLeafId: newLeaf.id,
  };
}

/** Reorder a tab inside its leaf. Pure. */
export function reorderInLeaf(
  root: PaneNode,
  leafId: string,
  fromIdx: number,
  toIdx: number,
): PaneNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return root;
  if (fromIdx < 0 || fromIdx >= leaf.tabIds.length) return root;
  if (toIdx < 0) toIdx = 0;
  if (toIdx >= leaf.tabIds.length) toIdx = leaf.tabIds.length - 1;
  if (fromIdx === toIdx) return root;
  const next = leaf.tabIds.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return replaceNode(root, leafId, { ...leaf, tabIds: next });
}

/** Move a tab from its current leaf to a target leaf at `index`. Pure. */
export function moveTabToLeaf(
  root: PaneNode,
  tabId: number,
  targetLeafId: string,
  index?: number,
): PaneNode {
  const target = findLeaf(root, targetLeafId);
  if (!target) return root;
  const owner = findLeafByTab(root, tabId);
  if (owner && owner.id === targetLeafId) {
    // Same-leaf reorder.
    const from = owner.tabIds.indexOf(tabId);
    const to =
      typeof index === "number"
        ? Math.max(0, Math.min(index, owner.tabIds.length - 1))
        : owner.tabIds.length - 1;
    return reorderInLeaf(root, owner.id, from, to);
  }
  // Cross-leaf: remove from source, then insert into target.
  let next = root;
  if (owner) {
    const fromIdx = owner.tabIds.indexOf(tabId);
    const remaining = owner.tabIds.slice();
    remaining.splice(fromIdx, 1);
    const nextOwnerActive =
      owner.activeTabId === tabId
        ? (remaining[Math.max(0, fromIdx - 1)] ?? remaining[0] ?? null)
        : owner.activeTabId;
    const nextOwner: LeafNode = {
      ...owner,
      tabIds: remaining,
      activeTabId: nextOwnerActive,
    };
    if (remaining.length === 0 && walkLeaves(root).length > 1) {
      next = dropLeaf(root, owner.id);
    } else {
      next = replaceNode(root, owner.id, nextOwner);
    }
  }
  return insertTabIntoLeaf(next, targetLeafId, tabId, index);
}

/** Set the active tab in a given leaf. Pure. */
export function setLeafActive(
  root: PaneNode,
  leafId: string,
  tabId: number | null,
): PaneNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return root;
  if (leaf.activeTabId === tabId) return root;
  // Only set if the tab actually lives in the leaf (or null is allowed).
  if (tabId !== null && !leaf.tabIds.includes(tabId)) return root;
  return replaceNode(root, leafId, { ...leaf, activeTabId: tabId });
}

/** Compute axis-aligned bounding boxes of every leaf for directional focus. */
export type LeafRect = { id: string; x: number; y: number; w: number; h: number };

export function computeLeafRects(
  root: PaneNode,
  rect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 100, h: 100 },
): LeafRect[] {
  if (root.kind === "leaf") {
    return [{ id: root.id, ...rect }];
  }
  const out: LeafRect[] = [];
  let cursor = 0;
  for (let i = 0; i < root.children.length; i++) {
    const size = root.sizes[i] / 100;
    if (root.direction === "horizontal") {
      const w = rect.w * size;
      out.push(
        ...computeLeafRects(root.children[i], {
          x: rect.x + cursor * rect.w,
          y: rect.y,
          w,
          h: rect.h,
        }),
      );
      cursor += size;
    } else {
      const h = rect.h * size;
      out.push(
        ...computeLeafRects(root.children[i], {
          x: rect.x,
          y: rect.y + cursor * rect.h,
          w: rect.w,
          h,
        }),
      );
      cursor += size;
    }
  }
  return out;
}

/**
 * Find the leaf adjacent to `fromLeafId` in a given direction. Picks the
 * leaf whose center is closest along the chosen axis. Returns null if no
 * leaf qualifies.
 */
export function focusDirectional(
  root: PaneNode,
  fromLeafId: string,
  direction: "left" | "right" | "up" | "down",
): string | null {
  const rects = computeLeafRects(root);
  const from = rects.find((r) => r.id === fromLeafId);
  if (!from) return null;
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const EPS = 0.5;
  const candidates = rects.filter((r) => r.id !== fromLeafId);
  let best: { id: string; dist: number } | null = null;
  for (const r of candidates) {
    // Edge-based gating: the candidate's leading edge in the chosen
    // direction must be past the from-leaf's trailing edge. This rejects
    // leaves that merely overlap the from-leaf's center on the wrong axis
    // (e.g. an L-shaped full-height pane sitting beside TR/BR halves).
    let gapPrimary: number; // distance to traverse along the primary axis
    let secondary: number; // misalignment on the perpendicular axis
    if (direction === "left") {
      if (r.x + r.w > from.x + EPS) continue;
      gapPrimary = from.x - (r.x + r.w);
      secondary = Math.abs(r.y + r.h / 2 - fromCy);
    } else if (direction === "right") {
      if (r.x < from.x + from.w - EPS) continue;
      gapPrimary = r.x - (from.x + from.w);
      secondary = Math.abs(r.y + r.h / 2 - fromCy);
    } else if (direction === "up") {
      if (r.y + r.h > from.y + EPS) continue;
      gapPrimary = from.y - (r.y + r.h);
      secondary = Math.abs(r.x + r.w / 2 - fromCx);
    } else {
      if (r.y < from.y + from.h - EPS) continue;
      gapPrimary = r.y - (from.y + from.h);
      secondary = Math.abs(r.x + r.w / 2 - fromCx);
    }
    // Primary distance dominates; secondary breaks ties for stacks of
    // panes in the same direction.
    const dist = gapPrimary * 100 + secondary;
    if (!best || dist < best.dist) best = { id: r.id, dist };
  }
  return best?.id ?? null;
}

/** Update a split's sizes array. Pure. */
export function setSplitSizes(
  root: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId) {
    return { ...root, sizes };
  }
  return {
    ...root,
    children: root.children.map((c) => setSplitSizes(c, splitId, sizes)),
  };
}
