//! Pseudo-terminal driver for the embedded developer terminal.
//!
//! The developer-mode terminal tab spawns a real shell (`pwsh`, `bash`, ...)
//! attached to a PTY via the `portable-pty` crate, then pipes bytes between
//! that PTY and an xterm.js viewport in the webview. We deliberately do NOT
//! use `tokio::process::Command` here — terminal applications (pagers, vim,
//! AI CLIs that draw progress bars) need a real PTY to behave correctly, and
//! plain piped stdin/stdout makes them think they're being scripted.
//!
//! Commands are intentionally narrow:
//!   * `pty_spawn`   — open a PTY, spawn the shell, start the reader thread.
//!   * `pty_write`   — send bytes (keystrokes) into the PTY.
//!   * `pty_resize`  — propagate webview resize to the PTY's WINSIZE.
//!   * `pty_kill`    — kill the child + drop the session.
//!   * `detect_shells` — enumerate installed shells for the settings picker.
//!
//! Bytes flow renderer-bound as base64 strings on the
//! `pty:{session_id}:data` event channel. Base64 (rather than a JSON byte
//! array) keeps the wire ~33% larger than raw but ~5x smaller than the
//! JSON-array-of-numbers encoding Tauri would use for `Vec<u8>` — and avoids
//! UTF-8 lossiness for non-UTF-8 terminal output (legacy codepages, raw
//! escape sequences with high bytes).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Hard cap on concurrent PTY sessions. Each session holds a child process,
/// a reader thread, and the master PTY handle — call it ~5–10 MB resident.
/// 16 gives plenty of headroom for split-pane terminals and a few stale
/// entries from in-flight kills (the reader thread on Windows ConPTY can
/// take a beat to deliver EOF after a child dies) without letting a
/// runaway loop of "Open Terminal" actions exhaust the user's process
/// budget. Capacity-tracking removal now happens in pty_kill directly,
/// so the slot is freed the moment the user closes a tab.
const MAX_CONCURRENT_SESSIONS: usize = 16;

/// Default PTY dimensions when the caller doesn't pass any. xterm.js will
/// resize the moment it measures its container, so these only matter for the
/// brief window between spawn and the first `fit()`.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// State held by Tauri so that the four PTY commands can find each other's
/// sessions. The map is keyed by a session id minted by the renderer (same
/// pattern as `claude_run_query` — the renderer needs the id before any
/// event fires so it can subscribe).
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyState {
    /// Kill every live session. Called from the window-close hook so the user
    /// doesn't leave orphan shells behind when they quit the app. Best-effort
    /// — a child that already exited is silently dropped.
    #[allow(dead_code)] // wired by the app-close hook in Phase 6
    pub fn kill_all(&self) {
        let drained: Vec<Arc<PtySession>> = {
            let Ok(mut g) = self.sessions.lock() else { return };
            g.drain().map(|(_, v)| v).collect()
        };
        for session in drained {
            session.kill_silently();
        }
    }
}

/// One live PTY + its child shell. All fields are independently locked so
/// the reader thread (which holds nothing) doesn't block writers or the
/// resize path.
struct PtySession {
    /// The PTY master — needed for `resize()`. Reads and writes go through
    /// dedicated clones (see `reader` / `writer`) so the master lock is held
    /// only briefly during resize.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// The writer half of the master, cloned at spawn time. Held in a Mutex
    /// because `pty_write` is async (a tokio task) and the underlying writer
    /// is sync.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Child process handle. portable-pty's Child trait gives us `wait` +
    /// `kill_handle()`; we only need kill from the command side. The reader
    /// thread observes EOF on its own and emits the exit event.
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Flipped by `pty_kill` so the reader thread can distinguish a clean
    /// EOF (shell exited on its own) from a forced kill — useful when
    /// emitting the exit event so the UI shows "(killed)" vs an exit code.
    killed: AtomicBool,
}

