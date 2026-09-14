use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::Result;
use crate::k8s::watch;
use crate::AppState;

#[tauri::command]
pub async fn start_pod_logs(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    previous: Option<bool>,
    tail_lines: Option<i64>,
) -> Result<String> {
    let stream_id = Uuid::new_v4().to_string();
    watch::start_log_stream(
        app,
        state.manager.clone(),
        stream_id,
        context,
        namespace,
        pod,
        container,
        previous.unwrap_or(false),
        tail_lines.or(Some(500)),
    )
    .await
}

#[tauri::command]
pub async fn stop_pod_logs(
    state: State<'_, AppState>,
    context: String,
    stream_id: String,
) -> Result<()> {
    watch::stop_log_stream(&state.manager, &context, &stream_id)
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedLogTarget {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
}

#[tauri::command]
pub async fn start_aggregated_logs(
    app: AppHandle,
    state: State<'_, AppState>,
    targets: Vec<AggregatedLogTarget>,
    previous: Option<bool>,
    tail_lines: Option<i64>,
) -> Result<Vec<String>> {
    let manager = state.manager.clone();
    let mut ids = Vec::new();
    for t in targets {
        let stream_id = Uuid::new_v4().to_string();
        let id = watch::start_log_stream(
            app.clone(),
            manager.clone(),
            stream_id,
            t.context,
            t.namespace,
            t.pod,
            t.container,
            previous.unwrap_or(false),
            tail_lines.or(Some(200)),
        )
        .await?;
        ids.push(id);
    }
    Ok(ids)
}
