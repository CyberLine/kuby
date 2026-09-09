use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, PodTemplateSpec};
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::ResourceExt;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::commands::resources::ResourceIdentifier;
use crate::error::{KubyError, Result};
use crate::AppState;

#[tauri::command]
pub async fn scale_workload(
    state: State<'_, AppState>,
    context: String,
    kind: String,
    namespace: String,
    name: String,
    replicas: i32,
) -> Result<()> {
    let client = state.manager.client(&context)?;
    let patch = json!({ "spec": { "replicas": replicas } });
    let params = PatchParams::default();

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        "ReplicaSet" => {
            let (api, _) = state
                .manager
                .resolve_api(&context, "apps/v1", "ReplicaSet", Some(&namespace))
                .await?;
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        other => {
            return Err(KubyError::Message(format!(
                "scaling not supported for {other}"
            )))
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_workload(
    state: State<'_, AppState>,
    context: String,
    kind: String,
    namespace: String,
    name: String,
) -> Result<()> {
    let client = state.manager.client(&context)?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kuby.io/restartedAt": now
                    }
                }
            }
        }
    });
    let params = PatchParams::default();

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        "DaemonSet" => {
            let (api, _) = state
                .manager
                .resolve_api(&context, "apps/v1", "DaemonSet", Some(&namespace))
                .await?;
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        other => {
            return Err(KubyError::Message(format!(
                "restart not supported for {other}"
            )))
        }
    }
    Ok(())
}

const POD_TEMPLATE_HASH: &str = "pod-template-hash";
const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";

const ANNOTATIONS_TO_SKIP: &[&str] = &[
    "kubectl.kubernetes.io/last-applied-configuration",
    REVISION_ANNOTATION,
    "deployment.kubernetes.io/revision-history",
    "deployment.kubernetes.io/desired-replicas",
    "deployment.kubernetes.io/max-replicas",
    "deprecated.deployment.rollback.to",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub skipped: bool,
    pub revision: i64,
    pub deployment: String,
    pub replicaset: String,
}

#[tauri::command]
pub async fn rollback_deployment(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
    to_revision: Option<i64>,
    from_replica_set: Option<String>,
) -> Result<RollbackResult> {
    let client = state.manager.client(&context)?;
    let deploy_api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
    let rs_api: Api<ReplicaSet> = Api::namespaced(client, &namespace);
    let deploy = deploy_api.get(&name).await?;

    if deploy.spec.as_ref().and_then(|s| s.paused).unwrap_or(false) {
        return Err(KubyError::Message(format!(
            "Deployment \"{name}\" is paused; resume it before rolling back"
        )));
    }

    let replica_sets = list_owned_replica_sets(&rs_api, &deploy).await?;
    let target = match from_replica_set.as_deref() {
        Some(rs_name) => replica_sets
            .iter()
            .find(|rs| rs.name_any() == rs_name)
            .ok_or_else(|| {
                KubyError::Message(format!(
                    "ReplicaSet \"{rs_name}\" is not owned by Deployment \"{name}\""
                ))
            })?,
        None => select_revision_rs(&replica_sets, to_revision.unwrap_or(0), &name)?,
    };

    let revision = rs_revision(target).unwrap_or(0);
    let rs_name = target.name_any();
    let mut template = target
        .spec
        .as_ref()
        .and_then(|s| s.template.clone())
        .ok_or_else(|| KubyError::from("ReplicaSet has no pod template"))?;
    strip_pod_template_hash(&mut template);

    let current_template = deploy.spec.as_ref().map(|s| &s.template);
    if let Some(current) = current_template {
        if templates_equal_ignore_hash(&template, current) {
            return Ok(RollbackResult {
                skipped: true,
                revision,
                deployment: name,
                replicaset: rs_name,
            });
        }
    }

    let annotations = rollback_annotations(&deploy, target);
    let patch_value = json!([
        { "op": "replace", "path": "/spec/template", "value": template },
        { "op": "add", "path": "/metadata/annotations", "value": annotations },
    ]);
    let patch: json_patch::Patch = serde_json::from_value(patch_value)?;
    deploy_api
        .patch(&name, &PatchParams::default(), &Patch::Json::<()>(patch))
        .await?;

    Ok(RollbackResult {
        skipped: false,
        revision,
        deployment: name,
        replicaset: rs_name,
    })
}

