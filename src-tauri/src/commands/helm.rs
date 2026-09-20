use tauri::State;

use crate::error::Result;
use crate::k8s::helm::{self, HelmCliInfo, HelmReleaseDetail, HelmReleaseSummary};
use crate::AppState;

#[tauri::command]
pub async fn list_helm_releases(
    state: State<'_, AppState>,
    context: String,
    namespaces: Vec<String>,
) -> Result<Vec<HelmReleaseSummary>> {
    helm::list_releases(&state.manager, &context, &namespaces).await
}

#[tauri::command]
pub async fn get_helm_release(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
) -> Result<HelmReleaseDetail> {
    helm::get_release(&state.manager, &context, &namespace, &name).await
}

#[tauri::command]
pub fn helm_cli_available() -> HelmCliInfo {
    helm::cli_available()
}

#[tauri::command]
pub fn helm_uninstall(context: String, namespace: String, name: String) -> Result<String> {
    helm::uninstall(&context, &namespace, &name)
}

#[tauri::command]
pub fn helm_rollback(
    context: String,
    namespace: String,
    name: String,
    revision: Option<i64>,
) -> Result<String> {
    helm::rollback(&context, &namespace, &name, revision)
}

#[tauri::command]
pub fn helm_upgrade(
    context: String,
    namespace: String,
    name: String,
    chart: String,
    reuse_values: bool,
) -> Result<String> {
    helm::upgrade(&context, &namespace, &name, &chart, reuse_values)
}

#[tauri::command]
pub async fn flux_helm_release_set_suspend(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    namespace: String,
    name: String,
    suspend: bool,
) -> Result<()> {
    helm::set_flux_suspend(
        &state.manager,
        &context,
        &api_version,
        &namespace,
        &name,
        suspend,
    )
    .await
}

#[tauri::command]
pub async fn flux_helm_release_reconcile(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    namespace: String,
    name: String,
) -> Result<()> {
    helm::request_flux_reconcile(&state.manager, &context, &api_version, &namespace, &name).await
}
