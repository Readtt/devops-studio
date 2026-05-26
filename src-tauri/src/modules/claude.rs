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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

/// Suppress the Windows console window that flashes when a subprocess is
/// spawned from a GUI app. Without this every `claude --version`, every
/// `claude_run_query`, every `claude auth status` call pops a cmd.exe window
/// for a split second — and the generator alone fires several of those per
/// session. No-op on non-Windows.
#[inline]
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Owned by Tauri State so we can track in-flight `claude` runs. We only
/// stash run_ids; cancellation lands in a follow-up that wires an
/// `AbortHandle` per run.
#[derive(Default)]
pub struct ClaudeState {
    pub running: Mutex<Vec<RunningHandle>>,
    /// PID of the in-flight `claude setup-token` child, if any. Used by
    /// `claude_cancel_setup_token` to break the user out of an OAuth flow
    /// that didn't self-terminate after the browser callback (some CLI
    /// builds wait for an Enter key on stdin we can't provide from Tauri).
    pub setup_token_pid: Mutex<Option<u32>>,
}

pub struct RunningHandle {
    pub run_id: String,
    /// Notified when the renderer asks to cancel this run. The owning task
    /// races `child.wait()` against `cancel.notified()` and kills the child
    /// on the cancel branch — see `claude_run_query`.
    pub cancel: Arc<Notify>,
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
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeError {
    /// `claude` isn't on PATH or `claude --version` failed.
    NotInstalled,
    /// Renderer asked to cancel the run (ESC during refine, tab close).
    /// Distinct from NonZeroExit so the UI doesn't show a scary "exited
    /// with code N" message for a user-initiated abort.
    Cancelled,
    /// Process started but exited non-zero. `stderr_excerpt` is the first
    /// ~2 KB of the child's stderr — usually enough to diagnose.
    NonZeroExit {
        code: Option<i32>,
        stderr_excerpt: String,
    },
    /// CLI exited 0 but the stream-json `result` event reported `is_error:
    /// true` — typically a 4xx/5xx from the API (auth failure, rate limit,
    /// invalid model). The `message` is the result event's human-readable
    /// `result` field; `http_status` is its `api_error_status` when present.
    /// Surfacing this distinctly stops us from parsing the error message as
    /// if it were the model's JSON output.
    ApiError {
        message: String,
        http_status: Option<i64>,
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
            Self::Cancelled => write!(f, "Run cancelled."),
            Self::NonZeroExit { code, stderr_excerpt } => write!(
                f,
                "claude exited with code {:?}: {}",
                code,
                truncate(stderr_excerpt, 200)
            ),
            Self::ApiError { message, http_status } => match http_status {
                Some(s) => write!(f, "claude API error ({s}): {}", truncate(message, 200)),
                None => write!(f, "claude API error: {}", truncate(message, 200)),
            },
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
    /// Restrict the agent to a fixed set of built-in tools. Maps to the CLI's
    /// `--tools` flag, which actually constrains the available tool surface
    /// (unlike `--allowedTools`, which only pre-approves permission prompts —
    /// with `bypassPermissions` set, `--allowedTools` lets the model still
    /// call Bash/Write/Edit unprompted). The Rust handler refuses to spawn if
    /// any entry isn't in `READ_ONLY_TOOLS`, so a typo can't quietly re-open
    /// the surface. Callers pass canonical CLI tool names like "Read",
    /// "Glob", "Grep".
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// Run in `--bare` mode — skip hook discovery, plugin sync, LSP, auto
    /// memory, and CLAUDE.md loading. Anthropic docs recommend this for
    /// scripted/SDK calls; without it, a stale or failing hook in the user's
    /// `~/.claude` or in the cwd's `.claude/settings.json` aborts the run
    /// with a bare non-zero exit and no parent-visible stderr (the hook's
    /// error lands in a `hook_response` stream-json event instead). Requires
    /// API-key auth — OAuth/keychain reads are skipped in bare mode.
    #[serde(default)]
    pub bare: Option<bool>,
    /// Extra environment vars to merge into the child's env. Used to pass
    /// `ANTHROPIC_API_KEY` when the user picks API-key auth mode.
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    /// Image attachments to send as real vision input. When non-empty we
    /// switch stdin to `--input-format stream-json` and frame the prompt as a
    /// single user message whose content carries a text block plus one base64
    /// image block per entry — the native multimodal path (single-message /
    /// plain-text stdin can't carry images). Empty/None keeps the proven
    /// plain-text stdin path untouched.
    #[serde(default)]
    pub images: Option<Vec<ImageInput>>,
}

/// One base64-encoded image to attach to a stream-json user message. `data`
/// is the raw base64 payload (no `data:` URL prefix); `media_type` is the
/// MIME type the Anthropic API expects (e.g. "image/png").
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data_base64: String,
}

/// Tools that can read but cannot mutate filesystem, run shell, or reach the
/// network. The generator path enforces this allowlist to keep the analyze
/// agent strictly read-only regardless of permission-mode or model behavior.
const READ_ONLY_TOOLS: &[&str] = &["Read", "Glob", "Grep"];

fn is_read_only_tool(name: &str) -> bool {
    READ_ONLY_TOOLS.iter().any(|t| t.eq_ignore_ascii_case(name))
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
    let mut cmd = Command::new(&path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd
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

    // Vision path: when images are attached we frame stdin as a stream-json
    // user message (the only stdin format that carries image blocks). With no
    // images we keep the simpler plain-text stdin the rest of the app relies on.
    let has_images = input
        .images
        .as_ref()
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let mut cmd = Command::new(&path);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose"); // required by the CLI when output-format is stream-json
    if has_images {
        // Tell the CLI stdin is a stream of JSON messages rather than raw text.
        cmd.arg("--input-format").arg("stream-json");
    }
    // Bare mode skips hook/plugin/MCP/CLAUDE.md auto-discovery — recommended
    // by Anthropic for scripted callers. Without it, a failing SessionStart
    // hook in the user's `~/.claude` makes the CLI exit non-zero with no
    // parent-visible stderr (the hook's error lands in a stream-json event).
    if input.bare.unwrap_or(false) {
        cmd.arg("--bare");
    }
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
    if let Some(allowed) = &input.allowed_tools {
        // Defense in depth: if a caller asks for a tool set that contains a
        // known mutating/exec tool, refuse the spawn outright.
        if let Some(bad) = allowed
            .iter()
            .find(|t| !is_read_only_tool(t.as_str()))
        {
            return Err(ClaudeError::SpawnFailed {
                message: format!(
                    "refusing to spawn claude with non-read-only tool in restriction set: {bad}"
                ),
            });
        }
        // Use `--tools` (the actual restriction flag) instead of
        // `--allowedTools` (which only pre-approves permission prompts). With
        // `--permission-mode bypassPermissions`, `--allowedTools` does NOT
        // prevent the model from calling Bash/Write/Edit — only `--tools`
        // removes them from the available set. Pass as one comma-separated
        // arg, which the CLI accepts.
        cmd.arg("--tools").arg(allowed.join(","));
    }
    if let Some(cwd) = &input.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(extra_env) = &input.env {
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
    }

    // Stream the prompt over stdin instead of passing it as an argv. Windows
    // CreateProcess has a ~32 KiB lpCommandLine limit; the refine path builds
    // prompts that embed the full draft batch + spec + attachments, which
    // overflows that limit and surfaces as "The filename or extension is too
    // long. (os error 206)". `claude --print` without a positional prompt
    // arg reads the prompt from stdin instead, sidestepping the limit
    // entirely.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    // Take the output handles BEFORE writing stdin so we can drain them in
    // parallel. Large refine prompts (full draft batch + attachments + spec)
    // are bigger than the OS pipe buffer; if the child writes diagnostics to
    // stdout/stderr while we're still pushing stdin and nobody's draining the
    // other side, the pipes deadlock and the run aborts mid-prompt — which
    // surfaced to the user as a bare "Claude exited with code 1" because the
    // CLI was killed before it could log anything.
    let stdin_handle = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stdout".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| ClaudeError::SpawnFailed {
        message: "failed to capture stderr".into(),
    })?;

