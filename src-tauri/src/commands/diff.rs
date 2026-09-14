use crate::error::Result;
use crate::k8s::metrics;

#[tauri::command]
pub async fn diff_resources(left_yaml: String, right_yaml: String) -> Result<serde_json::Value> {
    Ok(metrics::diff_yaml(&left_yaml, &right_yaml))
}
