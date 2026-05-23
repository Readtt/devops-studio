import { memo } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { leafEdgeDropId } from "./dndIds";

type Props = {
  leafId: string;
  /** Optional opt-out. When the leaf has zero tabs we still allow edge
   *  drops — the user might be staging a brand-new split into an empty
   *  root pane. */
};

/**
 * Four 20%-sized droppable zones along the leaf body's edges. Mounted
 * only while a drag is active so the underlying content stays fully
 * interactive when nothing is being dragged. A 2px accent appears on
 * the active edge so the user knows where the drop will land.
 */
export const DropEdges = memo(function DropEdges({ leafId }: Props) {
  const { active } = useDndContext();
  if (!active) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      aria-hidden
    >
      <Edge leafId={leafId} side="top" />
      <Edge leafId={leafId} side="right" />
      <Edge leafId={leafId} side="bottom" />
      <Edge leafId={leafId} side="left" />
    </div>
  );
});

function Edge({
  leafId,
  side,
}: {
  leafId: string;
  side: "top" | "right" | "bottom" | "left";
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: leafEdgeDropId(leafId, side),
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "pointer-events-auto absolute",
        side === "top" && "left-0 right-0 top-0 h-[20%]",
        side === "right" && "right-0 top-0 bottom-0 w-[20%]",
        side === "bottom" && "left-0 right-0 bottom-0 h-[20%]",
        side === "left" && "left-0 top-0 bottom-0 w-[20%]",
      )}
    >
      {isOver ? (
        <div
          className={cn(
            "absolute bg-primary/60 shadow-[0_0_18px_-2px] shadow-primary/40",
            side === "top" && "left-0 right-0 top-0 h-[2px]",
            side === "right" && "right-0 top-0 bottom-0 w-[2px]",
            side === "bottom" && "left-0 right-0 bottom-0 h-[2px]",
            side === "left" && "left-0 top-0 bottom-0 w-[2px]",
          )}
        />
      ) : null}
    </div>
  );
}