    // Write the prompt on a background task so the main flow can drain stdout
    // and stderr concurrently. Errors here are recorded but non-fatal — the
    // child will exit with a non-zero status that we report from its own
    // stderr, which carries the real diagnostic.
    let prompt_bytes: Vec<u8> = if has_images {
        // Frame the turn as a single stream-json user message: a text block
        // followed by one base64 image block per attachment. One line + EOF
        // (the stdin.shutdown below) is enough for a one-shot run.
        let images = input.images.clone().unwrap_or_default();
        let mut content: Vec<serde_json::Value> =
            vec![serde_json::json!({ "type": "text", "text": input.prompt })];
        for img in &images {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.media_type,
                    "data": img.data_base64,
                },
            }));
        }
        let message = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
        });
        let mut line = serde_json::to_vec(&message).unwrap_or_default();
        line.push(b'\n');
        line
    } else {
        input.prompt.as_bytes().to_vec()
    };
    let stdin_task = tokio::spawn(async move {
        if let Some(mut stdin) = stdin_handle {
            // BrokenPipe is the common failure mode when the child rejects the
            // prompt early (bad model, bad flag) — swallow it so we surface
            // the child's own stderr message instead of a parent-side wrapper.
            let _ = stdin.write_all(&prompt_bytes).await;
            let _ = stdin.shutdown().await;
        }
    });

    // Register this run so we can list in-flight queries AND signal cancel.
    // The renderer calls `claude_cancel_run(run_id)` (ESC during refine, tab
    // close mid-run, etc.) — that hits the Notify, which our select! below
    // races against `child.wait()` and kills the child on the cancel branch.
    let cancel = Arc::new(Notify::new());
    if let Ok(mut g) = state.running.lock() {
        g.push(RunningHandle {
            run_id: input.run_id.clone(),
            cancel: cancel.clone(),
        });
    }

    // Stream stdout: one JSON object per line. We forward each line to the
    // renderer as a Tauri event so the UI can show intermediate tool calls,
    // and we pluck the final `result` event for the return value.
    let app_for_stdout = app.clone();
    let event_for_stdout = event_name.clone();
    let stdout_task = tokio::spawn(async move {
        let mut final_text = String::new();
        // Whether the terminal `result` event reported a failure. We capture
        // is_error / api_error_status here so an API failure (e.g. 401 from a
        // bad key) doesn't get returned as a "successful" text payload that
        // the caller then tries to parse as the model's JSON output.
        let mut result_is_error = false;
        let mut result_http_status: Option<i64> = None;
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
                    if value.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
                        result_is_error = true;
                    }
                    if let Some(s) = value.get("api_error_status").and_then(|v| v.as_i64()) {
                        result_http_status = Some(s);
                    }
                }
                // Emit the parsed object so the UI can render anything it
                // wants (tool calls, partial text, usage stats).
                let _ = app_for_stdout.emit(&event_for_stdout, value);
            }
        }
        (final_text, result_is_error, result_http_status)
    });

    // Stderr is captured for diagnostics but not streamed event-by-event.
    // Read as raw bytes (not UTF-8 lines) so a stray non-UTF-8 byte from the
    // CLI's console output doesn't abort the read mid-stream and leave the
    // user staring at a bare "Claude exited with code 1:" with no message.
    // We bound the capture at ~8 KiB and convert lossily at the end.
    let stderr_task = tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(2_048);
        let mut reader = stderr;
        let mut chunk = [0u8; 1_024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len() < 8_192 {
                        let take = n.min(8_192 - buf.len());
                        buf.extend_from_slice(&chunk[..take]);
                    }
                    // Keep draining past the cap so the child's pipe doesn't
                    // block on a full buffer once stderr exceeds 8 KiB.
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    // Race the child against the cancel notify. On cancel we kill the child
    // and surface ClaudeError::Cancelled so the renderer can distinguish a
    // user-initiated abort from a real failure.
    let mut was_cancelled = false;
    let status = tokio::select! {
        biased;
        _ = cancel.notified() => {
            was_cancelled = true;
            let _ = child.start_kill();
            // Reap so the OS doesn't leave a zombie. Best-effort.
            child
                .wait()
                .await
                .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?
        }
        s = child.wait() => {
            s.map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?
        }
    };

    // Drop the run from the registry once it finishes.
    if let Ok(mut g) = state.running.lock() {
        g.retain(|h| h.run_id != input.run_id);
    }

    let (final_text, result_is_error, result_http_status) = stdout_task
        .await
        .unwrap_or_else(|_| (String::new(), false, None));
    let stderr_excerpt = stderr_task.await.unwrap_or_default();
    // The stdin writer may still be flushing when the child exits early; await
    // it so the task doesn't leak and any partial-write error is observed.
    let _ = stdin_task.await;

    if was_cancelled {
        return Err(ClaudeError::Cancelled);
    }

    if !status.success() {
        return Err(ClaudeError::NonZeroExit {
            code: status.code(),
            stderr_excerpt,
        });
    }

    // CLI exited 0 but the `result` event reported a failure (auth, rate
    // limit, server error). The `result` field contains the human-readable
    // explanation, not the model's JSON output — surface it as a distinct
    // error so the caller can show it instead of trying to parse it.
    if result_is_error {
        return Err(ClaudeError::ApiError {
            message: if final_text.is_empty() {
                "Claude reported is_error=true with no message.".into()
            } else {
                final_text
            },
            http_status: result_http_status,
        });
    }

    Ok(RunQueryResult {
        text: final_text,
        exit_code: status.code(),
    })
}

