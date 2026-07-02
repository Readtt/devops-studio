//! Git executable resolution + install detection.
//!
//! A GUI-launched desktop app does NOT inherit the user's shell PATH, so a bare
//! `Command::new("git")` fails on machines where git is only reachable via a
//! login shell (Homebrew `/opt/homebrew/bin`, `/usr/local/bin`) or was just
//! installed on Windows (PATH is read at process start, so a fresh install isn't
//! visible until restart). We therefore resolve an ABSOLUTE git path: on macOS
//! the well-known install locations are probed before PATH (PATH's git is often
//! Apple's `/usr/bin/git` stub), while everywhere else PATH is tried first so a
//! git the user deliberately put on PATH wins, with the install locations as the
//! fallback. Every git spawn in the app routes through `git_program()`.
//!
//! `git_check_installed` is the careful, execution-based probe used by the
//! "Get source code" wizard to decide whether to show the clone form or install
//! guidance; `git_program()` is the cheap path-only resolver used on the hot
//! path (the status-bar poller, clone, checkout, pull).

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::modules::git::hide_console;

const STORE_PATH: &str = "devops-studio-settings.json";
/// Store key for the user's manual "Locate git…" override (VS Code's `git.path`).
const KEY_GIT_PATH: &str = "git.path";

/// User-set override path (hydrated from the store at startup, updated by
/// `git_set_path`). When set and present on disk it wins over auto-detection.
fn override_slot() -> &'static RwLock<Option<PathBuf>> {
    static SLOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// Cache of the last successfully-located git path so the hot path doesn't
/// re-probe the filesystem on every git invocation. Only ever holds a real
/// location (never the `"git"` fallback), and is cleared on override change.
fn located_cache() -> &'static RwLock<Option<PathBuf>> {
    static CACHE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn invalidate_cache() {
    if let Ok(mut g) = located_cache().write() {
        *g = None;
    }
}

/// Standard absolute install locations, probed as one half of
/// `resolve_git_path` (before PATH on macOS, after PATH elsewhere). The macOS
/// list deliberately omits `/usr/bin/git` — Apple's stub — leaving it to the
/// PATH fallback so a real Homebrew install is preferred; the Windows list
/// covers a default-location install a stale PATH wouldn't surface until restart.
fn candidate_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut v = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(base) = std::env::var(var) {
                v.push(PathBuf::from(base).join("Git\\cmd\\git.exe"));
            }
        }
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(base).join("Programs\\Git\\cmd\\git.exe"));
        }
        v
    }
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/opt/homebrew/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
        ]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("/usr/local/bin/git"),
            PathBuf::from("/usr/bin/git"),
        ]
    }
}

/// Resolve git's path. Order: override → then, on macOS, install locations →
/// PATH; everywhere else PATH → install locations. `None` when git can't be
/// found at all. Pure path resolution — never executes git.
fn resolve_git_path() -> Option<PathBuf> {
    if let Some(p) = override_slot().read().ok().and_then(|g| g.clone()) {
        if p.exists() {
            return Some(p);
        }
    }

    let from_candidates = || candidate_paths().into_iter().find(|c| c.exists());
    let from_path = || which::which("git").ok();

    // macOS: install locations beat PATH, because PATH's `git` is often Apple's
    // `/usr/bin/git` stub. Everywhere else PATH wins so a git the user
    // deliberately put on PATH (portable/scoop/winget) is honored; the standard
    // install locations are the fallback for a GUI launch that didn't inherit
    // the shell PATH, or a fresh Windows install not yet visible on PATH.
    if cfg!(target_os = "macos") {
        from_candidates().or_else(from_path)
    } else {
        from_path().or_else(from_candidates)
    }
}

/// Cached resolve. `git_check_installed` invalidates first so "Check again"
/// reflects reality after an install.
pub(crate) fn locate_git() -> Option<PathBuf> {
    if let Some(p) = located_cache().read().ok().and_then(|g| g.clone()) {
        return Some(p);
    }
    let found = resolve_git_path();
    if let Some(ref p) = found {
        if let Ok(mut g) = located_cache().write() {
            *g = Some(p.clone());
        }
    }
    found
}

