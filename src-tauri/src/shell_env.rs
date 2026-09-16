//! Inherit login/user environment for GUI launches.
//!
//! macOS/Linux GUI apps started from Finder/Spotlight only see a minimal
//! system `PATH`. On Windows, Start Menu / Explorer launches may miss User
//! PATH entries (Scoop, Chocolatey, cargo, …). Kubernetes exec plugins
//! (`kubectl`, `aws`, `gcloud`, …) then fail with ENOENT. This module merges
//! the login shell (Unix) or registry User/Machine env (Windows) into the
//! process before any kube client is built.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;

use tracing::{debug, warn};

/// Env vars to copy from the login shell / user env when the process lacks them.
const FILL_IF_EMPTY: &[&str] = &[
    "KUBECONFIG",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "CLOUDSDK_CONFIG",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CONFIG_DIR",
    "HOMEBREW_PREFIX",
    "SSH_AUTH_SOCK",
];

/// Call once at process start, before spawning threads or building kube clients.
pub fn inherit_login_env() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        match capture_login_env() {
            Ok(env) => apply_login_env(&env),
            Err(err) => {
                warn!(error = %err, "failed to capture login-shell env; using PATH fallback");
                apply_path_fallback();
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        match capture_windows_env() {
            Ok(env) => apply_windows_env(&env),
            Err(err) => {
                warn!(error = %err, "failed to read Windows user/machine env; using PATH fallback");
                apply_path_fallback();
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn capture_login_env() -> Result<HashMap<String, String>, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    });

    // Prefer a login shell so Homebrew / asdf / nvm PATH entries appear.
    // Interactive (-i) can hang on prompts; keep a short wall-clock budget.
    let output = run_shell_env(&shell, &["-l", "-c", "env"])
        .or_else(|e| {
            debug!(error = %e, "login shell env failed; trying non-login");
            run_shell_env(&shell, &["-c", "env"])
        })
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "shell exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(parse_env_output(&output.stdout))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_shell_env(shell: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    // Soft timeout: `env` is fast when the shell profile is sane; hang on
    // interactive prompts must not block app launch.
    let mut child = Command::new(shell)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("TERM")
        .spawn()?;

    let started = std::time::Instant::now();
    let timeout = Duration::from_secs(2);
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "login shell env capture timed out",
                ));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_end(&mut stdout)?;
    }
    if let Some(mut err) = child.stderr.take() {
        err.read_to_end(&mut stderr)?;
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "windows")]
fn capture_windows_env() -> Result<HashMap<String, String>, String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let machine = hklm
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            KEY_READ,
        )
        .map_err(|e| format!("open machine Environment: {e}"))?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let user = hkcu
        .open_subkey_with_flags("Environment", KEY_READ)
        .map_err(|e| format!("open user Environment: {e}"))?;

    let machine_path =
        read_reg_string(&machine, "Path").or_else(|| read_reg_string(&machine, "PATH"));
    let user_path = read_reg_string(&user, "Path").or_else(|| read_reg_string(&user, "PATH"));
    let user_expanded = user_path.as_deref().map(expand_env_strings);
    let machine_expanded = machine_path.as_deref().map(expand_env_strings);

    let mut map = HashMap::new();
    read_reg_env_values(&user, &mut map);

    if let Some(path) = merge_path_strings(user_expanded.as_deref(), machine_expanded.as_deref()) {
        map.insert("PATH".into(), path);
    }

    // Expand remaining user values that may contain %VAR%.
    for value in map.values_mut() {
        *value = expand_env_strings(value);
    }

    Ok(map)
}

#[cfg(target_os = "windows")]
fn read_reg_string(key: &winreg::RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok()
}

#[cfg(target_os = "windows")]
fn read_reg_env_values(key: &winreg::RegKey, out: &mut HashMap<String, String>) {
    for (name, _) in key.enum_values().filter_map(Result::ok) {
        if name.is_empty() || name.eq_ignore_ascii_case("Path") {
            continue;
        }
        if let Ok(value) = key.get_value::<String, _>(&name) {
            if !value.is_empty() {
                out.insert(name, value);
            }
        }
    }
}

