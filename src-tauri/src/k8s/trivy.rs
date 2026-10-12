//! Local Trivy CLI integration for container image vulnerability scans.

use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{KubyError, Result};

const MAX_VULNS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrivyCliInfo {
    pub available: bool,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrivySeverityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrivyVulnerability {
    pub id: String,
    pub severity: String,
    pub pkg_name: String,
    pub installed_version: String,
    pub fixed_version: String,
    pub title: String,
    pub primary_url: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrivyScanResult {
    /// Image reference requested by the UI (tag or digest).
    pub image: String,
    /// Reference actually passed to Trivy (may prefer digest from imageID).
    pub scanned_image: String,
    pub counts: TrivySeverityCounts,
    pub vulnerabilities: Vec<TrivyVulnerability>,
    /// True when more vulns exist than returned in `vulnerabilities`.
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct TrivyVersionJson {
    #[serde(rename = "Version")]
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrivyReport {
    #[serde(rename = "ArtifactName")]
    artifact_name: Option<String>,
    #[serde(rename = "Results")]
    results: Option<Vec<TrivyResult>>,
}

#[derive(Debug, Deserialize)]
struct TrivyResult {
    #[serde(rename = "Target")]
    target: Option<String>,
    #[serde(rename = "Vulnerabilities")]
    vulnerabilities: Option<Vec<TrivyVulnRaw>>,
}

#[derive(Debug, Deserialize)]
struct TrivyVulnRaw {
    #[serde(rename = "VulnerabilityID")]
    vulnerability_id: Option<String>,
    #[serde(rename = "Severity")]
    severity: Option<String>,
    #[serde(rename = "PkgName")]
    pkg_name: Option<String>,
    #[serde(rename = "InstalledVersion")]
    installed_version: Option<String>,
    #[serde(rename = "FixedVersion")]
    fixed_version: Option<String>,
    #[serde(rename = "Title")]
    title: Option<String>,
    #[serde(rename = "PrimaryURL")]
    primary_url: Option<String>,
}

pub fn cli_available() -> TrivyCliInfo {
    match Command::new("trivy")
        .args(["version", "--format", "json"])
        .output()
    {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let version = serde_json::from_str::<TrivyVersionJson>(&stdout)
                .ok()
                .and_then(|v| v.version)
                .or_else(|| parse_version_text(&stdout))
                .filter(|v| !v.is_empty());
            TrivyCliInfo {
                available: true,
                version,
                message: None,
            }
        }
        Ok(out) => {
            // Older builds may not support `version --format json`.
            match Command::new("trivy").args(["--version"]).output() {
                Ok(fallback) if fallback.status.success() => {
                    let text = String::from_utf8_lossy(&fallback.stdout);
                    TrivyCliInfo {
                        available: true,
                        version: parse_version_text(&text),
                        message: None,
                    }
                }
                _ => {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    TrivyCliInfo {
                        available: false,
                        version: None,
                        message: Some(if err.is_empty() {
                            "trivy returned a non-zero exit code".into()
                        } else {
                            err
                        }),
                    }
                }
            }
        }
        Err(e) => TrivyCliInfo {
            available: false,
            version: None,
            message: Some(format!("trivy CLI not found: {e}")),
        },
    }
}

/// Scan a container image with the local Trivy CLI (`trivy image --format json`).
///
/// `image_id` is the optional Kubernetes `containerStatuses[].imageID` and is
/// preferred when it contains a registry digest reference.
pub fn scan_image(image: &str, image_id: Option<&str>) -> Result<TrivyScanResult> {
    validate_image_ref(image)?;
    if let Some(id) = image_id {
        if !id.is_empty() {
            validate_image_ref(id)?;
        }
    }

    let scanned = preferred_scan_ref(image, image_id);
    validate_image_ref(&scanned)?;

    let output = Command::new("trivy")
        .args([
            "image",
            "--scanners",
            "vuln",
            "--format",
            "json",
            "--quiet",
            "--",
            &scanned,
        ])
        .output()
        .map_err(|e| {
            KubyError::Message(format!(
                "failed to run trivy: {e}. Install the Trivy CLI and ensure it is on PATH."
            ))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            // Trivy occasionally writes errors to stdout.
            stdout
        } else {
            format!("trivy image failed for {scanned}")
        };
        return Err(KubyError::Message(msg));
    }

    if stdout.is_empty() {
        return Err(KubyError::Message(
            "trivy returned empty output (is the vulnerability DB ready?)".into(),
        ));
    }

    parse_report(image, &scanned, &stdout)
}

fn parse_report(image: &str, scanned: &str, json: &str) -> Result<TrivyScanResult> {
    // Tolerate leading progress noise if --quiet was ignored by an older build.
    let json_start = json
        .find('{')
        .ok_or_else(|| KubyError::Message("trivy output did not contain JSON".into()))?;
    let report: TrivyReport = serde_json::from_str(&json[json_start..])
        .map_err(|e| KubyError::Message(format!("failed to parse trivy JSON: {e}")))?;

    let mut vulns = Vec::new();
    for result in report.results.unwrap_or_default() {
        let target = result.target.unwrap_or_default();
        for raw in result.vulnerabilities.unwrap_or_default() {
            let id = raw.vulnerability_id.unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            vulns.push(TrivyVulnerability {
                id,
                severity: raw.severity.unwrap_or_else(|| "UNKNOWN".into()),
                pkg_name: raw.pkg_name.unwrap_or_default(),
                installed_version: raw.installed_version.unwrap_or_default(),
                fixed_version: raw.fixed_version.unwrap_or_default(),
                title: raw.title.unwrap_or_default(),
                primary_url: raw.primary_url.filter(|u| !u.is_empty()),
                target: target.clone(),
            });
        }
    }

    vulns.sort_by(|a, b| {
        severity_rank(&a.severity)
            .cmp(&severity_rank(&b.severity))
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.pkg_name.cmp(&b.pkg_name))
    });

    let counts = count_severities(&vulns);
    let truncated = vulns.len() > MAX_VULNS;
    vulns.truncate(MAX_VULNS);

    let _ = report.artifact_name; // used for schema awareness / future UI
    Ok(TrivyScanResult {
        image: image.to_string(),
        scanned_image: scanned.to_string(),
        counts,
        vulnerabilities: vulns,
        truncated,
    })
}

fn count_severities(vulns: &[TrivyVulnerability]) -> TrivySeverityCounts {
    let mut counts = TrivySeverityCounts {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
        total: vulns.len() as u32,
    };
    for v in vulns {
        match v.severity.to_ascii_uppercase().as_str() {
            "CRITICAL" => counts.critical += 1,
            "HIGH" => counts.high += 1,
            "MEDIUM" => counts.medium += 1,
            "LOW" => counts.low += 1,
            _ => counts.unknown += 1,
        }
    }
    counts
}

fn severity_rank(severity: &str) -> u8 {
    match severity.to_ascii_uppercase().as_str() {
        "CRITICAL" => 0,
        "HIGH" => 1,
        "MEDIUM" => 2,
        "LOW" => 3,
        _ => 4,
    }
}

/// Prefer a digest-qualified registry ref from Kubernetes imageID when present.
pub fn preferred_scan_ref(image: &str, image_id: Option<&str>) -> String {
    if let Some(id) = image_id {
        if let Some(digest_ref) = extract_digest_ref(id) {
            return digest_ref;
        }
    }
    image.trim().to_string()
}

fn extract_digest_ref(image_id: &str) -> Option<String> {
    let stripped = image_id
        .strip_prefix("docker-pullable://")
        .or_else(|| image_id.strip_prefix("docker-pullable:"))
        .or_else(|| image_id.strip_prefix("docker://"))
        .unwrap_or(image_id)
        .trim();
    if stripped.contains("@sha256:") && !stripped.starts_with("sha256:") {
        Some(stripped.to_string())
    } else {
        None
    }
}

fn parse_version_text(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Version:") {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    // JSON may have been partially parsed; try Value fallback.
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) {
        if let Some(Value::String(v)) = map.get("Version") {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
    }
    None
}

/// Reject empty / flag-like / whitespace image refs to avoid CLI injection.
fn validate_image_ref(value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() || value == "—" || value.len() > 512 {
        return Err(KubyError::Message("invalid image reference".into()));
    }
    if value.starts_with('-') {
        return Err(KubyError::Message(
            "invalid image reference: must not start with '-'".into(),
        ));
    }
    if value.chars().any(|c| c.is_whitespace() || c == '\0') {
        return Err(KubyError::Message(
            "invalid image reference: whitespace not allowed".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_digest_from_image_id() {
        let image = "nginx:1.25";
        let id = "docker-pullable://nginx@sha256:abcdef";
        assert_eq!(preferred_scan_ref(image, Some(id)), "nginx@sha256:abcdef");
    }

    #[test]
    fn falls_back_to_tag_for_local_image_id() {
        let image = "nginx:1.25";
        let id = "containerd://sha256:abcdef";
        assert_eq!(preferred_scan_ref(image, Some(id)), "nginx:1.25");
    }

    #[test]
    fn rejects_flag_like_image() {
        assert!(validate_image_ref("--help").is_err());
        assert!(validate_image_ref("nginx:latest").is_ok());
    }

    #[test]
    fn parses_minimal_report() {
        let json = r#"{
          "SchemaVersion": 2,
          "ArtifactName": "alpine:3.20",
          "Results": [{
            "Target": "alpine:3.20 (alpine 3.20.3)",
            "Vulnerabilities": [{
              "VulnerabilityID": "CVE-2024-1",
              "Severity": "HIGH",
              "PkgName": "openssl",
              "InstalledVersion": "1.0",
              "FixedVersion": "1.1",
              "Title": "example",
              "PrimaryURL": "https://example.com"
            }]
          }]
        }"#;
        let result = parse_report("alpine:3.20", "alpine:3.20", json).unwrap();
        assert_eq!(result.counts.total, 1);
        assert_eq!(result.counts.high, 1);
        assert_eq!(result.vulnerabilities[0].id, "CVE-2024-1");
    }
}
