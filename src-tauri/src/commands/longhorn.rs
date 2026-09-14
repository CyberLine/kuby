use tauri::State;

use crate::error::Result;
use crate::k8s::longhorn::{self, LonghornOverview};
use crate::AppState;

#[tauri::command]
pub async fn get_longhorn_overview(
    state: State<'_, AppState>,
    context: String,
) -> Result<LonghornOverview> {
    longhorn::get_overview(&state.manager, &context).await
}