/// Expand `%VAR%` using the current process environment (and common profile vars).
#[cfg(target_os = "windows")]
fn expand_env_strings(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(end) = value[i + 1..].find('%') {
                let name = &value[i + 1..i + 1 + end];
                if !name.is_empty() {
                    if let Ok(val) = std::env::var(name) {
                        out.push_str(&val);
                        i += name.len() + 2;
                        continue;
                    }
                }
            }
        }
        out.push(value[i..].chars().next().unwrap_or('?'));
        i += value[i..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// Prefer `front` entries, then `back`, deduped (platform path separator).
fn merge_path_strings(front: Option<&str>, back: Option<&str>) -> Option<String> {
    match (front, back) {
        (None, None) => None,
        (Some(a), None) => Some(a.to_string()),
        (None, Some(b)) => Some(b.to_string()),
        (Some(a), Some(b)) => {
            let mut seen = HashSet::new();
            let mut parts: Vec<OsString> = Vec::new();
            for source in [a, b] {
                for part in std::env::split_paths(source) {
                    if part.as_os_str().is_empty() {
                        continue;
                    }
                    let key = part.to_string_lossy().to_lowercase();
                    if seen.insert(key) {
                        parts.push(part.into_os_string());
                    }
                }
            }
            std::env::join_paths(parts)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        }
    }
}

fn parse_env_output(stdout: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(stdout);
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            if key.is_empty() || key.contains('\0') {
                continue;
            }
            // Skip variables that can break a GUI binary if overwritten.
            if key.starts_with("DYLD_") || key == "_" {
                continue;
            }
            map.insert(key.to_string(), value.to_string());
        }
    }
    map
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn apply_login_env(shell_env: &HashMap<String, String>) {
    if let Some(shell_path) = shell_env.get("PATH") {
        merge_path(shell_path);
    } else {
        apply_path_fallback();
    }
    fill_empty_from(shell_env);
}

#[cfg(target_os = "windows")]
fn apply_windows_env(reg_env: &HashMap<String, String>) {
    if let Some(path) = reg_env.get("PATH") {
        merge_path(path);
    } else {
        apply_path_fallback();
    }
    fill_empty_from(reg_env);
    // Always layer common tool dirs in case registry PATH is stale/minimal.
    apply_path_fallback();
}

fn fill_empty_from(source: &HashMap<String, String>) {
    for key in FILL_IF_EMPTY {
        let empty = std::env::var(key).map(|v| v.is_empty()).unwrap_or(true);
        if empty {
            if let Some(value) = source.get(*key) {
                if !value.is_empty() {
                    // SAFETY: called once at process start before other threads.
                    unsafe { std::env::set_var(key, value) };
                    debug!(key, "inherited env from login/user environment");
                }
            }
        }
    }
}

fn merge_path(preferred: &str) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let current_str = current.to_string_lossy();
    let Some(merged) = merge_path_strings(Some(preferred), Some(current_str.as_ref())) else {
        return;
    };
    if merged != current_str {
        // SAFETY: called once at process start before other threads.
        unsafe { std::env::set_var("PATH", &merged) };
        debug!(path = %merged, "merged preferred PATH");
    }
}

fn apply_path_fallback() {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin"));
        candidates.push(PathBuf::from("/usr/local/bin"));
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            candidates.push(home.join(".local/bin"));
            candidates.push(home.join("bin"));
            candidates.push(home.join(".asdf/shims"));
            candidates.push(home.join(".cargo/bin"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            candidates.push(profile.join(".cargo").join("bin"));
            candidates.push(profile.join("bin"));
            candidates.push(profile.join(".local").join("bin"));
            candidates.push(profile.join("scoop").join("shims"));
        }
        candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.push(local.join("Microsoft").join("WindowsApps"));
        }
    }

    prepend_path_dirs(&candidates);
}

fn prepend_path_dirs(dirs: &[PathBuf]) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut parts: Vec<OsString> = Vec::new();

    for part in std::env::split_paths(&current) {
        if part.as_os_str().is_empty() {
            continue;
        }
        let key = part.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            parts.push(part.into_os_string());
        }
    }

    let mut inserted = 0usize;
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let key = dir.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            parts.insert(inserted, dir.as_os_str().to_os_string());
            inserted += 1;
        }
    }

    let Ok(merged) = std::env::join_paths(parts) else {
        return;
    };
    if merged != current {
        // SAFETY: called once at process start before other threads.
        unsafe { std::env::set_var("PATH", &merged) };
        debug!(path = %merged.to_string_lossy(), "applied PATH fallback directories");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_env_skips_dyld() {
        let raw = b"PATH=/a:/b\nDYLD_LIBRARY_PATH=/evil\nKUBECONFIG=/tmp/c\n";
        let map = parse_env_output(raw);
        assert_eq!(map.get("PATH").map(String::as_str), Some("/a:/b"));
        assert_eq!(map.get("KUBECONFIG").map(String::as_str), Some("/tmp/c"));
        assert!(!map.contains_key("DYLD_LIBRARY_PATH"));
    }

    #[test]
    fn merge_path_strings_prefers_front() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let front = format!("/a{sep}/b");
        let back = format!("/b{sep}/c");
        let merged = merge_path_strings(Some(&front), Some(&back)).expect("merged");
        let parts: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], Path::new("/a"));
        assert_eq!(parts[1], Path::new("/b"));
        assert_eq!(parts[2], Path::new("/c"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn expand_env_percent_vars() {
        // SAFETY: test-only mutation of a disposable var.
        unsafe { std::env::set_var("KUBY_TEST_EXPAND", "expanded") };
        let got = expand_env_strings(r"%KUBY_TEST_EXPAND%\tools");
        assert_eq!(got, r"expanded\tools");
        unsafe { std::env::remove_var("KUBY_TEST_EXPAND") };
    }
}