impl PtySession {
    /// Best-effort kill — used by the per-session command and by the
    /// app-wide `kill_all` shutdown hook. Doesn't propagate errors because
    /// the only useful response to a kill failure is "carry on closing".
    fn kill_silently(&self) {
        self.killed.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnInput {
    /// Renderer-minted session id (UUID v4 is what the frontend uses). The
    /// event channel is `pty:{session_id}:data` / `:exit`.
    pub session_id: String,
    /// Absolute path to the shell binary. If None, we pick the platform
    /// default (pwsh → powershell → cmd on Windows; $SHELL → /bin/zsh →
    /// /bin/bash on Unix). Callers that respect the user's settings pass
    /// their preferred shell here.
    #[serde(default)]
    pub shell_path: Option<String>,
    /// Optional extra args (e.g. `-NoLogo` for pwsh, `-l` for bash). For now
    /// the frontend doesn't expose this; reserved so we can add settings
    /// without a Rust ABI break.
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Working directory for the spawned shell. Falls back to the OS-level
    /// "current dir" (which Tauri sets to the app's launch dir).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Initial PTY size — usually a guess that the frontend corrects with
    /// a `pty_resize` call as soon as xterm finishes its first measure.
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    /// Extra env to merge into the child's environment. We always set
    /// `TERM=xterm-256color` so most CLIs (claude, codex, less, vim) render
    /// colour and Unicode without further coaxing.
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    pub session_id: String,
    /// Resolved shell binary path so the frontend can show "{name} · {cwd}"
    /// without having to guess what `shell_path: None` resolved to.
    pub shell_path: String,
    /// Coarse shell kind, used by the renderer to pick a brand icon and
    /// (eventually) to format the Quick Prompts strip — e.g. PowerShell
    /// wants `& claude.exe "…"` instead of bare `claude "…"`.
    pub shell_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum PtyError {
    /// detect_shells returned no candidates and the caller didn't provide
    /// a shell_path either.
    NoShellAvailable,
    /// portable-pty refused to open a PTY or spawn the child.
    SpawnFailed { message: String },
    /// The given session_id doesn't exist (already killed, race with tab
    /// close, etc.). Safe to ignore — usually means "do nothing".
    SessionNotFound,
    /// Hit `MAX_CONCURRENT_SESSIONS` — caller should close an existing tab
    /// before opening another.
    AtCapacity { limit: usize },
    /// Generic IO error reading/writing the PTY.
    Io { message: String },
}

impl std::fmt::Display for PtyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoShellAvailable => write!(f, "no shell available on this system"),
            Self::SpawnFailed { message } => write!(f, "pty spawn failed: {message}"),
            Self::SessionNotFound => write!(f, "pty session not found"),
            Self::AtCapacity { limit } => {
                write!(f, "at capacity: {limit} concurrent terminals already open")
            }
            Self::Io { message } => write!(f, "pty io error: {message}"),
        }
    }
}

impl std::error::Error for PtyError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCandidate {
    /// Stable identifier the frontend stores in preferences (`defaultShellId`).
    /// Independent of the path so a pwsh upgrade that moves the binary
    /// doesn't break the saved preference.
    pub id: String,
    /// User-facing label, e.g. "PowerShell 7" / "Git Bash" / "zsh".
    pub label: String,
    /// Absolute path on disk. Used as the `shell_path` argument to
    /// `pty_spawn`.
    pub path: String,
    /// Coarse kind matching `PtySpawnResult::shell_kind`.
    pub kind: String,
}

