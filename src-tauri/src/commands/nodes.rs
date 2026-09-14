use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, EvictParams, ListParams, Patch, PatchParams};
use kube::ResourceExt;
use serde_json::json;
use tauri::State;
use tokio::time::sleep;

use crate::error::{KubyError, Result};
use crate::AppState;

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