/// Start the CLI's OAuth login flow. We don't capture the user's token here
/// — the CLI handles its own credential storage. We just spawn `claude auth
/// login`, stream every stdout/stderr line as a Tauri event so the UI can
/// render the device-code URL the moment it's printed, and resolve when the
/// CLI exits.
///
/// `claude auth login` is the modern command per Anthropic's CHANGELOG —
/// the legacy `claude setup-token` does the same thing but is being phased
/// out. The login command also gracefully handles the case where the
/// browser callback can't reach localhost (devcontainers, WSL, restrictive
/// firewalls) by prompting for a paste-in code on stdin.
///
/// Event channel: `claude:setup-token:line`
/// Payload: `{ stream: "stdout" | "stderr", line: string }`
#[tauri::command]
pub async fn claude_setup_token(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
) -> Result<String, ClaudeError> {
    let path = which::which("claude").map_err(|_| ClaudeError::NotInstalled)?;
    let mut cmd = Command::new(&path);
    cmd.args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    // Remember the PID so `claude_cancel_setup_token` can break us out if the
    // CLI doesn't self-terminate after the browser callback (some builds wait
    // on an Enter key on stdin, which Tauri can't provide).
    if let Some(pid) = child.id() {
        if let Ok(mut g) = state.setup_token_pid.lock() {
            *g = Some(pid);
        }
    }

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

    // Clear the PID — whatever happens from here, the child is gone.
    if let Ok(mut g) = state.setup_token_pid.lock() {
        *g = None;
    }

    let stdout_out = stdout_task.await.unwrap_or_default();
    let stderr_out = stderr_task.await.unwrap_or_default();

    if !status.success() {
        // SIGTERM/SIGKILL via claude_cancel_setup_token surfaces as a non-zero
        // exit. Treat it as a clean cancel rather than a failure — the user
        // explicitly asked to dismiss the flow.
        if stderr_out.is_empty() && stdout_out.contains("https://") {
            return Ok(stdout_out);
        }
        return Err(ClaudeError::NonZeroExit {
            code: status.code(),
            stderr_excerpt: stderr_out,
        });
    }

    Ok(stdout_out)
}

