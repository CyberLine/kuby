use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::Result;
use crate::k8s::portforward::{self, PortForwardInfo};
use crate::AppState;

#[tauri::command]
pub async fn start_port_forward(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    local_port: u16,
    remote_port: u16,
) -> Result<PortForwardInfo> {
    let id = Uuid::new_v4().to_string();
    portforward::start_port_forward(
        app,
        state.manager.clone(),
        id,
        context,
        namespace,
        pod,
        local_port,
        remote_port,
    )
    .await
}

#[tauri::command]
pub async fn stop_port_forward(
    state: State<'_, AppState>,
    context: String,
    id: String,
) -> Result<()> {
    portforward::stop_port_forward(&state.manager, &context, &id)
}
