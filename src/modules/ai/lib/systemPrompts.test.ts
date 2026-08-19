import { describe, expect, it } from "vitest";
import * as prompts from "./systemPrompts";
import { REPO_PATH_RULE } from "./repoPaths";

// The four surfaces are read-only against the user's source. Their system
// prompts must never instruct the model to use a mutator/agent tool — those
// tools don't exist anymore, and a stray mention would be a regression signal.
const FORBIDDEN_TOOL_TOKENS = [
  "write_file",
  "create_directory",
  "bash_run",
  "bash_background",
  "multi_edit",
  "run_subagent",
  "todo_write",
];

const ALL = {
  qaAnalyst: prompts.qaAnalyst,
  suiteChat: prompts.suiteChat,
  commitReview: prompts.commitReview,
  commitReviewVerify: prompts.commitReviewVerify,
  confidenceEval: prompts.confidenceEval,
  draftChat: prompts.draftChat,
};

describe("systemPrompts", () => {
  for (const [name, prompt] of Object.entries(ALL)) {
    it(`${name} is a non-empty string`, () => {
      expect(typeof prompt).toBe("string");
      expect(prompt.trim().length).toBeGreaterThan(0);
    });

    it(`${name} references no mutator/agent tool`, () => {
      for (const token of FORBIDDEN_TOOL_TOKENS) {
        expect(prompt).not.toContain(token);
      }
    });

    // Every surface shares one tool layer, and that layer addresses files as
    // `<repo>/<path>` at every repo count. A surface whose prompt never says so
    // emits bare paths and pays a correction round-trip for each one — so this
    // is asserted here, over the enumeration, rather than only per surface:
    // it is what a NEW surface has to satisfy too.
    it(`${name} states the repo-prefixed path rule`, () => {
      expect(prompt).toContain(REPO_PATH_RULE);
    });
  }
});
