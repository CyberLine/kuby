use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use kube::core::GroupVersionKind;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{kube_api_message, kube_is_forbidden, kube_is_not_found, Result};
use crate::k8s::ClusterManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetrics {
    pub name: String,
    pub namespace: String,
    pub cpu: String,
    pub memory: String,
    pub containers: Vec<ContainerMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMetrics {
    pub name: String,
    pub cpu: String,
    pub memory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    pub name: String,
    pub cpu: String,
    pub memory: String,
}

fn pod_metrics_api(client: kube::Client, namespace: Option<&str>) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics");
    let ar = ApiResource::from_gvk(&gvk);
    match namespace {
        Some(ns) if !ns.is_empty() && ns != "*" => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    }
}

fn node_metrics_api(client: kube::Client) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics");
    let ar = ApiResource::from_gvk(&gvk);
    Api::all_with(client, &ar)
}

/// Fetch pod metrics via metrics.k8s.io (metrics-server).
///
/// Missing metrics-server (404) or missing RBAC (403) is not an error: CPU/Mem
/// is optional enrichment, and limited accounts should still see the pod list.
pub async fn list_pod_metrics(
    manager: &ClusterManager,
    context: &str,
    namespace: Option<&str>,
) -> Result<Vec<PodMetrics>> {
    let client = manager.client(context)?;
    let api = pod_metrics_api(client, namespace);
    let list = match api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(e) => {
            log_metrics_unavailable("pod", namespace, &e);
            return Ok(Vec::new());
        }
    };

    let mut out = Vec::new();
    for item in list.items {
        let name = item.name_any();
        let ns = item.namespace().unwrap_or_default();
        let containers = item
            .data
            .get("containers")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut cmetrics = Vec::new();
        let mut cpu_total = 0i64;
        let mut mem_total = 0i64;
        for c in containers {
            let cname = c
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let cpu = c
                .pointer("/usage/cpu")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let memory = c
                .pointer("/usage/memory")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            cpu_total += parse_cpu_millis(&cpu);
            mem_total += parse_memory_bytes(&memory);
            cmetrics.push(ContainerMetrics {
                name: cname,
                cpu: cpu.clone(),
                memory: memory.clone(),
            });
        }
        out.push(PodMetrics {
            name,
            namespace: ns,
            cpu: format!("{cpu_total}m"),
            memory: format_bytes(mem_total),
            containers: cmetrics,
        });
    }
    Ok(out)
}

pub async fn list_node_metrics(
    manager: &ClusterManager,
    context: &str,
) -> Result<Vec<NodeMetrics>> {
    let client = manager.client(context)?;
    let api = node_metrics_api(client);
    let list = match api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(e) => {
            log_metrics_unavailable("node", None, &e);
            return Ok(Vec::new());
        }
    };

    Ok(list
        .items
        .into_iter()
        .map(|item| {
            let name = item.name_any();
            let cpu = item
                .data
                .pointer("/usage/cpu")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let memory = item
                .data
                .pointer("/usage/memory")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            NodeMetrics {
                name,
                cpu: format!("{}m", parse_cpu_millis(&cpu)),
                memory: format_bytes(parse_memory_bytes(&memory)),
            }
        })
        .collect())
}

fn log_metrics_unavailable(kind: &str, namespace: Option<&str>, err: &kube::Error) {
    let ns = namespace.unwrap_or("*");
    let msg = kube_api_message(err);
    if kube_is_forbidden(err) || kube_is_not_found(err) {
        tracing::debug!(kind, namespace = ns, error = %msg, "metrics.k8s.io unavailable");
    } else {
        tracing::warn!(kind, namespace = ns, error = %msg, "metrics.k8s.io unavailable");
    }
}

fn parse_cpu_millis(s: &str) -> i64 {
    if let Some(n) = s.strip_suffix('n') {
        return n.parse::<i64>().unwrap_or(0) / 1_000_000;
    }
    if let Some(n) = s.strip_suffix('u') {
        return n.parse::<i64>().unwrap_or(0) / 1_000;
    }
    if let Some(n) = s.strip_suffix('m') {
        return n.parse::<i64>().unwrap_or(0);
    }
    (s.parse::<f64>().unwrap_or(0.0) * 1000.0) as i64
}

fn parse_memory_bytes(s: &str) -> i64 {
    let units = [
        ("Ki", 1024i64),
        ("Mi", 1024 * 1024),
        ("Gi", 1024 * 1024 * 1024),
        ("Ti", 1024i64.pow(4)),
        ("K", 1000),
        ("M", 1000 * 1000),
        ("G", 1000 * 1000 * 1000),
    ];
    for (suf, mul) in units {
        if let Some(n) = s.strip_suffix(suf) {
            return n.parse::<i64>().unwrap_or(0) * mul;
        }
    }
    s.parse::<i64>().unwrap_or(0)
}

fn format_bytes(n: i64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.1}Gi", n as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if n >= 1024 * 1024 {
        format!("{:.1}Mi", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1}Ki", n as f64 / 1024.0)
    } else {
        format!("{n}")
    }
}

pub fn diff_yaml(left: &str, right: &str) -> serde_json::Value {
    use similar::{ChangeTag, TextDiff};
    let diff = TextDiff::from_lines(left, right);
    let mut hunks = Vec::new();
    for op in diff.ops() {
        for change in diff.iter_changes(op) {
            let tag = match change.tag() {
                ChangeTag::Equal => "equal",
                ChangeTag::Delete => "delete",
                ChangeTag::Insert => "insert",
            };
            hunks.push(json!({
                "tag": tag,
                "value": change.value(),
            }));
        }
    }
    json!({ "hunks": hunks })
}
