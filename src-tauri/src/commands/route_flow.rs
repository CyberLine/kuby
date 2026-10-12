use tauri::State;

use crate::error::Result;
use crate::k8s::route_flow::{self, RouteFlowGraph};
use crate::AppState;

#[tauri::command]
pub async fn get_route_flow(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<RouteFlowGraph> {
    route_flow::build_route_flow(
        &state.manager,
        &context,
        &api_version,
        &kind,
        namespace.as_deref(),
        &name,
    )
    .await
}
