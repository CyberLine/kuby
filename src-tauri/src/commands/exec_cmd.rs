use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{KubyError, Result};
use crate::k8s::exec;
use crate::AppState;

pub type ExecStdinMap = Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>;

#[tauri::command]
pub async fn start_exec_session(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<Vec<String>>,
) -> Result<String> {
    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Vec<u8>>(256);
    state.exec_stdin.lock().insert(session_id.clone(), tx);

    // Interactive shell — avoid `sh -c '…'` which exits immediately on many images.
    let cmd = command.unwrap_or_else(|| vec!["/bin/sh".into(), "-i".into()]);

    exec::start_exec(
        app,
        state.manager.clone(),
        session_id.clone(),
        context,
        namespace,
        pod,
        container,
        cmd,
        rx,
    )
    .await?;

    Ok(session_id)
}

#[tauri::command]
pub async fn write_exec_stdin(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<()> {
    let tx = state
        .exec_stdin
        .lock()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| KubyError::Message("exec session not found".into()))?;
    tx.send(data.into_bytes())
        .await
        .map_err(|_| KubyError::Message("exec stdin closed".into()))?;
    Ok(())
}

#[tauri::command]
pub async fn stop_exec_session(
    state: State<'_, AppState>,
    context: String,
    session_id: String,
) -> Result<()> {
    state.exec_stdin.lock().remove(&session_id);
    exec::stop_exec(&state.manager, &context, &session_id)
}
