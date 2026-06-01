import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";

export { resolvePath, type ToolContext } from "./context";

/**
 * Read-only tool set for the source directory the user selects: file reads,
 * directory listing, grep, glob. The AI suggests artifacts (test cases, bugs,
 * review patches) the user applies — it never autonomously writes, edits, or
 * runs shell commands.
 *
 * @readonly — never add write/edit/bash/delegation tools here.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
