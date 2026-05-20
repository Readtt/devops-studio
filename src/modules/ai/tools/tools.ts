import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildSubagentTools } from "./subagent";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

// DevOps Studio is strict read-only for the user's filesystem and git repo.
// The only mutations happen via the ADO REST commands (Phase 3+) and the
// settings keychain — neither of which is exposed as an AI tool.
//
// Tools kept:
//   - read_file, list_directory, grep, glob (security guard refuses .env / .ssh / credentials)
//   - run_subagent (qa-analyst — itself read-only)
//   - todo (in-app session state, no disk writes)
//
// Removed: write_file, edit, multi_edit, create_directory, rename, delete,
// run_command, shell_session_run, shell_bg_spawn — see plan §Phase 2a.
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTodoTools(ctx),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
