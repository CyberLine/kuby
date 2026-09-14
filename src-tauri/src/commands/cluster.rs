use tauri::State;

use crate::error::Result;
use crate::k8s::manager::{ClusterStatus, ContextInfo};
use crate::k8s::ClusterManager;
use crate::AppState;

#[tauri::command]
pub async fn list_contexts() -> Result<Vec<ContextInfo>> {
    ClusterManager::list_contexts()
}

#[tauri::command]
pub async fn connect_cluster(state: State<'_, AppState>, context: String) -> Result<ClusterStatus> {
    state.manager.connect(&context).await
}

#[tauri::command]
pub async fn disconnect_cluster(state: State<'_, AppState>, context: String) -> Result<()> {
    state.manager.disconnect(&context).await
}

#[tauri::command]
pub async fn list_active_clusters(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(state.manager.active_contexts())
}

#[tauri::command]
pub async fn test_cluster(state: State<'_, AppState>, context: String) -> Result<ClusterStatus> {
    state.manager.test_connection(&context).await
}

#[tauri::command]
pub async fn get_auth_info(context: String) -> Result<crate::k8s::auth::AuthSummary> {
    let contexts = ClusterManager::list_contexts()?;
    contexts
        .into_iter()
        .find(|c| c.name == context)
        .map(|c| c.auth)
        .ok_or_else(|| crate::error::KubyError::Message(format!("context not found: {context}")))
}