/// Spawn a shell on a fresh PTY. Returns once the child has started and the
/// reader thread is running; subsequent output streams to
/// `pty:{session_id}:data` and the final exit code lands on
/// `pty:{session_id}:exit`.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    input: PtySpawnInput,
) -> Result<PtySpawnResult, PtyError> {
    // Cap-check before we open file handles. Race with a concurrent spawn is
    // possible but harmless — both callers would just get to MAX+1 briefly,
    // then the next spawn fails. We hold the lock through the insert below to
    // tighten the check.
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| PtyError::SpawnFailed { message: "session lock poisoned".into() })?;
        if sessions.len() >= MAX_CONCURRENT_SESSIONS {
            return Err(PtyError::AtCapacity { limit: MAX_CONCURRENT_SESSIONS });
        }
    }

    let resolved_shell = match input.shell_path.as_deref() {
        // Honour an explicit shell only if that binary still exists on THIS
        // device. The saved `defaultShellPath` is an absolute path captured
        // when the user picked it — a settings file carried to another
        // machine (or a different OS, or a moved binary) would otherwise
        // make spawn hard-fail with a path that means nothing here. Falling
        // through to `default_shell()` keeps the shell choice device-local:
        // each machine resolves the platform-appropriate shell that's
        // actually installed on it.
        Some(p) if !p.trim().is_empty() && std::path::Path::new(p).is_file() => {
            ResolvedShell::from_path(p)
        }
        _ => default_shell().ok_or(PtyError::NoShellAvailable)?,
    };

    let cols = input.cols.unwrap_or(DEFAULT_COLS).max(2);
    let rows = input.rows.unwrap_or(DEFAULT_ROWS).max(2);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| PtyError::SpawnFailed { message: format!("openpty: {e}") })?;

    let mut cmd = CommandBuilder::new(&resolved_shell.path);
    if let Some(extra_args) = input.args.as_ref() {
        for a in extra_args {
            cmd.arg(a);
        }
    } else {
        // Default flags per shell. We keep these conservative — anything that
        // changes behaviour in a way the user might want to disable goes via
        // a preference, not hardcoded here.
        for a in resolved_shell.default_args() {
            cmd.arg(a);
        }
    }
    if let Some(cwd) = input.cwd.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.cwd(cwd);
    }
    // Pin TERM so CLIs that probe `$TERM` (claude, codex, aider, less, vim)
    // pick a colour-capable terminfo entry instead of falling back to dumb.
    cmd.env("TERM", "xterm-256color");
    if let Some(env) = input.env.as_ref() {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| PtyError::SpawnFailed { message: format!("spawn: {e}") })?;

    // Drop the slave handle: with the slave still alive, the master's reader
    // never sees EOF when the child exits — it just hangs. Dropping the slave
    // lets the kernel notice the last writer is gone.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| PtyError::SpawnFailed { message: format!("clone_reader: {e}") })?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| PtyError::SpawnFailed { message: format!("take_writer: {e}") })?;

    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        killed: AtomicBool::new(false),
    });

    // Insert before starting the reader so a fast-exiting shell's exit event
    // can still find the session entry to clean up.
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| PtyError::SpawnFailed { message: "session lock poisoned".into() })?;
        if sessions.len() >= MAX_CONCURRENT_SESSIONS {
            return Err(PtyError::AtCapacity { limit: MAX_CONCURRENT_SESSIONS });
        }
        sessions.insert(input.session_id.clone(), Arc::clone(&session));
    }

    // The reader is a blocking `Read` — must live on its own OS thread so the
    // tokio runtime stays free. The thread owns its app/state clones and
    // tears itself down once the child exits (EOF) or the read errors out.
    let session_id = input.session_id.clone();
    let app_for_reader = app.clone();
    // Capture an AppHandle for the cleanup path so the spawn closure can
    // remove the session entry on exit without needing access to `state`
    // (which can't cross thread boundaries directly).
    std::thread::Builder::new()
        .name(format!("pty-reader-{session_id}"))
        .spawn(move || reader_loop(app_for_reader, session_id, session, reader))
        .map_err(|e| PtyError::SpawnFailed { message: format!("spawn reader: {e}") })?;

    Ok(PtySpawnResult {
        session_id: input.session_id,
        shell_path: resolved_shell.path,
        shell_kind: resolved_shell.kind.to_string(),
    })
}

