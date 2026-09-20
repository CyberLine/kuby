//! Classic Helm 3 release storage: Secrets with type `helm.sh/release.v1`.

use std::collections::HashMap;
use std::io::Read;
use std::process::Command;

use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{kube_is_forbidden, kube_is_not_found, KubyError, Result};
use crate::k8s::ClusterManager;

const HELM_SECRET_TYPE: &str = "helm.sh/release.v1";
const HELM_OWNER_LABEL: &str = "owner=helm";
const FLUX_RECONCILE_ANNOTATION: &str = "reconcile.fluxcd.io/requestedAt";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseSummary {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseRevision {
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub updated: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseDetail {
    #[serde(flatten)]
    pub summary: HelmReleaseSummary,
    pub description: String,
    pub values_yaml: String,
    pub history: Vec<HelmReleaseRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmCliInfo {
    pub available: bool,
    pub version: Option<String>,
    pub message: Option<String>,
}

struct ParsedRelease {
    name: String,
    namespace: String,
    revision: i64,
    status: String,
    chart: String,
    app_version: String,
    updated: String,
    description: String,
    config: Value,
}

/// List latest Helm release revision per (namespace, name).
pub async fn list_releases(
    manager: &ClusterManager,
    context: &str,
    namespaces: &[String],
) -> Result<Vec<HelmReleaseSummary>> {
    let secrets = list_helm_secrets(manager, context, namespaces).await?;
    let mut best: HashMap<(String, String), ParsedRelease> = HashMap::new();

    for secret in &secrets {
        let Some(parsed) = parse_secret(secret) else {
            continue;
        };
        let key = (parsed.namespace.clone(), parsed.name.clone());
        match best.get(&key) {
            Some(existing) if existing.revision >= parsed.revision => {}
            _ => {
                best.insert(key, parsed);
            }
        }
    }

    let mut out: Vec<HelmReleaseSummary> = best
        .into_values()
        .map(|p| HelmReleaseSummary {
            name: p.name,
            namespace: p.namespace,
            revision: p.revision,
            status: p.status,
            chart: p.chart,
            app_version: p.app_version,
            updated: p.updated,
        })
        .collect();
    out.sort_by(|a, b| a.namespace.cmp(&b.namespace).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Detail + history for one release.
pub async fn get_release(
    manager: &ClusterManager,
    context: &str,
    namespace: &str,
    name: &str,
) -> Result<HelmReleaseDetail> {
    let secrets = list_helm_secrets(manager, context, &[namespace.to_string()]).await?;
    let mut revisions: Vec<ParsedRelease> = secrets
        .iter()
        .filter_map(parse_secret)
        .filter(|p| p.namespace == namespace && p.name == name)
        .collect();

    if revisions.is_empty() {
        return Err(KubyError::Message(format!(
            "Helm release {namespace}/{name} not found"
        )));
    }

    revisions.sort_by_key(|a| std::cmp::Reverse(a.revision));
    let latest = &revisions[0];
    let history: Vec<HelmReleaseRevision> = revisions
        .iter()
        .map(|p| HelmReleaseRevision {
            revision: p.revision,
            status: p.status.clone(),
            chart: p.chart.clone(),
            app_version: p.app_version.clone(),
            updated: p.updated.clone(),
            description: p.description.clone(),
        })
        .collect();

    let values_yaml = match serde_yaml::to_string(&latest.config) {
        Ok(s) if s.trim() == "---" || s.trim().is_empty() || s.trim() == "{}" => String::new(),
        Ok(s) => s,
        Err(_) => String::new(),
    };

    Ok(HelmReleaseDetail {
        summary: HelmReleaseSummary {
            name: latest.name.clone(),
            namespace: latest.namespace.clone(),
            revision: latest.revision,
            status: latest.status.clone(),
            chart: latest.chart.clone(),
            app_version: latest.app_version.clone(),
            updated: latest.updated.clone(),
        },
        description: latest.description.clone(),
        values_yaml,
        history,
    })
}

pub fn cli_available() -> HelmCliInfo {
    match Command::new("helm").args(["version", "--short"]).output() {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            HelmCliInfo {
                available: true,
                version: if version.is_empty() {
                    None
                } else {
                    Some(version)
                },
                message: None,
            }
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            HelmCliInfo {
                available: false,
                version: None,
                message: Some(if err.is_empty() {
                    "helm returned a non-zero exit code".into()
                } else {
                    err
                }),
            }
        }
        Err(e) => HelmCliInfo {
            available: false,
            version: None,
            message: Some(format!("helm CLI not found: {e}")),
        },
    }
}

pub fn uninstall(context: &str, namespace: &str, name: &str) -> Result<String> {
    validate_context(context)?;
    validate_ident("namespace", namespace)?;
    validate_ident("release", name)?;
    run_helm(&[
        "uninstall",
        name,
        "-n",
        namespace,
        "--kube-context",
        context,
    ])
}

pub fn rollback(
    context: &str,
    namespace: &str,
    name: &str,
    revision: Option<i64>,
) -> Result<String> {
    validate_context(context)?;
    validate_ident("namespace", namespace)?;
    validate_ident("release", name)?;
    let mut args = vec!["rollback".to_string(), name.to_string()];
    if let Some(rev) = revision {
        if rev < 1 {
            return Err(KubyError::Message("revision must be >= 1".into()));
        }
        args.push(rev.to_string());
    }
    args.extend([
        "-n".to_string(),
        namespace.to_string(),
        "--kube-context".to_string(),
        context.to_string(),
    ]);
    let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_helm(&borrowed)
}

pub fn upgrade(
    context: &str,
    namespace: &str,
    name: &str,
    chart: &str,
    reuse_values: bool,
) -> Result<String> {
    validate_context(context)?;
    validate_ident("namespace", namespace)?;
    validate_ident("release", name)?;
    validate_chart_ref(chart)?;
    let mut args = vec![
        "upgrade",
        name,
        chart,
        "-n",
        namespace,
        "--kube-context",
        context,
    ];
    if reuse_values {
        args.push("--reuse-values");
    }
    run_helm(&args)
}

/// Patch Flux HelmRelease `spec.suspend`.
pub async fn set_flux_suspend(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    namespace: &str,
    name: &str,
    suspend: bool,
) -> Result<()> {
    let (api, _) = manager
        .resolve_api(context, api_version, "HelmRelease", Some(namespace))
        .await?;
    let patch = json!({ "spec": { "suspend": suspend } });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Request Flux reconcile via annotation timestamp.
pub async fn request_flux_reconcile(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    namespace: &str,
    name: &str,
) -> Result<()> {
    let (api, _) = manager
        .resolve_api(context, api_version, "HelmRelease", Some(namespace))
        .await?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({
        "metadata": {
            "annotations": {
                FLUX_RECONCILE_ANNOTATION: now
            }
        }
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

fn run_helm(args: &[&str]) -> Result<String> {
    let output = Command::new("helm").args(args).output().map_err(|e| {
        KubyError::Message(format!(
            "failed to run helm: {e}. Install the Helm CLI and ensure it is on PATH."
        ))
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        return Ok(if stdout.is_empty() { stderr } else { stdout });
    }
    let msg = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("helm {:?} failed", args)
    };
    Err(KubyError::Message(msg))
}

/// DNS-1123-ish identifier: blocks flag injection via values starting with `-`.
fn validate_ident(kind: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 253 {
        return Err(KubyError::Message(format!("invalid {kind}")));
    }
    if value.starts_with('-') {
        return Err(KubyError::Message(format!(
            "invalid {kind}: must not start with '-'"
        )));
    }
    let ok = value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'));
    if !ok {
        return Err(KubyError::Message(format!(
            "invalid {kind}: only a-z, 0-9, '-', '.', '_' allowed"
        )));
    }
    Ok(())
}

/// Kubeconfig context names are freer than DNS labels (e.g. ARN-style).
fn validate_context(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        return Err(KubyError::Message("invalid context".into()));
    }
    if value.starts_with('-') {
        return Err(KubyError::Message(
            "invalid context: must not start with '-'".into(),
        ));
    }
    if value.chars().any(|c| c.is_whitespace() || c == '\0') {
        return Err(KubyError::Message(
            "invalid context: whitespace not allowed".into(),
        ));
    }
    Ok(())
}

/// Chart ref: repo/name, path, or OCI URL — reject option-like strings.
fn validate_chart_ref(chart: &str) -> Result<()> {
    if chart.is_empty() || chart.len() > 512 {
        return Err(KubyError::Message("invalid chart reference".into()));
    }
    if chart.starts_with('-') {
        return Err(KubyError::Message(
            "invalid chart reference: must not start with '-'".into(),
        ));
    }
    if chart.chars().any(|c| c.is_whitespace() || c == '\0') {
        return Err(KubyError::Message(
            "invalid chart reference: whitespace not allowed".into(),
        ));
    }
    Ok(())
}

async fn list_helm_secrets(
    manager: &ClusterManager,
    context: &str,
    namespaces: &[String],
) -> Result<Vec<Secret>> {
    let client = manager.client(context)?;
    let lp = ListParams::default().labels(HELM_OWNER_LABEL);

    let fetch_all = namespaces.is_empty() || namespaces.iter().any(|n| n.is_empty() || n == "*");

    if fetch_all {
        let api: Api<Secret> = Api::all(client);
        return match api.list(&lp).await {
            Ok(list) => Ok(list.items),
            Err(err) if kube_is_forbidden(&err) || kube_is_not_found(&err) => Ok(Vec::new()),
            Err(err) => Err(err.into()),
        };
    }

    let mut all = Vec::new();
    for ns in namespaces {
        let api: Api<Secret> = Api::namespaced(client.clone(), ns);
        match api.list(&lp).await {
            Ok(list) => all.extend(list.items),
            Err(err) if kube_is_forbidden(&err) || kube_is_not_found(&err) => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(all)
}

fn parse_secret(secret: &Secret) -> Option<ParsedRelease> {
    let ty = secret.type_.as_deref().unwrap_or("");
    if ty != HELM_SECRET_TYPE {
        return None;
    }
    let data = secret.data.as_ref()?;
    let release_bytes = data.get("release")?;
    let value = decode_release_payload(&release_bytes.0).ok()?;

    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| secret.labels().get("name").map(|s| s.as_str()))
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return None;
    }

    let namespace = value
        .get("namespace")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| secret.namespace().map(|s| s.to_string()))
        .unwrap_or_default();

    let revision = value
        .get("version")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            secret
                .labels()
                .get("version")
                .and_then(|s| s.parse::<i64>().ok())
        })
        .unwrap_or(0);

    let info = value.get("info");
    let status = info
        .and_then(|i| i.get("status"))
        .and_then(|v| v.as_str())
        .or_else(|| secret.labels().get("status").map(|s| s.as_str()))
        .unwrap_or("unknown")
        .to_string();

    let description = info
        .and_then(|i| i.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let updated = info
        .and_then(|i| i.get("last_deployed"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            info.and_then(|i| i.get("lastDeployed"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string();

    let chart_meta = value
        .get("chart")
        .and_then(|c| c.get("metadata"))
        .or_else(|| value.get("chart").and_then(|c| c.get("Metadata")));
    let chart_name = chart_meta
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let chart_version = chart_meta
        .and_then(|m| m.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let chart = if chart_name.is_empty() {
        String::new()
    } else if chart_version.is_empty() {
        chart_name.to_string()
    } else {
        format!("{chart_name}-{chart_version}")
    };
    let app_version = chart_meta
        .and_then(|m| m.get("appVersion"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let config = value
        .get("config")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));

    Some(ParsedRelease {
        name,
        namespace,
        revision,
        status,
        chart,
        app_version,
        updated,
        description,
        config,
    })
}

/// Helm stores `data.release` as base64(gzip(json)) bytes (ASCII base64 string).
fn decode_release_payload(raw: &[u8]) -> Result<Value> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| KubyError::Message(format!("helm release base64 decode: {e}")))?;

    let json_bytes = if is_gzip(&decoded) {
        let mut decoder = GzDecoder::new(&decoded[..]);
        let mut out = Vec::new();
        decoder
            .read_to_end(&mut out)
            .map_err(|e| KubyError::Message(format!("helm release gzip: {e}")))?;
        out
    } else {
        decoded
    };

    serde_json::from_slice(&json_bytes)
        .map_err(|e| KubyError::Message(format!("helm release json: {e}")))
}

fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}
