use std::net::SocketAddr;
use std::sync::Arc;

use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, warn};

use crate::error::{KubyError, Result};
use crate::k8s::ClusterManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub local_port: u16,
    pub remote_port: u16,
}

pub async fn start_port_forward(
    app: AppHandle,
    manager: Arc<ClusterManager>,
    id: String,
    context: String,
    namespace: String,
    pod: String,
    local_port: u16,
    remote_port: u16,
) -> Result<PortForwardInfo> {
    let client = manager.client(&context)?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], local_port)))
        .await
        .map_err(|e| KubyError::Message(format!("bind local port {local_port}: {e}")))?;
    let bound = listener.local_addr()?.port();

    let app2 = app.clone();
    let id2 = id.clone();
    let context2 = context.clone();
    let namespace2 = namespace.clone();
    let pod2 = pod.clone();

    let handle = tokio::spawn(async move {
        let pf_result = api.portforward(&pod2, &[remote_port]).await;
        let mut pf = match pf_result {
            Ok(pf) => pf,
            Err(err) => {
                let _ = app2.emit(
                    "k8s://portforward-error",
                    json!({ "id": id2, "error": err.to_string() }),
                );
                return;
            }
        };

        let _ = app2.emit(
            "k8s://portforward",
            json!({
                "id": id2,
                "event": "ready",
                "localPort": bound,
                "remotePort": remote_port,
                "context": context2,
                "namespace": namespace2,
                "pod": pod2,
            }),
        );

        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(s) => s,
                Err(err) => {
                    warn!(error = %err, "port-forward accept error");
                    break;
                }
            };

            let stream = match pf.take_stream(remote_port) {
                Some(s) => s,
                None => match api.portforward(&pod2, &[remote_port]).await {
                    Ok(mut new_pf) => {
                        let s = match new_pf.take_stream(remote_port) {
                            Some(s) => s,
                            None => continue,
                        };
                        pf = new_pf;
                        s
                    }
                    Err(err) => {
                        warn!(error = %err, "port-forward reopen failed");
                        break;
                    }
                },
            };

            tokio::spawn(async move {
                let (mut sock_r, mut sock_w) = socket.split();
                let (mut pf_r, mut pf_w) = tokio::io::split(stream);
                let client_to_pod = async {
                    let mut buf = [0u8; 8192];
                    loop {
                        let n = sock_r.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        pf_w.write_all(&buf[..n]).await?;
                    }
                    Ok::<(), std::io::Error>(())
                };
                let pod_to_client = async {
                    let mut buf = [0u8; 8192];
                    loop {
                        let n = pf_r.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        sock_w.write_all(&buf[..n]).await?;
                    }
                    Ok::<(), std::io::Error>(())
                };
                let _ = tokio::try_join!(client_to_pod, pod_to_client);
            });
        }

        let _ = app2.emit("k8s://portforward", json!({ "id": id2, "event": "closed" }));
    });

    manager.register_port_forward(&context, id.clone(), handle)?;
    info!(%id, local = bound, remote = remote_port, "port-forward started");

    Ok(PortForwardInfo {
        id,
        context,
        namespace,
        pod,
        local_port: bound,
        remote_port,
    })
}

pub fn stop_port_forward(manager: &ClusterManager, context: &str, id: &str) -> Result<()> {
    manager.stop_port_forward(context, id)
}
