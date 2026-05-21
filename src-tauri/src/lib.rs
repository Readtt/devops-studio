mod modules;

use modules::{ado, claude, fs, git, history, net, secrets, staleness, workspace};
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
        .manage(secrets::SecretsState::default())
        .manage(claude::ClaudeState::default())
        .manage(ado::client::AdoState::default())
        .manage(staleness::StalenessState::default())
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
            ado::ado_get_case,
            ado::ado_create_case_in_suite,
            ado::ado_create_bug_and_link,
            ado::ado_create_bug,
            ado::ado_get_bug,
            ado::ado_link_bug_to_case,
            ado::ado_update_case_description,
            ado::ado_add_tag,
            ado::ado_remove_tag,
            ado::ado_list_repos,
            ado::ado_get_file,
            ado::ado_list_commits_since,
            // --- Staleness ---
            staleness::ado_scan_staleness,
            staleness::ado_acknowledge_case,
            staleness::ado_mark_for_review,
            staleness::ado_index_case_links,
            // --- Generation history ---
            history::history_save_run,
            history::history_list_runs,
            history::history_get_run,
            history::history_delete_run,
            // --- Claude Code CLI driver ---
            claude::claude_probe,
            claude::claude_run_query,
            claude::claude_setup_token,
            claude::claude_cancel_setup_token,
            // --- Source-dir git introspection ---
            git::git_repo_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
