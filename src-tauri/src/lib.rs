mod commands;
mod error;
mod k8s;
mod shell_env;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::WINDOW_SUBMENU_ID;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID};
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;

use commands::exec_cmd::ExecStdinMap;
use commands::telemetry::{init_sentry_from_stored_consent, install_sentry_panic_hook};
use k8s::ClusterManager;

const GITHUB_URL: &str = "https://github.com/CyberLine/kuby";
pub(crate) const SENTRY_DSN: &str = "https://d9e43a5ce95be19fc2f20293fa2188b4@o4510487186571264.ingest.de.sentry.io/4512055874551888";

pub struct AppState {
    pub manager: Arc<ClusterManager>,
    pub exec_stdin: ExecStdinMap,
    pub sentry: Mutex<Option<sentry::ClientInitGuard>>,
}

fn build_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = MenuItemBuilder::with_id("about", "About Kuby").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let github = MenuItemBuilder::with_id("github", "GitHub Repository").build(app)?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    #[cfg(target_os = "macos")]
    let window_submenu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    #[cfg(target_os = "macos")]
    let app_submenu = SubmenuBuilder::new(app, "Kuby")
        .item(&about)
        .separator()
        .item(&check_updates)
        .separator()
        .services()
        .separator()
        .hide_with_text("Hide Kuby")
        .hide_others()
        .show_all()
        .separator()
        .quit_with_text("Quit Kuby")
        .build()?;

    #[cfg(target_os = "macos")]
    let view_submenu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

    #[cfg(target_os = "macos")]
    let help_submenu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&github)
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let help_submenu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&about)
        .item(&check_updates)
        .separator()
        .item(&github)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        MenuBuilder::new(app)
            .item(&app_submenu)
            .item(&edit_submenu)
            .item(&view_submenu)
            .item(&window_submenu)
            .item(&help_submenu)
            .build()
    }

    #[cfg(not(target_os = "macos"))]
    {
        // GTK/Windows: predefined Window items (minimize/maximize/close) often
        // render as an empty "Window" menu — omit it; chrome handles that.
        MenuBuilder::new(app)
            .item(&edit_submenu)
            .item(&help_submenu)
            .build()
    }
}

fn install_rustls_crypto_provider() {
    // Both rustls backends are in the graph (kube=ring, sentry/reqwest=aws-lc-rs).
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before threads / kube clients: GUI launches lack shell PATH.
    shell_env::inherit_login_env();
    install_rustls_crypto_provider();
    install_sentry_panic_hook();

    let state = AppState {
        manager: Arc::new(ClusterManager::new()),
        exec_stdin: Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<Vec<u8>>>::new())),
        sentry: Mutex::new(init_sentry_from_stored_consent()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let version = app.package_info().version.to_string();
                let _ = win.set_title(&format!("Kuby {version}"));
            }
            let menu = build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "about" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("open-about", ());
                }
                "check-updates" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("check-updates", ());
                }
                "github" => {
                    if let Err(err) = app.opener().open_url(GITHUB_URL, None::<&str>) {
                        tracing::warn!("failed to open GitHub: {err}");
                    }
                }
                _ => {}
            });
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::cluster::list_contexts,
            commands::cluster::connect_cluster,
            commands::cluster::disconnect_cluster,
            commands::cluster::list_active_clusters,
            commands::cluster::test_cluster,
            commands::cluster::get_auth_info,
            commands::resources::list_api_resources,
            commands::resources::list_namespaces,
            commands::resources::create_namespace,
            commands::resources::get_resource,
            commands::resources::get_resource_yaml,
            commands::resources::apply_yaml,
            commands::resources::patch_resource_data,
            commands::resources::delete_resource,
            commands::resources::start_resource_watch,
            commands::resources::stop_resource_watch,
            commands::resources::list_resources_once,
            commands::actions::scale_workload,
            commands::actions::restart_workload,
            commands::actions::rollback_deployment,
            commands::actions::delete_pod,
            commands::actions::resource_action,
            commands::nodes::cordon_node,
            commands::nodes::uncordon_node,
            commands::nodes::drain_node,
            commands::nodes::list_node_events,
            commands::logs::start_pod_logs,
            commands::logs::stop_pod_logs,
            commands::logs::start_aggregated_logs,
            commands::exec_cmd::start_exec_session,
            commands::exec_cmd::write_exec_stdin,
            commands::exec_cmd::stop_exec_session,
            commands::portforward_cmd::start_port_forward,
            commands::portforward_cmd::stop_port_forward,
            commands::metrics_cmd::get_pod_metrics,
            commands::metrics_cmd::get_node_metrics,
            commands::metrics_cmd::get_node_stats,
            commands::diff::diff_resources,
            commands::overview::get_workload_overview,
            commands::longhorn::get_longhorn_overview,
            commands::telemetry::set_telemetry_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
