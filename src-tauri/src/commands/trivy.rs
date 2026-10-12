use crate::error::{KubyError, Result};
use crate::k8s::trivy::{self, TrivyCliInfo, TrivyScanResult};

#[tauri::command]
pub fn trivy_cli_available() -> TrivyCliInfo {
    trivy::cli_available()
}

#[tauri::command]
pub async fn trivy_scan_image(image: String, image_id: Option<String>) -> Result<TrivyScanResult> {
    tokio::task::spawn_blocking(move || trivy::scan_image(&image, image_id.as_deref()))
        .await
        .map_err(|e| KubyError::Message(format!("trivy scan task failed: {e}")))?
}
