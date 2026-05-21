//! Subprocess driver for the Claude Code CLI (`claude`).
//!
//! Why a subprocess instead of the `@anthropic-ai/claude-agent-sdk` library
//! in-process?
//!
//! The SDK is Node-only — it `require()`s `child_process` and spawns shells
//! for its Bash tool. None of that runs in the Tauri webview. The realistic
//! alternative is to drive the user's installed `claude` CLI: it ships the
//! same agent loop, authenticates against either an Anthropic API key or the
//! user's Claude Pro/Max subscription via `claude setup-token`, and exposes
//! a stream-JSON output format that we can read line-by-line.
//!
//! Commands here are intentionally low-level: `probe` (is `claude` installed
//! and which version), `setup_token` (kick off the OAuth login flow), and
//! `run_query` (one-shot prompt → text response, streaming intermediate
//! events to the renderer via Tauri events).

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Owned by Tauri State so we can track in-flight `claude` runs. We only
/// stash run_ids; cancellation lands in a follow-up that wires an
/// `AbortHandle` per run.
#[derive(Default)]
pub struct ClaudeState {
    pub running: Mutex<Vec<RunningHandle>>,
}

pub struct RunningHandle {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// Absolute path to the resolved `claude` binary (e.g. /usr/local/bin/claude).
    pub path: String,
    /// Version string parsed from `claude --version`, e.g. "1.0.42".
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClaudeError {
    /// `claude` isn't on PATH or `claude --version` failed.
    NotInstalled,
    /// Process started but exited non-zero. `stderr_excerpt` is the first
    /// ~2 KB of the child's stderr — usually enough to diagnose.
    NonZeroExit {
        code: Option<i32>,
        stderr_excerpt: String,
    },
    /// Couldn't spawn — usually permissions or a bad cwd.
    SpawnFailed {
        message: String,
    },
}

impl std::fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled => {
                write!(f, "Claude Code CLI not found on PATH")
            }
            Self::NonZeroExit { code, stderr_excerpt } => write!(
                f,
                "claude exited with code {:?}: {}",
                code,
                truncate(stderr_excerpt, 200)
            ),
            Self::SpawnFailed { message } => write!(f, "spawn failed: {message}"),
        }
    }
}