/// Pump bytes from the master PTY to the renderer. Runs on a dedicated OS
/// thread (portable-pty's reader is sync). Emits `pty:{id}:data` per chunk
/// and `pty:{id}:exit` once the read loop finishes (clean EOF or error).
fn reader_loop(
    app: AppHandle,
    session_id: String,
    session: Arc<PtySession>,
    mut reader: Box<dyn Read + Send>,
) {
    let data_event = format!("pty:{session_id}:data");
    let exit_event = format!("pty:{session_id}:exit");

    // 4 KiB is the sweet spot — large enough that bulk output (cargo build
    // logs, claude streaming) doesn't fire thousands of tiny events, small
    // enough that interactive keystrokes echo without perceptible buffering.
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF — child closed its PTY end
            Ok(n) => {
                let encoded = BASE64.encode(&buf[..n]);
                // emit() is cheap (clone of the JSON value into each
                // subscribed window) but failures aren't recoverable from
                // here — if the renderer is gone, the next iteration's read
                // will EOF soon enough.
                let _ = app.emit(&data_event, serde_json::json!({ "data": encoded }));
            }
            Err(_) => break,
        }
    }

    // Wait for the child so we can report a real exit code in the event.
    // `wait()` is blocking but the read loop already ended, so we're not
    // holding anyone up.
    let exit_code: Option<i32> = {
        if let Ok(mut child) = session.child.lock() {
            child.wait().ok().and_then(|s| i32::try_from(s.exit_code()).ok())
        } else {
            None
        }
    };
    let killed = session.killed.load(Ordering::Relaxed);

    let _ = app.emit(
        &exit_event,
        serde_json::json!({
            "exitCode": exit_code,
            "killed": killed,
        }),
    );

    // Remove from the session map — the renderer is responsible for closing
    // its tab on the exit event, but holding the entry around after that
    // would just leak the (already dead) handles.
    if let Some(state) = app.try_state::<PtyState>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyWriteInput {
    pub session_id: String,
    /// Raw bytes encoded as base64. xterm.js's `onData` callback gives us a
    /// JavaScript string, but a paste of binary content (yes, people do
    /// this) can include non-UTF-8 bytes — base64 keeps that lossless.
    pub data: String,
}

/// Forward bytes to the PTY's input side. Used for every keystroke + paste
/// + Quick Prompts insert.
#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    input: PtyWriteInput,
) -> Result<(), PtyError> {
    let session = lookup_session(&state, &input.session_id)?;
    let bytes = BASE64
        .decode(input.data.as_bytes())
        .map_err(|e| PtyError::Io { message: format!("invalid base64: {e}") })?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| PtyError::Io { message: "writer lock poisoned".into() })?;
    writer
        .write_all(&bytes)
        .map_err(|e| PtyError::Io { message: e.to_string() })?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Propagate xterm's measured size to the PTY. The child shell reads WINSIZE
/// to lay out its output (line wrapping, less's `lines`/`columns`, vim's
/// redraw). Without this, anything past 80 columns wraps.
#[tauri::command]
pub async fn pty_resize(
    state: tauri::State<'_, PtyState>,
    input: PtyResizeInput,
) -> Result<(), PtyError> {
    let session = lookup_session(&state, &input.session_id)?;
    let master = session
        .master
        .lock()
        .map_err(|_| PtyError::Io { message: "master lock poisoned".into() })?;
    master
        .resize(PtySize {
            cols: input.cols.max(2),
            rows: input.rows.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtyError::Io { message: format!("resize: {e}") })?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyKillInput {
    pub session_id: String,
}

/// Kill the child shell and drop the session entry from the map.
///
/// IMPORTANT: we remove the entry from `sessions` synchronously here, not
/// later in the reader thread's post-EOF cleanup. The reader thread does
/// still run its cleanup (so a clean `exit` from the shell still works),
/// but that path is no longer the one freeing the capacity slot.
///
/// Why this matters: on Windows ConPTY, `Read::read()` on the master
/// often doesn't return EOF promptly after the child dies — sometimes it
/// hangs indefinitely. If we relied on the reader thread for removal,
/// closing 8 terminal tabs would leave 8 stale entries in the map, and
/// the 9th `pty_spawn` would hit AtCapacity even though every shell is
/// already dead. Removing here decouples the capacity bookkeeping from
/// the ConPTY EOF guarantee.
///
/// Idempotent: calling twice (or on an unknown id) is a no-op rather
/// than an error, since the renderer often races a tab close against an
/// exit event.
#[tauri::command]
pub async fn pty_kill(
    state: tauri::State<'_, PtyState>,
    input: PtyKillInput,
) -> Result<(), PtyError> {
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| PtyError::Io { message: "session lock poisoned".into() })?;
        sessions.remove(&input.session_id)
    };
    if let Some(session) = session {
        session.kill_silently();
    }
    Ok(())
}