/// Result of `claude auth status` — whether the CLI is logged in, and
/// (best-effort) which identity / auth mode is in use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    /// Raw stdout from `claude auth status`, surfaced for diagnostics in the
    /// settings panel when something is off.
    pub raw: String,
}

/// Verify whether the CLI has stored credentials. Runs `claude auth status`
/// and treats any output containing "logged in" / "authenticated" / "active
/// session" as success. Non-zero exit or "not logged in" output reports
/// authenticated: false.
///
/// Distinct from `claude_probe`, which only checks that the binary is on
/// PATH and prints a version. After the "I've authorized — recheck" path
/// in settings, we want to know whether the OAuth actually persisted, not
/// just whether the CLI is installed.
#[tauri::command]
pub async fn claude_check_auth(_app: AppHandle) -> Result<AuthStatus, ClaudeError> {
    let path = which::which("claude").map_err(|_| ClaudeError::NotInstalled)?;
    let mut cmd = Command::new(&path);
    cmd.args(["auth", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| ClaudeError::SpawnFailed { message: e.to_string() })?;

    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let combined = if stderr.trim().is_empty() {
        stdout.clone()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let lower = combined.to_lowercase();

    // The CLI prints things like "Logged in as foo@bar (Pro)" / "Authenticated
    // with Anthropic" on success; "Not logged in" / "no active session" on
    // failure. Be liberal on positive markers so we don't fail when Anthropic
    // tweaks the wording. The exit code is the strongest signal — but only
    // some builds set it correctly, so combine both.
    let positive = ["logged in", "authenticated", "active session", "you are signed in"];
    let negative = ["not logged in", "no active session", "please run", "not authenticated"];
    let any_positive = positive.iter().any(|p| lower.contains(p));
    let any_negative = negative.iter().any(|n| lower.contains(n));

    let authenticated = if any_negative {
        false
    } else if any_positive {
        true
    } else {
        // Fall back to exit code if the wording matches neither.
        out.status.success()
    };

    Ok(AuthStatus { authenticated, raw: combined })
}

/// Cancel an in-flight `claude_run_query` by its run_id. Notifies the run
/// task's cancel channel, which races against `child.wait()` in the run loop
/// and kills the child on the cancel branch. The renderer wires this to ESC
/// during refine / analyze so the user can break out without waiting for the
/// model to finish. Safe to call when the run_id is unknown — it's a no-op
/// in that case (the run probably finished or never started).
#[tauri::command]
pub async fn claude_cancel_run(
    state: tauri::State<'_, ClaudeState>,
    run_id: String,
) -> Result<(), String> {
    let notify = state
        .running
        .lock()
        .ok()
        .and_then(|g| g.iter().find(|h| h.run_id == run_id).map(|h| h.cancel.clone()));
    if let Some(n) = notify {
        n.notify_waiters();
    }
    Ok(())
}

/// Send a kill signal to the in-flight `claude setup-token` process. Used by
/// the "I've authorized — recheck" affordance: after the user finishes the
/// browser flow, if the CLI is stuck waiting on stdin or a callback that
/// never arrives, we break it out so the UI can re-probe.
#[tauri::command]
pub async fn claude_cancel_setup_token(
    state: tauri::State<'_, ClaudeState>,
) -> Result<(), String> {
    let pid = state
        .setup_token_pid
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    let Some(pid) = pid else { return Ok(()) };

    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        let _ = cmd.output().await;
    }
    #[cfg(unix)]
    {
        // Try SIGTERM first, then fall back to SIGKILL after a brief grace.
        let _ = Command::new("kill")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .await;
    }
    Ok(())
}
