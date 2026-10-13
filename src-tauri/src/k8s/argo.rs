use kube::api::{Patch, PatchParams};
use serde_json::json;

use crate::error::Result;
use crate::k8s::ClusterManager;

const ARGO_REFRESH_ANNOTATION: &str = "argocd.argoproj.io/refresh";

/// Soft refresh an Argo CD Application via annotation.
pub async fn refresh_application(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    namespace: &str,
    name: &str,
) -> Result<()> {
    let (api, _) = manager
        .resolve_api(context, api_version, "Application", Some(namespace))
        .await?;
    let patch = json!({
        "metadata": {
            "annotations": {
                ARGO_REFRESH_ANNOTATION: "normal"
            }
        }
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Trigger a sync operation on an Argo CD Application.
pub async fn sync_application(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    namespace: &str,
    name: &str,
) -> Result<()> {
    let (api, _) = manager
        .resolve_api(context, api_version, "Application", Some(namespace))
        .await?;
    let patch = json!({
        "operation": {
            "initiatedBy": { "username": "kuby" },
            "sync": {
                "syncStrategy": { "hook": {} }
            }
        }
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}