fn lookup_session(
    state: &tauri::State<'_, PtyState>,
    session_id: &str,
) -> Result<Arc<PtySession>, PtyError> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| PtyError::Io { message: "session lock poisoned".into() })?;
    sessions
        .get(session_id)
        .cloned()
        .ok_or(PtyError::SessionNotFound)
}

// ────────────────────────────────────────────────────────────────────────
// Shell detection
// ────────────────────────────────────────────────────────────────────────

/// Probe well-known shell paths + $PATH + (on Unix) $SHELL, dedupe by
/// canonical path, and return the resulting list. Frontend renders this in
/// the settings shell-picker and stores the chosen `id` in preferences.
#[tauri::command]
pub async fn detect_shells() -> Result<Vec<ShellCandidate>, PtyError> {
    let mut out: Vec<ShellCandidate> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();

    let push = |id: &str, label: &str, kind: &str, path: PathBuf, out: &mut Vec<ShellCandidate>, seen: &mut Vec<PathBuf>| {
        let canon = std::fs::canonicalize(&path).unwrap_or(path.clone());
        if seen.iter().any(|p| p == &canon) {
            return;
        }
        seen.push(canon);
        out.push(ShellCandidate {
            id: id.into(),
            label: label.into(),
            kind: kind.into(),
            path: path.to_string_lossy().into_owned(),
        });
    };

    #[cfg(target_os = "windows")]
    {
        // PowerShell 7 (pwsh) — prefer over Windows PowerShell.
        for candidate in [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files\PowerShell\7-preview\pwsh.exe",
        ] {
            let p = PathBuf::from(candidate);
            if p.is_file() {
                push("pwsh", "PowerShell 7", "pwsh", p, &mut out, &mut seen);
            }
        }
        if let Ok(p) = which::which("pwsh.exe") {
            push("pwsh-path", "PowerShell (PATH)", "pwsh", p, &mut out, &mut seen);
        }

        // Windows PowerShell 5.1.
        let ps5 = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        if ps5.is_file() {
            push("powershell", "Windows PowerShell", "powershell", ps5, &mut out, &mut seen);
        }

        // Command Prompt.
        let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
        if cmd.is_file() {
            push("cmd", "Command Prompt", "cmd", cmd, &mut out, &mut seen);
        }

        // Git Bash — common locations.
        for candidate in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let p = PathBuf::from(candidate);
            if p.is_file() {
                push("git-bash", "Git Bash", "git-bash", p, &mut out, &mut seen);
                break;
            }
        }
    }

    #[cfg(unix)]
    {
        // $SHELL first — that's what the user already chose at the OS level.
        if let Ok(shell) = std::env::var("SHELL") {
            let p = PathBuf::from(&shell);
            if p.is_file() {
                let (label, kind) = label_for_unix_shell(&shell);
                push("user-shell", label, kind, p, &mut out, &mut seen);
            }
        }

        for (path_str, label, kind) in [
            ("/bin/zsh", "Zsh", "zsh"),
            ("/usr/bin/zsh", "Zsh", "zsh"),
            ("/bin/bash", "Bash", "bash"),
            ("/usr/bin/bash", "Bash", "bash"),
            ("/usr/local/bin/bash", "Bash (Homebrew)", "bash"),
            ("/opt/homebrew/bin/bash", "Bash (Homebrew)", "bash"),
            ("/usr/bin/fish", "Fish", "fish"),
            ("/usr/local/bin/fish", "Fish (Homebrew)", "fish"),
            ("/opt/homebrew/bin/fish", "Fish (Homebrew)", "fish"),
            ("/bin/sh", "sh", "sh"),
        ] {
            let p = PathBuf::from(path_str);
            if p.is_file() {
                push(path_str, label, kind, p, &mut out, &mut seen);
            }
        }
    }

    Ok(out)
}

