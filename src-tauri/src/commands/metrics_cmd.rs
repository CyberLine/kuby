use tauri::State;

use crate::error::Result;
use crate::k8s::metrics::{self, NodeMetrics, PodMetrics};
use crate::AppState;

#[tauri::command]
pub async fn get_pod_metrics(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
) -> Result<Vec<PodMetrics>> {
    metrics::list_pod_metrics(&state.manager, &context, namespace.as_deref()).await
}

#[tauri::command]
pub async fn get_node_metrics(
    state: State<'_, AppState>,
    context: String,
) -> Result<Vec<NodeMetrics>> {
    metrics::list_node_metrics(&state.manager, &context).await
}
