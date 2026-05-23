/**
 * Stable id encoding for dnd-kit draggables/droppables. dnd-kit demands
 * primitives, so we encode "tab id + leaf id" as a string and parse on
 * the drop side. Trade-off: marginally less type-safe than passing
 * objects via `data`, but uniformly accessible to collisionDetection.
 */

export type TabDragId = `tab:${number}:${string}`;
export type LeafCenterDropId = `leaf-center:${string}`;
export type LeafEdgeDropId =
  | `leaf-edge:${string}:top`
  | `leaf-edge:${string}:right`
  | `leaf-edge:${string}:bottom`
  | `leaf-edge:${string}:left`;
export type TabSlotDropId = `tab-slot:${string}:${number}`;

export function tabDragId(tabId: number, leafId: string): TabDragId {
  return `tab:${tabId}:${leafId}`;
}

export function parseTabDragId(
  raw: string,
): { tabId: number; leafId: string } | null {
  if (!raw.startsWith("tab:")) return null;
  const rest = raw.slice(4);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const tabId = Number.parseInt(rest.slice(0, colon), 10);
  if (!Number.isFinite(tabId)) return null;
  const leafId = rest.slice(colon + 1);
  return { tabId, leafId };
}

export function leafCenterDropId(leafId: string): LeafCenterDropId {
  return `leaf-center:${leafId}`;
}

export function parseLeafCenterId(raw: string): string | null {
  if (!raw.startsWith("leaf-center:")) return null;
  return raw.slice("leaf-center:".length);
}

export function leafEdgeDropId(
  leafId: string,
  side: "top" | "right" | "bottom" | "left",
): LeafEdgeDropId {
  return `leaf-edge:${leafId}:${side}` as LeafEdgeDropId;
}

export function parseLeafEdgeId(
  raw: string,
): { leafId: string; side: "top" | "right" | "bottom" | "left" } | null {
  if (!raw.startsWith("leaf-edge:")) return null;
  const rest = raw.slice("leaf-edge:".length);
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return null;
  const leafId = rest.slice(0, colon);
  const side = rest.slice(colon + 1) as "top" | "right" | "bottom" | "left";
  if (
    side !== "top" &&
    side !== "right" &&
    side !== "bottom" &&
    side !== "left"
  ) {
    return null;
  }
  return { leafId, side };
}

export function tabSlotDropId(leafId: string, index: number): TabSlotDropId {
  return `tab-slot:${leafId}:${index}`;
}

export function parseTabSlotId(
  raw: string,
): { leafId: string; index: number } | null {
  if (!raw.startsWith("tab-slot:")) return null;
  const rest = raw.slice("tab-slot:".length);
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return null;
  const leafId = rest.slice(0, colon);
  const index = Number.parseInt(rest.slice(colon + 1), 10);
  if (!Number.isFinite(index)) return null;
  return { leafId, index };
}