/// The git program to spawn for any git operation. Falls back to the bare
/// `"git"` name when nothing is located (the spawn then fails with a clear
/// error, and detection surfaces install guidance).
pub(crate) fn git_program() -> OsString {
    locate_git()
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| OsString::from("git"))
}

// ── Detection command ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstalled {
    /// git is present and `--version` succeeded.
    pub installed: bool,
    /// A git path was found but it isn't usable — e.g. the macOS `/usr/bin/git`
    /// stub without the Command Line Tools, or a `--version` that failed. The UI
    /// shows install guidance for this just like `installed:false`.
    pub present_but_broken: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn git_check_installed() -> Result<GitInstalled, String> {
    // Re-probe from scratch so the wizard's "Check again" reflects a just-completed
    // install rather than a cached miss.
    invalidate_cache();
    tauri::async_runtime::spawn_blocking(probe_git)
        .await
        .map_err(|e| format!("git_check_installed join: {e}"))
}

fn probe_git() -> GitInstalled {
    let Some(path) = locate_git() else {
        return GitInstalled {
            installed: false,
            present_but_broken: false,
            version: None,
            path: None,
        };
    };
    let path_str = path.display().to_string();

    // macOS: `/usr/bin/git` is an Apple stub that pops a GUI installer dialog the
    // moment it's invoked without the Command Line Tools. Gate it behind a
    // non-invasive `xcode-select -p` check so a background probe never triggers
    // that popup.
    #[cfg(target_os = "macos")]
    {
        if path == PathBuf::from("/usr/bin/git") && !xcode_clt_present() {
            return GitInstalled {
                installed: false,
                present_but_broken: true,
                version: None,
                path: Some(path_str),
            };
        }
    }

    match run_version(path.as_os_str()) {
        Some(version) => GitInstalled {
            installed: true,
            present_but_broken: false,
            version: Some(version),
            path: Some(path_str),
        },
        None => GitInstalled {
            installed: false,
            present_but_broken: true,
            version: None,
            path: Some(path_str),
        },
    }
}

#[cfg(target_os = "macos")]
fn xcode_clt_present() -> bool {
    Command::new("xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Run `<path> --version`, bounded by a timeout so a wedged override path can't
/// hang the probe. Returns the parsed version string on success.
fn run_version(path: &OsStr) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(5) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let trimmed = raw.trim();
    let version = trimmed.strip_prefix("git version ").unwrap_or(trimmed).trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

// ── Manual override command ─────────────────────────────────────────────

/// Persist (or clear, when `path` is null/blank) the manual git-path override,
/// then re-probe. The wizard's "Locate git…" file picker calls this.
#[tauri::command]
pub async fn git_set_path(app: AppHandle, path: Option<String>) -> Result<GitInstalled, String> {
    let cleaned = path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    match &cleaned {
        Some(p) => store.set(KEY_GIT_PATH, serde_json::Value::String(p.clone())),
        None => {
            store.delete(KEY_GIT_PATH);
        }
    }
    store.save().map_err(|e| e.to_string())?;

    if let Ok(mut g) = override_slot().write() {
        *g = cleaned.map(PathBuf::from);
    }
    invalidate_cache();

    tauri::async_runtime::spawn_blocking(probe_git)
        .await
        .map_err(|e| format!("git_set_path join: {e}"))
}

/// Load the persisted git-path override into memory. Called once at startup.
pub fn hydrate(app: &AppHandle) {
    let override_path = app.store(STORE_PATH).ok().and_then(|store| {
        store
            .get(KEY_GIT_PATH)
            .and_then(|v| v.as_str().map(str::to_string))
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
    });
    if let Ok(mut g) = override_slot().write() {
        *g = override_path;
    }
    invalidate_cache();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_paths_are_absolute() {
        for p in candidate_paths() {
            assert!(p.is_absolute(), "{p:?} should be absolute");
        }
    }

    #[test]
    fn locate_git_resolves_on_ci() {
        // CI always has git on PATH; this asserts the resolver finds *something*
        // and that git_program never returns an empty program name.
        assert!(!git_program().is_empty());
    }
}