impl std::error::Error for ClaudeError {}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        // safe slice on char boundary
        let mut end = max;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        &s[..end]
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQueryInput {
    /// Stable id assigned by the caller. Used as the suffix of the Tauri event
    /// channel (`claude:event:{run_id}`) so multiple in-flight runs don't
    /// trample each other.
    pub run_id: String,
    pub prompt: String,
    /// System prompt prepended to the conversation (--append-system-prompt).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Working directory the CLI's built-in tools (Read, Glob, Grep, Bash)
    /// are scoped to. Defaults to the process cwd.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Anthropic model id (e.g. "claude-sonnet-4-6"). When None, the CLI
    /// uses whichever model is configured in its own settings.
    #[serde(default)]
    pub model: Option<String>,
    /// Hard upper bound on agentic turns. The CLI defaults to a generous
    /// value; setting this lower makes test-case generation predictable.
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// Permission-mode override. Most useful values are "default" (ask),
    /// "bypassPermissions" (let everything through — fine inside a sandboxed
    /// project root), or "plan" (read-only plan mode).
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Extra environment vars to merge into the child's env. Used to pass
    /// `ANTHROPIC_API_KEY` when the user picks API-key auth mode.
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQueryResult {
    /// Final assistant text (`type:"result"` event from the CLI).
    pub text: String,
    /// Surface the CLI's own exit code so the renderer can show diagnostics
    /// if something subtle (e.g. quota) caused a partial success.
    pub exit_code: Option<i32>,
}

#[tauri::command]
pub async fn claude_probe() -> Result<ProbeResult, ClaudeError> {
    let path = which::which("claude")
        .map_err(|_| ClaudeError::NotInstalled)?
        .to_string_lossy()
        .into_owned();
    let out = Command::new(&path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;
    if !out.status.success() {
        return Err(ClaudeError::NonZeroExit {
            code: out.status.code(),
            stderr_excerpt: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }
    // `claude --version` prints something like "claude 1.2.3 (build …)"
    // — keep the first whitespace-separated token that contains a dot.
    let raw = String::from_utf8_lossy(&out.stdout);
    let version = raw
        .split_whitespace()
        .find(|t| t.contains('.') && t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
        .unwrap_or("unknown")
        .to_string();
    Ok(ProbeResult { path, version })
}

/// Run a single one-shot query against `claude` in stream-json mode. Streams
/// each NDJSON event to the renderer via `claude:event:{run_id}` and returns
/// the final assistant text (assembled from the `result` event).
#[tauri::command]
pub async fn claude_run_query(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    input: RunQueryInput,
) -> Result<RunQueryResult, ClaudeError> {
    let path = which::which("claude").map_err(|_| ClaudeError::NotInstalled)?;

    let event_name = format!("claude:event:{}", input.run_id);

    let mut cmd = Command::new(&path);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose"); // required to get streaming intermediate events
    if let Some(sys) = &input.system_prompt {
        cmd.arg("--append-system-prompt").arg(sys);
    }
    if let Some(model) = &input.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(turns) = input.max_turns {
        cmd.arg("--max-turns").arg(turns.to_string());
    }
    if let Some(mode) = &input.permission_mode {
        cmd.arg("--permission-mode").arg(mode);
    }
    if let Some(cwd) = &input.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(extra_env) = &input.env {
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
    }

    cmd.arg(&input.prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    let stdout = child.stdout.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stdout".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stderr".into(),
    })?;

    // Register this run so we can list in-flight queries. Cancel is a
    // follow-up; for now kill_on_drop handles cleanup when the future is
    // dropped (e.g. window closed mid-run).
    if let Ok(mut g) = state.running.lock() {
        g.push(RunningHandle {
            run_id: input.run_id.clone(),
        });
    }

    // Stream stdout: one JSON object per line. We forward each line to the
    // renderer as a Tauri event so the UI can show intermediate tool calls,
    // and we pluck the final `result` event for the return value.
    let app_for_stdout = app.clone();
    let event_for_stdout = event_name.clone();
    let stdout_task = tokio::spawn(async move {
        let mut final_text = String::new();
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Best-effort: parse the line and look for the terminal `result`.
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let event_kind = value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if event_kind == "result" {
                    final_text = value
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                // Emit the parsed object so the UI can render anything it
                // wants (tool calls, partial text, usage stats).
                let _ = app_for_stdout.emit(&event_for_stdout, value);
            }
        }
        final_text
    });

    // Stderr is captured for diagnostics but not streamed event-by-event.
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if buf.len() < 2_048 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    let status = child
        .wait()
        .await
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    // Drop the run from the registry once it finishes.
    if let Ok(mut g) = state.running.lock() {
        g.retain(|h| h.run_id != input.run_id);
    }

    let final_text = stdout_task.await.unwrap_or_default();
    let stderr_excerpt = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(ClaudeError::NonZeroExit {
            code: status.code(),
            stderr_excerpt,
        });
    }

    Ok(RunQueryResult {
        text: final_text,
        exit_code: status.code(),
    })
}

/// Start the CLI's OAuth login flow. We don't capture the user's token here
/// — the CLI handles its own credential storage. We just spawn `claude
/// setup-token`, stream every stdout/stderr line as a Tauri event so the UI
/// can render the device-code URL the moment it's printed, and resolve when
/// the CLI exits.
///
/// Event channel: `claude:setup-token:line`
/// Payload: `{ stream: "stdout" | "stderr", line: string }`
#[tauri::command]
pub async fn claude_setup_token(app: AppHandle) -> Result<String, ClaudeError> {
    let path = which::which("claude").map_err(|_| ClaudeError::NotInstalled)?;
    let mut child = Command::new(&path)
        .arg("setup-token")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    let stdout = child.stdout.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stdout".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stderr".into(),
    })?;

    const EVENT: &str = "claude:setup-token:line";

    let app_out = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
            let _ = app_out.emit(
                EVENT,
                serde_json::json!({ "stream": "stdout", "line": line }),
            );
        }
        buf
    });

    let app_err = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
            let _ = app_err.emit(
                EVENT,
                serde_json::json!({ "stream": "stderr", "line": line }),
            );
        }
        buf
    });

    let status = child
        .wait()
        .await
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    let stdout_out = stdout_task.await.unwrap_or_default();
    let stderr_out = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(ClaudeError::NonZeroExit {
            code: status.code(),
            stderr_excerpt: stderr_out,
        });
    }

    Ok(stdout_out)
}
