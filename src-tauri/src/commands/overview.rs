use std::collections::HashMap;

use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::batch::v1::CronJob;
use k8s_openapi::api::core::v1::{Event, Pod, ResourceQuota};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{Api, ListParams, ResourceExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;
use crate::k8s::metrics;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSegment {
    pub label: String,
    pub count: u32,
    /// ok | warn | err | idle
    pub tone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCard {
    pub kind: String,
    pub total: u32,
    pub segments: Vec<OverviewSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewWarning {
    pub reason: String,
    pub count: u32,
    pub last_seen: String,
    pub age: String,
    pub message: String,
    pub involved: String,
    pub involved_kind: String,
    pub involved_name: String,
    pub involved_namespace: Option<String>,
    pub involved_api_version: Option<String>,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRestart {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub reason: String,
    pub exit_code: Option<i32>,
    pub restart_count: i32,
    pub age: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewUsage {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub cpu: String,
    pub memory: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadOverview {
    pub cards: Vec<OverviewCard>,
    pub warnings: Vec<OverviewWarning>,
    pub restarts: Vec<OverviewRestart>,
    pub usage: Vec<OverviewUsage>,
}

#[tauri::command]
pub async fn get_workload_overview(
    state: State<'_, AppState>,
    context: String,
    namespaces: Vec<String>,
    usage_threshold: Option<f64>,
) -> Result<WorkloadOverview> {
    let threshold = usage_threshold.unwrap_or(0.95);
    let fetch_all = namespaces.is_empty() || namespaces.iter().any(|n| n == "*");
    let ns_list: Vec<String> = if fetch_all {
        vec!["*".into()]
    } else {
        namespaces
    };

    let client = state.manager.client(&context)?;

    let mut pods: Vec<Pod> = Vec::new();
    let mut deployments: Vec<Deployment> = Vec::new();
    let mut replicasets: Vec<ReplicaSet> = Vec::new();
    let mut cronjobs: Vec<CronJob> = Vec::new();
    let mut quotas: Vec<ResourceQuota> = Vec::new();
    let mut pdbs: Vec<PodDisruptionBudget> = Vec::new();
    let mut events: Vec<Event> = Vec::new();

    for ns in &ns_list {
        let all = ns == "*";
        // Best-effort: one failing resource type must not blank the whole overview.
        extend_list(&mut pods, list_ns::<Pod>(client.clone(), all, ns).await);
        extend_list(
            &mut deployments,
            list_ns::<Deployment>(client.clone(), all, ns).await,
        );
        extend_list(
            &mut replicasets,
            list_ns::<ReplicaSet>(client.clone(), all, ns).await,
        );
        extend_list(
            &mut cronjobs,
            list_ns::<CronJob>(client.clone(), all, ns).await,
        );
        extend_list(
            &mut quotas,
            list_ns::<ResourceQuota>(client.clone(), all, ns).await,
        );
        extend_list(
            &mut pdbs,
            list_ns::<PodDisruptionBudget>(client.clone(), all, ns).await,
        );
        extend_list(&mut events, list_ns::<Event>(client.clone(), all, ns).await);
    }

    let cards = vec![
        pod_card(&pods),
        workload_card("Deployments", &deployments),
        replicaset_card(&replicasets),
        cronjob_card(&cronjobs),
        quota_card(&quotas),
        pdb_card(&pdbs),
    ];

    let warnings = aggregate_warnings(&context, &events);
    let restarts = collect_restarts(&context, &pods);
    let usage = collect_usage(
        &state,
        &context,
        if fetch_all { None } else { Some(ns_list) },
        &pods,
        threshold,
    )
    .await;

    Ok(WorkloadOverview {
        cards,
        warnings,
        restarts,
        usage,
    })
}

async fn list_ns<K>(
    client: kube::Client,
    all: bool,
    ns: &str,
) -> std::result::Result<Vec<K>, kube::Error>
where
    K: kube::Resource<Scope = kube::core::NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
    <K as kube::Resource>::DynamicType: Default,
{
    let api: Api<K> = if all {
        Api::all(client)
    } else {
        Api::namespaced(client, ns)
    };
    Ok(api.list(&ListParams::default()).await?.items)
}

fn extend_list<T>(target: &mut Vec<T>, result: std::result::Result<Vec<T>, kube::Error>) {
    match result {
        Ok(items) => target.extend(items),
        Err(err) => tracing::warn!(error = %err, "overview list failed"),
    }
}

fn bump(map: &mut HashMap<String, (u32, String)>, label: &str, tone: &str) {
    let entry = map
        .entry(label.to_string())
        .or_insert((0, tone.to_string()));
    entry.0 += 1;
}

fn segments_from(map: HashMap<String, (u32, String)>) -> Vec<OverviewSegment> {
    let mut segs: Vec<_> = map
        .into_iter()
        .map(|(label, (count, tone))| OverviewSegment { label, count, tone })
        .collect();
    segs.sort_by(|a, b| b.count.cmp(&a.count).then(a.label.cmp(&b.label)));
    segs
}

fn pod_card(pods: &[Pod]) -> OverviewCard {
    let mut map = HashMap::new();
    for pod in pods {
        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into());

        let waiting = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .into_iter()
            .flatten()
            .find_map(|cs| {
                cs.state.as_ref().and_then(|st| {
                    st.waiting
                        .as_ref()
                        .and_then(|w| w.reason.clone())
                        .or_else(|| st.terminated.as_ref().and_then(|t| t.reason.clone()))
                })
            });

        let (label, tone) = match waiting.as_deref() {
            Some("ImagePullBackOff") | Some("ErrImagePull") => ("ImagePullBackOff", "err"),
            Some("CrashLoopBackOff") => ("CrashLoopBackOff", "err"),
            Some("CreateContainerConfigError") => ("ConfigError", "err"),
            Some("Error") => ("Error", "err"),
            _ => match phase.as_str() {
                "Running" => ("Running", "ok"),
                "Succeeded" => ("Completed", "idle"),
                "Pending" => ("Pending", "warn"),
                "Failed" => ("Failed", "err"),
                other => (other, "idle"),
            },
        };
        bump(&mut map, label, tone);
    }
    let total = pods.len() as u32;
    OverviewCard {
        kind: "Pods".into(),
        total,
        segments: segments_from(map),
    }
}

fn workload_card(kind: &str, items: &[Deployment]) -> OverviewCard {
    let mut map = HashMap::new();
    for d in items {
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let available = d
            .status
            .as_ref()
            .and_then(|s| s.available_replicas)
            .unwrap_or(0);
        let (label, tone) = if desired == 0 {
            ("Idle", "idle")
        } else if available >= desired {
            ("Running", "ok")
        } else {
            ("Unavailable", "err")
        };
        bump(&mut map, label, tone);
    }
    OverviewCard {
        kind: kind.into(),
        total: items.len() as u32,
        segments: segments_from(map),
    }
}

fn replicaset_owned_by_deployment(rs: &ReplicaSet) -> bool {
    rs.owner_references()
        .iter()
        .any(|owner| owner.kind == "Deployment")
}

fn replicaset_card(items: &[ReplicaSet]) -> OverviewCard {
    let mut map = HashMap::new();
    for rs in items {
        let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let ready = rs
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let owned = replicaset_owned_by_deployment(rs);
        let (label, tone) = if desired == 0 {
            if owned {
                ("Old", "idle")
            } else {
                ("Idle", "idle")
            }
        } else if ready >= desired {
            ("Running", "ok")
        } else {
            ("Unavailable", "err")
        };
        bump(&mut map, label, tone);
    }
    OverviewCard {
        kind: "ReplicaSets".into(),
        total: items.len() as u32,
        segments: segments_from(map),
    }
}

fn cronjob_card(items: &[CronJob]) -> OverviewCard {
    let mut map = HashMap::new();
    for cj in items {
        let suspended = cj.spec.suspend.unwrap_or(false);
        if suspended {
            bump(&mut map, "Suspended", "idle");
        } else {
            bump(&mut map, "Scheduled", "ok");
        }
    }
    OverviewCard {
        kind: "CronJobs".into(),
        total: items.len() as u32,
        segments: segments_from(map),
    }
}

fn quota_card(items: &[ResourceQuota]) -> OverviewCard {
    let mut map = HashMap::new();
    for q in items {
        let hard = q.status.as_ref().and_then(|s| s.hard.as_ref());
        let used = q.status.as_ref().and_then(|s| s.used.as_ref());
        let warning = match (hard, used) {
            (Some(h), Some(u)) => h.iter().any(|(k, hv)| {
                u.get(k)
                    .map(|uv| quantity_ratio(uv, hv) >= 0.9)
                    .unwrap_or(false)
            }),
            _ => false,
        };
        if warning {
            bump(&mut map, "Warning", "warn");
        } else {
            bump(&mut map, "Ok", "ok");
        }
    }
    OverviewCard {
        kind: "Resource Quotas".into(),
        total: items.len() as u32,
        segments: segments_from(map),
    }
}

fn pdb_card(items: &[PodDisruptionBudget]) -> OverviewCard {
    let mut map = HashMap::new();
    for pdb in items {
        let allowed = pdb
            .status
            .as_ref()
            .and_then(|s| s.disruptions_allowed)
            .unwrap_or(0);
        if allowed > 0 {
            bump(&mut map, "DisruptionAllowed", "ok");
        } else {
            bump(&mut map, "Blocked", "warn");
        }
    }
    OverviewCard {
        kind: "Disruption Budgets".into(),
        total: items.len() as u32,
        segments: segments_from(map),
    }
}

fn aggregate_warnings(context: &str, events: &[Event]) -> Vec<OverviewWarning> {
    let mut by_reason: HashMap<String, OverviewWarning> = HashMap::new();
    for ev in events {
        let typ = ev.type_.as_deref().unwrap_or("");
        if !typ.eq_ignore_ascii_case("Warning") {
            continue;
        }
        let reason = ev.reason.clone().unwrap_or_else(|| "Warning".into());
        let last = ev
            .last_timestamp
            .as_ref()
            .map(|t| t.0)
            .or_else(|| ev.event_time.as_ref().map(|t| t.0))
            .or_else(|| ev.metadata.creation_timestamp.as_ref().map(|t| t.0));
        let last_str = last.map(|t| t.to_string()).unwrap_or_default();
        let count = ev.count.unwrap_or(1) as u32;
        let involved_kind = ev
            .involved_object
            .kind
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "?".into());
        let involved_name = ev
            .involved_object
            .name
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "?".into());
        let involved_namespace = ev
            .involved_object
            .namespace
            .clone()
            .filter(|s| !s.is_empty());
        let involved_api_version = ev
            .involved_object
            .api_version
            .clone()
            .filter(|s| !s.is_empty());
        let involved = format!("{involved_kind}/{involved_name}");
        let message = ev.message.clone().unwrap_or_default();
        let age = age_from(&last);

        by_reason
            .entry(reason.clone())
            .and_modify(|w| {
                w.count += count;
                if last_str > w.last_seen {
                    w.last_seen = last_str.clone();
                    w.age = age.clone();
                    w.message = message.clone();
                    w.involved = involved.clone();
                    w.involved_kind = involved_kind.clone();
                    w.involved_name = involved_name.clone();
                    w.involved_namespace = involved_namespace.clone();
                    w.involved_api_version = involved_api_version.clone();
                }
            })
            .or_insert(OverviewWarning {
                reason,
                count,
                last_seen: last_str,
                age,
                message,
                involved,
                involved_kind,
                involved_name,
                involved_namespace,
                involved_api_version,
                context: context.to_string(),
            });
    }
    let mut out: Vec<_> = by_reason.into_values().collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out.truncate(25);
    out
}

fn collect_restarts(context: &str, pods: &[Pod]) -> Vec<OverviewRestart> {
    let mut out = Vec::new();
    for pod in pods {
        let ns = pod.namespace().unwrap_or_default();
        let name = pod.name_any();
        let statuses = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .into_iter()
            .flatten();
        for cs in statuses {
            let restarts = cs.restart_count;
            if restarts <= 0 {
                continue;
            }
            let term = cs
                .last_state
                .as_ref()
                .and_then(|s| s.terminated.as_ref())
                .or_else(|| cs.state.as_ref().and_then(|s| s.terminated.as_ref()));
            let reason = term
                .and_then(|t| t.reason.clone())
                .unwrap_or_else(|| "Restart".into());
            let exit_code = term.map(|t| t.exit_code);
            let finished = term.and_then(|t| t.finished_at.as_ref().map(|t| t.0));
            out.push(OverviewRestart {
                context: context.to_string(),
                namespace: ns.clone(),
                pod: name.clone(),
                container: cs.name.clone(),
                reason,
                exit_code,
                restart_count: restarts,
                age: age_from(&finished),
            });
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.restart_count));
    out.truncate(30);
    out
}

async fn collect_usage(
    state: &AppState,
    context: &str,
    namespaces: Option<Vec<String>>,
    pods: &[Pod],
    threshold: f64,
) -> Vec<OverviewUsage> {
    let mut out = Vec::new();
    let metrics_list = if let Some(nss) = namespaces {
        let mut all = Vec::new();
        for ns in nss {
            if let Ok(m) = metrics::list_pod_metrics(&state.manager, context, Some(&ns)).await {
                all.extend(m);
            }
        }
        all
    } else {
        metrics::list_pod_metrics(&state.manager, context, None)
            .await
            .unwrap_or_default()
    };

    let pod_limits: HashMap<(String, String), HashMap<String, (i64, i64)>> = pods
        .iter()
        .map(|p| {
            let key = (p.namespace().unwrap_or_default(), p.name_any());
            let mut containers = HashMap::new();
            if let Some(spec) = &p.spec {
                for c in spec.containers.iter() {
                    let cpu = c
                        .resources
                        .as_ref()
                        .and_then(|r| r.limits.as_ref())
                        .and_then(|l| l.get("cpu"))
                        .map(|q| parse_cpu_millis(&q.0))
                        .unwrap_or(0);
                    let mem = c
                        .resources
                        .as_ref()
                        .and_then(|r| r.limits.as_ref())
                        .and_then(|l| l.get("memory"))
                        .map(|q| parse_memory_bytes(&q.0))
                        .unwrap_or(0);
                    containers.insert(c.name.clone(), (cpu, mem));
                }
            }
            (key, containers)
        })
        .collect();

    for pm in metrics_list {
        let limits = pod_limits.get(&(pm.namespace.clone(), pm.name.clone()));
        for c in pm.containers {
            let used_cpu = parse_cpu_millis(&c.cpu);
            let used_mem = parse_memory_bytes(&c.memory);
            let (lim_cpu, lim_mem) = limits
                .and_then(|m| m.get(&c.name).copied())
                .unwrap_or((0, 0));
            let cpu_pct = if lim_cpu > 0 {
                used_cpu as f64 / lim_cpu as f64
            } else {
                0.0
            };
            let mem_pct = if lim_mem > 0 {
                used_mem as f64 / lim_mem as f64
            } else {
                0.0
            };
            if cpu_pct >= threshold || mem_pct >= threshold {
                out.push(OverviewUsage {
                    context: context.to_string(),
                    namespace: pm.namespace.clone(),
                    pod: pm.name.clone(),
                    container: c.name,
                    cpu: format!("{used_cpu}m"),
                    memory: format_bytes(used_mem),
                    cpu_percent: (cpu_pct * 100.0).min(999.0),
                    memory_percent: (mem_pct * 100.0).min(999.0),
                });
            }
        }
    }

    out.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(40);
    out
}

fn age_from(ts: &Option<k8s_openapi::jiff::Timestamp>) -> String {
    let Some(t) = ts.as_ref() else {
        return "-".into();
    };
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let sec = (now_secs - t.as_second()).max(0);
    if sec < 60 {
        format!("{sec}s ago")
    } else if sec < 3600 {
        format!("{}m ago", sec / 60)
    } else if sec < 86400 {
        format!("{}h ago", sec / 3600)
    } else {
        format!("{}d ago", sec / 86400)
    }
}

fn quantity_ratio(
    used: &k8s_openapi::apimachinery::pkg::api::resource::Quantity,
    hard: &k8s_openapi::apimachinery::pkg::api::resource::Quantity,
) -> f64 {
    let u = parse_memory_bytes(&used.0).max(parse_cpu_millis(&used.0)) as f64;
    let h = parse_memory_bytes(&hard.0).max(parse_cpu_millis(&hard.0)) as f64;
    if h <= 0.0 {
        0.0
    } else {
        u / h
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
        format!("{:.2}Gi", n as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if n >= 1024 * 1024 {
        format!("{:.0}Mi", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.0}Ki", n as f64 / 1024.0)
    } else {
        format!("{n}")
    }
}
