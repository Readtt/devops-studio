mod modules;

use modules::{
    ado, chat_threads, claude, confidence_store, fs, git, history, net, pty, secrets, workspace,
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

fn parse_launch_dir() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else { continue };
        if !canon.is_dir() {
            continue;
        }
        let s = canon.to_string_lossy();
        return Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    }
    None
}

/// Spawn an external text editor with the file path (and optional line range).
///
/// The user provides a command template like `code --goto {file}:{line}` or
/// `subl {file}:{line}`. Placeholders supported:
///   `{file}`     → absolute file path (preserved as one arg even on spaces)
///   `{line}`     → start line number, or "1" when none
///   `{endLine}`  → end line number, or "{line}" when no range
///
/// Splitting honors shell-style quotes so the user can pass arguments with
/// spaces (`"C:\Program Files\editor\app.exe" --goto {file}:{line}`).
#[tauri::command]
async fn open_external_editor(
    command_template: String,
    file_path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), String> {
    let template = command_template.trim();
    if template.is_empty() {
        return Err("external editor command is not configured".into());
    }
    let tokens = shell_split(template).map_err(|e| format!("invalid editor command: {e}"))?;
    if tokens.is_empty() {
        return Err("external editor command is empty after parsing".into());
    }
    let line = start_line.unwrap_or(1).to_string();
    let end = end_line.unwrap_or_else(|| start_line.unwrap_or(1)).to_string();
    // Normalize separators so paths joined from a Windows source root +
    // POSIX relative segments don't trip up editors that key off the
    // native separator (vim, VS, anything that maps file URIs internally).
    let file_native = normalize_path_separators(&file_path);
    let mut iter = tokens.into_iter();
    let program = iter.next().expect("len > 0");
    let mut args: Vec<String> = Vec::new();
    for raw in iter {
        let substituted = raw
            .replace("{file}", &file_native)
            .replace("{line}", &line)
            .replace("{endLine}", &end);
        args.push(substituted);
    }
    // If the template never referenced {file}, default-append it. The user's
    // shorthand "code" or "subl" should still open the file.
    if !template.contains("{file}") {
        args.push(file_native.clone());
    }
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    #[cfg(windows)]
    {
        // Without this, GUI editors launched from Tauri flash a cmd.exe
        // window for a split second. 0x0800_0000 = CREATE_NO_WINDOW.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to launch '{}': {e}", program))?;
    Ok(())
}

/// Open the OS file manager focused on the given file (Explorer / Finder /
/// xdg). Distinct from `open_external_editor` because this isn't a text
/// editor invocation — it reveals the file in its containing folder.
#[tauri::command]
async fn reveal_in_file_manager(file_path: String) -> Result<(), String> {
    // Normalize separators first. Paths coming from the analyst / bug
    // pipeline often mix backslashes and forward slashes — joining a
    // Windows source root with POSIX-style relative paths produces things
    // like `C:\Users\me\repo/src/file.ts`. Most OS tools accept the
    // platform's native separators only; explorer.exe in particular
    // silently falls back to the user home directory when the path is
    // malformed.
    let normalized = normalize_path_separators(&file_path);

    #[cfg(target_os = "windows")]
    {
        // explorer.exe /select,<path> requires Windows backslashes AND no
        // space after the comma. We pass them as a single argument so
        // Rust doesn't quote the path (which would also confuse explorer).
        let arg = format!("/select,{}", normalized);
        std::process::Command::new("explorer.exe")
            .raw_arg(&arg)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("explorer.exe failed: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&normalized)
            .spawn()
            .map_err(|e| format!("open -R failed: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        // No portable "reveal" — fall back to opening the containing dir.
        let parent = std::path::Path::new(&normalized)
            .parent()
            .ok_or_else(|| format!("no parent directory for {normalized}"))?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

/// Normalize path separators to the platform's native form. Strips a
/// trailing slash too — explorer.exe interprets a trailing separator on
/// `/select,<dir>\` as "open this directory, don't select anything".
fn normalize_path_separators(p: &str) -> String {
    if cfg!(target_os = "windows") {
        // Collapse repeated slashes and unify on backslash.
        let unified: String = p.chars().map(|c| if c == '/' { '\\' } else { c }).collect();
        // Squash duplicate backslashes that may come from naive joins
        // ("C:\repo\\src\\file" → "C:\repo\src\file"). UNC paths
        // (starting with \\) are preserved by leaving the first pair
        // intact.
        let mut out = String::with_capacity(unified.len());
        let mut prev_back = false;
        for (i, ch) in unified.chars().enumerate() {
            if ch == '\\' {
                if prev_back {
                    // Only allow the very first \\… for UNC. Otherwise drop.
                    if i == 1 {
                        out.push(ch);
                    }
                } else {
                    out.push(ch);
                }
                prev_back = true;
            } else {
                out.push(ch);
                prev_back = false;
            }
        }
        // Drop a trailing backslash (explorer.exe quirk).
        if out.ends_with('\\') && out.len() > 1 {
            out.pop();
        }
        out
    } else {
        // POSIX — unify on forward slash and collapse duplicates.
        let unified: String = p.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
        let mut out = String::with_capacity(unified.len());
        let mut prev_slash = false;
        for ch in unified.chars() {
            if ch == '/' {
                if !prev_slash {
                    out.push(ch);
                }
                prev_slash = true;
            } else {
                out.push(ch);
                prev_slash = false;
            }
        }
        out
    }
}

/// Shell-style argument splitter. Honors single/double quotes so a path
/// with spaces can be quoted in the template. Backslash escapes the next
/// char outside quotes; inside double quotes, backslash escapes only
/// `"` and `\`. Returns an error on an unterminated quote.
fn shell_split(input: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                buf.push(c);
            }
            continue;
        }
        if in_double {
            if c == '"' {
                in_double = false;
            } else if c == '\\' {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        buf.push(chars.next().unwrap());
                        continue;
                    }
                }
                buf.push('\\');
            } else {
                buf.push(c);
            }
            continue;
        }
        match c {
            ' ' | '\t' => {
                if !buf.is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
            }
            '\'' => in_single = true,
            '"' => in_double = true,
            '\\' => {
                if let Some(&next) = chars.peek() {
                    if next == ' ' || next == '\t' || next == '"' || next == '\'' || next == '\\' {
                        buf.push(chars.next().unwrap());
                        continue;
                    }
                }
                buf.push('\\');
            }
            _ => buf.push(c),
        }
    }
    if in_single || in_double {
        return Err("unterminated quote".into());
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    Ok(out)
}

#[cfg(test)]
mod shell_split_tests {
    use super::shell_split;

    #[test]
    fn splits_simple_args() {
        assert_eq!(
            shell_split("code --goto {file}:{line}").unwrap(),
            vec!["code", "--goto", "{file}:{line}"]
        );
    }

    #[test]
    fn keeps_quoted_path_with_spaces() {
        assert_eq!(
            shell_split(r#""C:\Program Files\App\app.exe" --goto {file}:{line}"#).unwrap(),
            vec![r"C:\Program Files\App\app.exe", "--goto", "{file}:{line}"]
        );
    }

    #[test]
    fn unterminated_quote_errors() {
        assert!(shell_split(r#"code "unterminated"#).is_err());
    }
}

#[cfg(test)]
mod normalize_path_tests {
    use super::normalize_path_separators;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_unifies_mixed_separators() {
        let input = r"C:\Users\me\source/repos\proj/src/file.ts";
        assert_eq!(
            normalize_path_separators(input),
            r"C:\Users\me\source\repos\proj\src\file.ts"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_collapses_duplicate_backslashes() {
        assert_eq!(
            normalize_path_separators(r"C:\repo\\src\\file"),
            r"C:\repo\src\file"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_preserves_unc_prefix() {
        assert_eq!(
            normalize_path_separators(r"\\server\share\file.txt"),
            r"\\server\share\file.txt"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_drops_trailing_separator() {
        assert_eq!(
            normalize_path_separators(r"C:\Users\me\repo\"),
            r"C:\Users\me\repo"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn posix_unifies_mixed_separators() {
        assert_eq!(
            normalize_path_separators(r"/home/me\src/file.ts"),
            "/home/me/src/file.ts"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn posix_collapses_duplicate_slashes() {
        assert_eq!(
            normalize_path_separators("/home//me///file"),
            "/home/me/file"
        );
    }
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("devops-studio:settings-tab", t);
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(720.0, 520.0)
        .min_inner_size(720.0, 520.0)
        .max_inner_size(720.0, 520.0)
        .resizable(false)
        .visible(false)
        // No always_on_top: with editor/terminal gone, the historical reason
        // for pinning settings above everything (#33) no longer applies, and
        // pinning it above unrelated OS windows is more disruptive than
        // useful.
        .always_on_top(false);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    let _ = window;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    workspace::init_launch_cwd();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(secrets::SecretsState::default())
        .manage(claude::ClaudeState::default())
        .manage(pty::PtyState::default())
        .manage(ado::client::AdoState::default())
        .manage(chat_threads::ChatThreadsState::default())
        .manage(confidence_store::ConfidenceStoreState::default())
        .setup(|app| {
            // Hydrate the in-memory ADO connection state from disk + keychain.
            // Non-blocking; failures (e.g. first run with no settings) are
            // expected and silent.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = handle.try_state::<ado::client::AdoState>() {
                    ado::hydrate(&handle, &state).await;
                }
            });

            // Kill all live PTYs when the main window goes away. Without
            // this, a user closing the app with terminal tabs open leaves
            // orphan shell processes behind — fine on Unix where they
            // reparent to init, but Windows holds the cmd/pwsh process
            // alive until the user finds them in Task Manager.
            if let Some(main) = app.get_webview_window("main") {
                let pty_handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. }
                            | tauri::WindowEvent::Destroyed
                    ) {
                        if let Some(state) =
                            pty_handle.try_state::<pty::PtyState>()
                        {
                            state.kill_all();
                        }
                    }
                });
            }
            Ok(())
        })
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            registry
        })
        .manage(LaunchDir(Mutex::new(parse_launch_dir())))
        .invoke_handler(tauri::generate_handler![
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_read_file_b64,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            open_settings_window,
            open_external_editor,
            reveal_in_file_manager,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            // --- Azure DevOps ---
            ado::ado_set_connection,
            ado::ado_get_connection,
            ado::ado_test_connection,
            ado::ado_clear_pat,
            ado::ado_list_projects,
            ado::ado_list_plans,
            ado::ado_list_suites,
            ado::ado_list_suite_cases,
            ado::ado_create_suite,
            ado::ado_update_suite_name,
            ado::ado_update_plan_name,
            ado::ado_get_case,
            ado::ado_list_test_points,
            ado::ado_list_suites_for_case,
            ado::ado_set_test_point_outcome,
            ado::ado_create_case_in_suite,
            ado::ado_delete_test_case,
            ado::ado_create_bug_and_link,
            ado::ado_create_bug,
            ado::ado_get_bug,
            ado::ado_list_bugs,
            ado::ado_list_work_items,
            ado::ado_get_work_item_ref,
            ado::ado_update_bug,
            ado::ado_delete_bug,
            ado::ado_get_work_item_titles,
            ado::ado_link_bug_to_case,
            ado::ado_update_case_description,
            ado::ado_update_work_item_title,
            ado::ado_update_case_steps,
            ado::ado_add_tag,
            ado::ado_remove_tag,
            ado::ado_list_repos,
            ado::ado_get_file,
            ado::ado_list_commits_since,
            ado::ado_list_branches,
            ado::ado_list_recent_commits,
            ado::ado_diff_commit,
            ado::ado_diff_branches,
            ado::ado_list_pull_requests,
            ado::ado_diff_pull_request,
            // --- Chat threads (suite chat persistence) ---
            chat_threads::chat_threads_save,
            chat_threads::chat_threads_get,
            chat_threads::chat_threads_delete,
            chat_threads::chat_threads_delete_suite,
            chat_threads::chat_threads_list,
            chat_threads::chat_threads_list_for_suite,
            confidence_store::confidence_save,
            confidence_store::confidence_get,
            confidence_store::confidence_get_many,
            // --- Generation history ---
            history::history_save_run,
            history::history_list_runs,
            history::history_get_run,
            history::history_delete_run,
            // --- Claude Code CLI driver ---
            claude::claude_probe,
            claude::claude_run_query,
            claude::claude_cancel_run,
            claude::claude_setup_token,
            claude::claude_cancel_setup_token,
            claude::claude_check_auth,
            // --- Source-dir git introspection ---
            git::git_repo_info,
            git::git_diff,
            git::git_branch_list,
            // --- PTY / embedded terminal ---
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::detect_shells,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
