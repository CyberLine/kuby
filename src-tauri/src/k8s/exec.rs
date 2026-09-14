use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::warn;

use crate::error::{KubyError, Result};
use crate::k8s::ClusterManager;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Start an interactive exec session; stdout/stderr are emitted as events.
#[allow(clippy::too_many_arguments)]
pub async fn start_exec(
    app: AppHandle,
    manager: Arc<ClusterManager>,
    session_id: String,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Vec<String>,
    stdin_rx: mpsc::Receiver<Vec<u8>>,
) -> Result<()> {
    let client = manager.client(&context)?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let mut params = AttachParams::interactive_tty();
    if let Some(c) = container.filter(|s| !s.is_empty()) {
        params = params.container(c);
    }

    let cmd: Vec<&str> = command.iter().map(|s| s.as_str()).collect();
    let mut attached = api
        .exec(&pod, cmd, &params)
        .await
        .map_err(|e| KubyError::Message(format!("exec failed: {e}")))?;

    if let Some(mut size_tx) = attached.terminal_size() {
        let _ = size_tx
            .send(TerminalSize {
                width: 120,
                height: 40,
            })
            .await;
    }

    let mut stdout = attached
        .stdout()
        .ok_or_else(|| KubyError::Message("no stdout".into()))?;
    let mut stdin = attached
        .stdin()
        .ok_or_else(|| KubyError::Message("no stdin".into()))?;
    let status_fut = attached.take_status();

    let app_out = app.clone();
    let sid_out = session_id.clone();
    let out_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_out.emit(
                        "k8s://exec",
                        json!({ "sessionId": sid_out, "stream": "stdout", "data": chunk }),
                    );
                }
                Err(err) => {
                    warn!(error = %err, "exec stdout error");
                    break;
                }
            }
        }
    });

    let in_task = tokio::spawn(async move {
        let mut rx = stdin_rx;
        while let Some(data) = rx.recv().await {
            if stdin.write_all(&data).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
        // Half-close stdin so remote shell can see EOF when we stop sending.
        let _ = stdin.shutdown().await;
    });

    let app_end = app.clone();
    let sid_end = session_id.clone();
    let context2 = context.clone();
    let handle = tokio::spawn(async move {
        // Prefer waiting on the Kubernetes status; fall back to IO completion.
        if let Some(status) = status_fut {
            let _ = status.await;
            out_task.abort();
            in_task.abort();
        } else {
            let _ = tokio::join!(out_task, in_task);
        }
        // Keep AttachedProcess alive until here so the WS loop isn't aborted early.
        drop(attached);
        let _ = app_end.emit("k8s://exec-end", json!({ "sessionId": sid_end }));
    });

    manager.register_exec(&context2, session_id, handle)?;
    Ok(())
}

pub fn stop_exec(manager: &ClusterManager, context: &str, session_id: &str) -> Result<()> {
    manager.stop_exec(context, session_id)
}
