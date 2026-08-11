import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  BEST_PRACTICE_FILE_CAP,
  loadBestPracticeBlocks,
} from "./bestPractices";
import { useBestPracticeWarnings } from "@/modules/ai/store/bestPracticeWarnings";

const file = (path: string, label = "") => ({ path, label, enabled: true });

beforeEach(() => {
  invoke.mockReset();
  useBestPracticeWarnings.setState({ warnings: [], dismissed: false });
});

// Every one of the six call sites used to throw `warnings` away (five
// console.warn, one that didn't even destructure it), so a standards file the
// AI had silently stopped following was invisible from the app. Publishing from
// the loader — not the callers — is what makes a call site added later
// impossible to get wrong.
describe("loadBestPracticeBlocks · warnings reach the UI", () => {
  it("publishes an unreadable file to the shared store", async () => {
    invoke.mockRejectedValue("network path is unavailable");
    await loadBestPracticeBlocks([file("//share/standards.md", "House rules")]);
    const { warnings } = useBestPracticeWarnings.getState();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("House rules");
    expect(warnings[0]).toContain("could not read");
  });

  it("publishes a truncated file — the one failure the run's output can't show", async () => {
    const body = "x".repeat(BEST_PRACTICE_FILE_CAP + 5_000);
    invoke.mockResolvedValue({ kind: "text", content: body, size: body.length });
    const { blocks } = await loadBestPracticeBlocks([
      file("C:/std/rules.md", "Rules"),
    ]);
    // The model is told, and so is the user.
    expect(blocks[0].body).toContain("[TRUNCATED");
    expect(useBestPracticeWarnings.getState().warnings[0]).toMatch(
      /Rules:.*only the first/i,
    );
  });

  it("clears the notice once the files load cleanly again", async () => {
    invoke.mockRejectedValue("gone");
    await loadBestPracticeBlocks([file("C:/std/rules.md", "Rules")]);
    expect(useBestPracticeWarnings.getState().warnings).toHaveLength(1);

    invoke.mockReset();
    invoke.mockResolvedValue({ kind: "text", content: "be nice", size: 7 });
    await loadBestPracticeBlocks([file("C:/std/rules.md", "Rules")]);
    expect(useBestPracticeWarnings.getState().warnings).toEqual([]);
  });

  it("keeps a dismissal until the warnings actually change", async () => {
    invoke.mockRejectedValue("gone");
    await loadBestPracticeBlocks([file("C:/std/rules.md", "Rules")]);
    useBestPracticeWarnings.getState().dismiss();

    // Same problem on the next run — don't nag.
    await loadBestPracticeBlocks([file("C:/std/rules.md", "Rules")]);
    expect(useBestPracticeWarnings.getState().dismissed).toBe(true);

    // A different problem is new information.
    await loadBestPracticeBlocks([file("C:/std/other.md", "Other")]);
    expect(useBestPracticeWarnings.getState().dismissed).toBe(false);
  });

  it("reports nothing when there are no enabled files", async () => {
    await loadBestPracticeBlocks([]);
    expect(useBestPracticeWarnings.getState().warnings).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
