import { describe, expect, it } from "vitest";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "./contextBlocks";
import type { Attachment } from "@/components/chat/attachments";

describe("formatContextBlocks", () => {
  it("returns empty string for no blocks (no-op so text-only prompts stay unchanged)", () => {
    expect(formatContextBlocks([])).toBe("");
  });

  it("drops blocks with empty/whitespace bodies", () => {
    const blocks: ContextBlock[] = [
      { heading: "A", body: "   " },
      { heading: "B", body: "real" },
    ];
    expect(formatContextBlocks(blocks)).toBe("--- B ---\nreal");
  });

  it("joins multiple blocks with the delimiter and a blank line", () => {
    const blocks: ContextBlock[] = [
      { heading: "BUG #1 (2 - High, Active)", body: "repro" },
      { heading: "BEST PRACTICES", body: "always lint" },
    ];
    expect(formatContextBlocks(blocks)).toBe(
      "--- BUG #1 (2 - High, Active) ---\nrepro\n\n--- BEST PRACTICES ---\nalways lint",
    );
  });
});

describe("collectContextImages", () => {
  const img = (id: string): Attachment => ({
    id,
    path: `${id}.png`,
    content: "data:image/png;base64,AAAA",
    kind: "image",
    mime: "image/png",
  });

  it("returns [] when no block carries images", () => {
    expect(collectContextImages([{ heading: "x", body: "y" }])).toEqual([]);
  });

  it("flattens images across blocks in order", () => {
    const blocks: ContextBlock[] = [
      { heading: "a", body: "1", images: [img("a1")] },
      { heading: "b", body: "2" },
      { heading: "c", body: "3", images: [img("c1"), img("c2")] },
    ];
    expect(collectContextImages(blocks).map((a) => a.id)).toEqual([
      "a1",
      "c1",
      "c2",
    ]);
  });
});
