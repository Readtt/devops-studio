import {
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from "@dnd-kit/core";

/**
 * Priority-aware collision detection for the tabs/pane workspace:
 *
 *   tab chip (sortable item) > edge zone > leaf center
 *
 * Without this, dropping a tab over a leaf edge could hit either the
 * edge droppable, the leaf-center, or even a tab chip underneath and
 * the resolution would be arbitrary. The priority order matches what
 * the user expects: dropping on a chip = insert there; dropping near
 * an edge = split; dropping in the open area = move into this leaf.
 *
 * Built on pointerWithin, with rectIntersection as a fallback for
 * pointers that fall just outside any droppable (e.g. on the resize
 * handle between panes — the closest leaf still wins).
 */
export const tabAwareCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const candidates = within.length > 0 ? within : rectIntersection(args);
  if (candidates.length === 0) return [];

  const tabs: typeof candidates = [];
  const edges: typeof candidates = [];
  const centers: typeof candidates = [];
  const others: typeof candidates = [];

  for (const c of candidates) {
    const id = String(c.id);
    if (id.startsWith("tab:")) tabs.push(c);
    else if (id.startsWith("leaf-edge:")) edges.push(c);
    else if (id.startsWith("leaf-center:")) centers.push(c);
    else others.push(c);
  }

  if (tabs.length > 0) return tabs;
  if (edges.length > 0) return edges;
  if (centers.length > 0) return centers;
  return others;
};