async fn list_owned_replica_sets(
    rs_api: &Api<ReplicaSet>,
    deploy: &Deployment,
) -> Result<Vec<ReplicaSet>> {
    let mut lp = ListParams::default();
    if let Some(selector) = deploy_match_labels(deploy) {
        lp = lp.labels(&selector);
    }
    let list = rs_api.list(&lp).await?;
    let deploy_name = deploy.name_any();
    let deploy_uid = deploy.uid().unwrap_or_default();
    Ok(list
        .items
        .into_iter()
        .filter(|rs| {
            rs.owner_references().iter().any(|owner| {
                owner.kind == "Deployment"
                    && owner.name == deploy_name
                    && (deploy_uid.is_empty() || owner.uid == deploy_uid)
            })
        })
        .collect())
}

fn deploy_match_labels(deploy: &Deployment) -> Option<String> {
    let labels = deploy.spec.as_ref()?.selector.match_labels.as_ref()?;
    if labels.is_empty() {
        return None;
    }
    Some(
        labels
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn select_revision_rs<'a>(
    replica_sets: &'a [ReplicaSet],
    to_revision: i64,
    deploy_name: &str,
) -> Result<&'a ReplicaSet> {
    if to_revision < 0 {
        return Err(KubyError::Message(format!(
            "unable to find specified revision {to_revision} in history"
        )));
    }

    if to_revision > 0 {
        return replica_sets
            .iter()
            .find(|rs| rs_revision(rs) == Some(to_revision))
            .ok_or_else(|| {
                KubyError::Message(format!(
                    "unable to find specified revision {to_revision} in history"
                ))
            });
    }

    let mut ranked: Vec<(&ReplicaSet, i64)> = replica_sets
        .iter()
        .filter_map(|rs| rs_revision(rs).map(|rev| (rs, rev)))
        .collect();
    ranked.sort_by_key(|(_, rev)| *rev);
    if ranked.len() < 2 {
        return Err(KubyError::Message(format!(
            "no rollout history found for deployment \"{deploy_name}\""
        )));
    }
    Ok(ranked[ranked.len() - 2].0)
}

fn rs_revision(rs: &ReplicaSet) -> Option<i64> {
    rs.annotations()
        .get(REVISION_ANNOTATION)
        .and_then(|v| v.parse().ok())
}

fn strip_pod_template_hash(template: &mut PodTemplateSpec) {
    if let Some(labels) = template.metadata.as_mut().and_then(|m| m.labels.as_mut()) {
        labels.remove(POD_TEMPLATE_HASH);
    }
}

fn templates_equal_ignore_hash(a: &PodTemplateSpec, b: &PodTemplateSpec) -> bool {
    let mut left = a.clone();
    let mut right = b.clone();
    strip_pod_template_hash(&mut left);
    strip_pod_template_hash(&mut right);
    left == right
}

fn rollback_annotations(
    deploy: &Deployment,
    rs: &ReplicaSet,
) -> std::collections::BTreeMap<String, String> {
    let mut annotations = deploy.annotations().clone();
    for (key, value) in rs.annotations() {
        if !ANNOTATIONS_TO_SKIP.contains(&key.as_str()) {
            annotations.insert(key.clone(), value.clone());
        }
    }
    annotations
}

#[tauri::command]
pub async fn delete_pod(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
) -> Result<()> {
    let client = state.manager.client(&context)?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    api.delete(&name, &Default::default()).await?;
    Ok(())
}

#[tauri::command]
pub async fn resource_action(
    state: State<'_, AppState>,
    action: String,
    ident: ResourceIdentifier,
    replicas: Option<i32>,
) -> Result<()> {
    match action.as_str() {
        "delete" => {
            crate::commands::resources::delete_resource(state, ident).await?;
        }
        "scale" => {
            let reps = replicas.ok_or_else(|| KubyError::from("replicas required"))?;
            scale_workload(
                state,
                ident.context,
                ident.kind,
                ident.namespace.unwrap_or_default(),
                ident.name,
                reps,
            )
            .await?;
        }
        "restart" => {
            restart_workload(
                state,
                ident.context,
                ident.kind,
                ident.namespace.unwrap_or_default(),
                ident.name,
            )
            .await?;
        }
        other => return Err(KubyError::Message(format!("unknown action: {other}"))),
    }
    Ok(())
}
