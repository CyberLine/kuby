use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::AppState;

const CONSENT_FILE: &str = "telemetry-consent";
const APP_IDENTIFIER: &str = "com.alexanderover.kuby";

static PANIC_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

fn sentry_client() -> sentry::ClientInitGuard {
    sentry::init(
        sentry::ClientOptions::new()
            .dsn(crate::SENTRY_DSN)
            .maybe_release(sentry::release_name!())
            .send_default_pii(false)
            .shutdown_timeout(Duration::from_secs(3)),
    )
}

/// Tokio worker threads created before `sentry::init` keep an empty Hub.
/// The default panic integration then no-ops on those threads.
fn capture_panic_for_sentry(info: &std::panic::PanicHookInfo<'_>) {
    if sentry::Hub::current().client().is_some() {
        return;
    }
    let hub = sentry::Hub::main();
    if hub.client().is_none() {
        return;
    }
    sentry::Hub::run(hub, || {
        sentry::integrations::panic::panic_handler(info);
    });
}

pub(crate) fn install_sentry_panic_hook() {
    if PANIC_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        capture_panic_for_sentry(info);
        previous(info);
    }));
}

fn consent_path_fallback() -> Option<PathBuf> {
    let base = {
        #[cfg(target_os = "macos")]
        {
            PathBuf::from(std::env::var("HOME").ok()?).join("Library/Application Support")
        }
        #[cfg(target_os = "linux")]
        {
            std::env::var("XDG_CONFIG_HOME")
                .ok()
                .map(PathBuf::from)
                .or_else(|| Some(PathBuf::from(std::env::var("HOME").ok()?).join(".config")))?
        }
        #[cfg(target_os = "windows")]
        {
            PathBuf::from(std::env::var("APPDATA").ok()?)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            return None;
        }
    };
    Some(base.join(APP_IDENTIFIER).join(CONSENT_FILE))
}

fn read_consent(path: &std::path::Path) -> Option<bool> {
    match fs::read_to_string(path) {
        Ok(value) if value.trim() == "on" => Some(true),
        Ok(value) if value.trim() == "off" => Some(false),
        _ => None,
    }
}

fn write_consent(path: &std::path::Path, enabled: bool) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, if enabled { "on" } else { "off" });
}

/// Init Sentry on the main thread before Tauri starts Tokio, so worker Hubs inherit the client.
pub(crate) fn init_sentry_from_stored_consent() -> Option<sentry::ClientInitGuard> {
    let path = consent_path_fallback()?;
    if read_consent(&path) == Some(true) {
        Some(sentry_client())
    } else {
        None
    }
}

#[tauri::command]
pub fn set_telemetry_enabled(app: AppHandle, state: State<'_, AppState>, enabled: bool) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CONSENT_FILE))
        .or_else(consent_path_fallback);
    if let Some(path) = path {
        write_consent(&path, enabled);
    }

    let mut slot = state.sentry.lock();
    if enabled {
        if slot.is_none() {
            *slot = Some(sentry_client());
        }
    } else {
        *slot = None;
    }
}
