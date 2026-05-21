import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildSubagentTools } from "./subagent";

export { resolvePath, type ToolContext } from "./context";

// Strict read-only for the source directory the user selects. todo_write tool
// dropped in Phase 1B alongside the AI chat UI — the Generator doesn't use it.
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildSubagentTools(ctx),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
