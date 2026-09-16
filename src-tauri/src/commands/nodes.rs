use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Event, Node, Pod};
use kube::api::{Api, EvictParams, ListParams, Patch, PatchParams};
use kube::ResourceExt;
use serde::Serialize;
use serde_json::json;
use tauri::State;
use tokio::time::sleep;

use crate::error::{KubyError, Result};
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeEvent {
    /// Normal | Warning
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: u32,
    pub last_seen: String,
    pub age: String,
}

fn event_age(ts: &Option<k8s_openapi::jiff::Timestamp>) -> String {
    let Some(t) = ts.as_ref() else {
        return "—".into();
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

/// Events for a Node (e.g. CertificateExpiration), matching kubectl describe.
#[tauri::command]
pub async fn list_node_events(
    state: State<'_, AppState>,
    context: String,
    name: String,
) -> Result<Vec<NodeEvent>> {
    let client = state.manager.client(&context)?;
    let api: Api<Event> = Api::all(client);
    // Node names are DNS labels; keep the field selector free of commas/=.
    let safe_name = name.replace([',', '='], "");
    let lp = ListParams::default().fields(&format!(
        "involvedObject.kind=Node,involvedObject.name={safe_name}"
    ));
    let list = api.list(&lp).await?;

    let mut out: Vec<NodeEvent> = list
        .items
        .into_iter()
        .map(|ev| {
            let last = ev
                .last_timestamp
                .as_ref()
                .map(|t| t.0)
                .or_else(|| ev.event_time.as_ref().map(|t| t.0))
                .or_else(|| ev.metadata.creation_timestamp.as_ref().map(|t| t.0));
            let last_seen = last.map(|t| t.to_string()).unwrap_or_default();
            NodeEvent {
                type_: ev.type_.unwrap_or_default(),
                reason: ev.reason.unwrap_or_default(),
                message: ev.message.unwrap_or_default(),
                count: ev.count.unwrap_or(1) as u32,
                last_seen,
                age: event_age(&last),
            }
        })
        .collect();

    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out.truncate(50);
    Ok(out)
}

const DRAIN_TIMEOUT: Duration = Duration::from_secs(120);
const EVICT_RETRY_DELAY: Duration = Duration::from_secs(5);

fn set_unschedulable(unschedulable: bool) -> serde_json::Value {
    if unschedulable {
        json!({ "spec": { "unschedulable": true } })
    } else {
        // Explicit false matches kubectl uncordon; null would leave the field unset
        // inconsistently across API servers.
        json!({ "spec": { "unschedulable": false } })
    }
}

async fn patch_unschedulable(
    state: &State<'_, AppState>,
    context: &str,
    name: &str,
    unschedulable: bool,
) -> Result<()> {
    let client = state.manager.client(context)?;
    let api: Api<Node> = Api::all(client);
    let params = PatchParams::default();
    let patch = set_unschedulable(unschedulable);
    api.patch(name, &params, &Patch::Merge(&patch)).await?;
    Ok(())
}

#[tauri::command]
pub async fn cordon_node(state: State<'_, AppState>, context: String, name: String) -> Result<()> {
    patch_unschedulable(&state, &context, &name, true).await
}

#[tauri::command]
pub async fn uncordon_node(
    state: State<'_, AppState>,
    context: String,
    name: String,
) -> Result<()> {
    patch_unschedulable(&state, &context, &name, false).await
}

fn is_mirror_pod(pod: &Pod) -> bool {
    pod.metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("kubernetes.io/config.mirror"))
        .is_some()
}

fn is_daemonset_pod(pod: &Pod) -> bool {
    pod.metadata
        .owner_references
        .as_ref()
        .map(|owners| {
            owners
                .iter()
                .any(|o| o.controller == Some(true) && o.kind == "DaemonSet")
        })
        .unwrap_or(false)
}

fn should_skip_pod(pod: &Pod) -> bool {
    is_mirror_pod(pod) || is_daemonset_pod(pod)
}

fn is_pdb_blocked(err: &kube::Error) -> bool {
    // kubectl drain retries eviction when PDBs return Too Many Requests.
    matches!(err, kube::Error::Api(status) if status.code == 429)
}

fn is_not_found(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(status) if status.code == 404)
}

async fn evict_pod_with_retry(
    client: kube::Client,
    namespace: &str,
    name: &str,
    deadline: Instant,
) -> Result<()> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let ep = EvictParams::default();

    loop {
        match api.evict(name, &ep).await {
            Ok(_) => return Ok(()),
            Err(err) if is_not_found(&err) => return Ok(()),
            Err(err) if is_pdb_blocked(&err) => {
                if Instant::now() >= deadline {
                    return Err(KubyError::Message(format!(
                        "timed out waiting to evict {namespace}/{name}: {err}"
                    )));
                }
                sleep(EVICT_RETRY_DELAY).await;
            }
            Err(err) => {
                return Err(KubyError::Kube(err));
            }
        }
    }
}

#[tauri::command]
pub async fn drain_node(state: State<'_, AppState>, context: String, name: String) -> Result<()> {
    // Cordon first so the scheduler does not place new pods while we evict.
    patch_unschedulable(&state, &context, &name, true).await?;

    let client = state.manager.client(&context)?;
    let pods_api: Api<Pod> = Api::all(client.clone());
    let lp = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let list = pods_api.list(&lp).await?;

    let to_evict: Vec<(String, String)> = list
        .items
        .into_iter()
        .filter(|p| !should_skip_pod(p))
        .filter_map(|p| {
            let ns = p.namespace()?;
            let pod_name = p.name_any();
            Some((ns, pod_name))
        })
        .collect();

    let deadline = Instant::now() + DRAIN_TIMEOUT;
    let mut failures: Vec<String> = Vec::new();

    for (ns, pod_name) in &to_evict {
        if Instant::now() >= deadline {
            failures.push(format!(
                "{ns}/{pod_name}: drain timeout before eviction started"
            ));
            continue;
        }
        if let Err(err) = evict_pod_with_retry(client.clone(), ns, pod_name, deadline).await {
            failures.push(format!("{ns}/{pod_name}: {err}"));
        }
    }

    if !failures.is_empty() {
        let preview: Vec<_> = failures.iter().take(5).cloned().collect();
        let more = if failures.len() > 5 {
            format!(" (+{} more)", failures.len() - 5)
        } else {
            String::new()
        };
        return Err(KubyError::Message(format!(
            "drain incomplete for {name}: {}{}",
            preview.join("; "),
            more
        )));
    }

    Ok(())
}