#[cfg(unix)]
fn label_for_unix_shell(path: &str) -> (&'static str, &'static str) {
    let basename = std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match basename {
        "zsh" => ("Zsh ($SHELL)", "zsh"),
        "bash" => ("Bash ($SHELL)", "bash"),
        "fish" => ("Fish ($SHELL)", "fish"),
        "sh" => ("sh ($SHELL)", "sh"),
        other if !other.is_empty() => ("Your shell ($SHELL)", "other"),
        _ => ("Your shell ($SHELL)", "other"),
    }
}

// ────────────────────────────────────────────────────────────────────────
// Default-shell selection (used by pty_spawn when caller doesn't pass one).
// ────────────────────────────────────────────────────────────────────────

struct ResolvedShell {
    path: String,
    kind: &'static str,
}

impl ResolvedShell {
    fn from_path(path: &str) -> Self {
        let kind = classify_shell(path);
        Self { path: path.to_string(), kind }
    }

    /// Conservative defaults per shell kind. The goal is "behave like a
    /// normal interactive terminal" — not to inject behaviour the user
    /// didn't ask for.
    fn default_args(&self) -> Vec<&'static str> {
        match self.kind {
            // -NoLogo suppresses the PowerShell startup banner. The "real"
            // banner just delays the first prompt by ~150ms and adds noise.
            "pwsh" => vec!["-NoLogo"],
            "powershell" => vec!["-NoLogo"],
            // cmd.exe defaults to the OEM codepage (437 / 850) — most AI
            // CLIs (claude, codex) emit UTF-8 and look mangled. `/K` runs
            // the chcp command and stays interactive; `>nul` silences the
            // "Active code page: 65001" line so the user never sees it.
            "cmd" => vec!["/K", "chcp 65001 >nul"],
            // bash without -l keeps things fast (no profile sourcing for
            // git-bash means we don't hang on slow ~/.bashrc plugins).
            "git-bash" => vec!["--login", "-i"],
            // Login-interactive for zsh / bash on Unix gets the user the
            // env they expect from a terminal app (e.g. PATH from /etc/profile).
            "zsh" | "bash" => vec!["-il"],
            _ => vec![],
        }
    }
}

fn classify_shell(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with("pwsh.exe") || lower.ends_with("pwsh") {
        "pwsh"
    } else if lower.ends_with("powershell.exe") {
        "powershell"
    } else if lower.ends_with("cmd.exe") {
        "cmd"
    } else if lower.contains(r"git\bin\bash") || lower.contains(r"git\usr\bin\bash") {
        "git-bash"
    } else if lower.ends_with("zsh") {
        "zsh"
    } else if lower.ends_with("bash") || lower.ends_with("bash.exe") {
        "bash"
    } else if lower.ends_with("fish") {
        "fish"
    } else if lower.ends_with("sh") {
        "sh"
    } else {
        "other"
    }
}

/// Best-effort fallback when no shell was specified. Tries platform sensible
/// defaults in priority order. Returns None only on a truly bare system.
fn default_shell() -> Option<ResolvedShell> {
    #[cfg(target_os = "windows")]
    {
        for candidate in [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
        ] {
            if std::path::Path::new(candidate).is_file() {
                return Some(ResolvedShell::from_path(candidate));
            }
        }
        if let Ok(p) = which::which("pwsh.exe") {
            return Some(ResolvedShell::from_path(p.to_string_lossy().as_ref()));
        }
        None
    }
    #[cfg(unix)]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).is_file() {
                return Some(ResolvedShell::from_path(&shell));
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).is_file() {
                return Some(ResolvedShell::from_path(candidate));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::classify_shell;

    #[test]
    fn classifies_known_shells() {
        assert_eq!(classify_shell(r"C:\Program Files\PowerShell\7\pwsh.exe"), "pwsh");
        assert_eq!(
            classify_shell(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            "powershell"
        );
        assert_eq!(classify_shell(r"C:\Windows\System32\cmd.exe"), "cmd");
        assert_eq!(classify_shell(r"C:\Program Files\Git\bin\bash.exe"), "git-bash");
        assert_eq!(classify_shell("/bin/zsh"), "zsh");
        assert_eq!(classify_shell("/usr/local/bin/bash"), "bash");
        assert_eq!(classify_shell("/bin/sh"), "sh");
    }
}
