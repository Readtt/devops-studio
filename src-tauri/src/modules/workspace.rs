use std::path::PathBuf;

use serde::Deserialize;

// The old WorkspaceRegistry ("authorized roots") and the LAUNCH_CWD
// snapshot that fed it lived here. The registry was write-only
// bookkeeping — nothing ever read the set, its two commands had no
// frontend callers, and the cwd snapshot's only reader was the registry
// bootstrap — so all of it was removed. The live launch-dir mechanism is
// the argv-based `LaunchDir` state in lib.rs (`get_launch_dir`). Path
// safety for AI tool calls is enforced in the frontend tool layer: every
// path the model sends goes through `resolveRepoPath`
// (src/modules/ai/lib/repoPaths.ts), which confines it to a configured
// repo root and then runs the src/modules/ai/lib/security.ts gates.
// Direct user actions (code viewer, attachments) read arbitrary user
// files by design, like any editor.

// Kept as a single-variant enum so the frontend's existing
// `{ kind: "local" }` payloads keep deserializing. WSL support lived here
// alongside the terminal module that has since been removed.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceEnv {
    #[default]
    Local,
}

impl WorkspaceEnv {
    pub fn from_option(workspace: Option<Self>) -> Self {
        workspace.unwrap_or_default()
    }
}

pub fn resolve_path(path: &str, _workspace: &WorkspaceEnv) -> PathBuf {
    PathBuf::from(path)
}
