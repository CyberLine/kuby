//! Inherit login-shell environment for GUI launches.
//!
//! macOS/Linux GUI apps started from Finder/Spotlight only see a minimal
//! system `PATH`. Kubernetes exec plugins (`kubectl`, `aws`, `gcloud`, …)
//! then fail with ENOENT. This module merges the login shell's PATH (and a
//! few cloud/kube vars) into the process before any kube client is built.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use tracing::{debug, warn};

/// Env vars to copy from the login shell when the current process lacks them.
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

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // Windows GUI PATH quirks are less common for kube exec plugins.
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

    for key in FILL_IF_EMPTY {
        let empty = std::env::var(key).map(|v| v.is_empty()).unwrap_or(true);
        if empty {
            if let Some(value) = shell_env.get(*key) {
                if !value.is_empty() {
                    // SAFETY: called once at process start before other threads.
                    unsafe { std::env::set_var(key, value) };
                    debug!(key, "inherited env from login shell");
                }
            }
        }
    }
}

fn merge_path(login_path: &str) {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut parts: Vec<&str> = Vec::new();

    for part in login_path.split(':').chain(current.split(':')) {
        if part.is_empty() || !seen.insert(part) {
            continue;
        }
        parts.push(part);
    }

    let merged = parts.join(":");
    if merged != current {
        // SAFETY: called once at process start before other threads.
        unsafe { std::env::set_var("PATH", &merged) };
        debug!(path = %merged, "merged login-shell PATH");
    }
}

fn apply_path_fallback() {
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home.as_ref() {
        candidates.push(home.join(".local/bin"));
        candidates.push(home.join("bin"));
        candidates.push(home.join(".asdf/shims"));
        candidates.push(home.join(".cargo/bin"));
    }

    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen: HashSet<String> = current
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let mut parts: Vec<String> = current
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    for dir in candidates {
        if !dir.is_dir() {
            continue;
        }
        let s = dir.to_string_lossy().to_string();
        if seen.insert(s.clone()) {
            // Prefer developer tools ahead of the minimal system PATH.
            parts.insert(0, s);
        }
    }

    let merged = parts.join(":");
    if merged != current {
        // SAFETY: called once at process start before other threads.
        unsafe { std::env::set_var("PATH", &merged) };
        debug!(path = %merged, "applied PATH fallback directories");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_skips_dyld() {
        let raw = b"PATH=/a:/b\nDYLD_LIBRARY_PATH=/evil\nKUBECONFIG=/tmp/c\n";
        let map = parse_env_output(raw);
        assert_eq!(map.get("PATH").map(String::as_str), Some("/a:/b"));
        assert_eq!(map.get("KUBECONFIG").map(String::as_str), Some("/tmp/c"));
        assert!(!map.contains_key("DYLD_LIBRARY_PATH"));
    }
}
