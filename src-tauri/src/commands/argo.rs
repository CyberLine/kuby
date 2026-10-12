use tauri::State;

use crate::error::Result;
use crate::k8s::argo;
use crate::AppState;

#[tauri::command]
pub async fn argo_app_refresh(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    namespace: String,
    name: String,
) -> Result<()> {
    argo::refresh_application(&state.manager, &context, &api_version, &namespace, &name).await
}

#[tauri::command]
pub async fn argo_app_sync(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    namespace: String,
    name: String,
) -> Result<()> {
    argo::sync_application(&state.manager, &context, &api_version, &namespace, &name).await
}
