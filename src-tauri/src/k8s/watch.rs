use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DynamicObject, LogParams, ResourceExt};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncBufReadExt;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tracing::warn;

use crate::error::{
    kube_api_message, kube_is_forbidden, kube_is_method_not_allowed, KubyError, Result,
};
use crate::k8s::ClusterManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEventPayload {
    pub context: String,
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub event: String,
    pub object: Option<serde_json::Value>,
    pub objects: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchErrorPayload {
    pub context: String,
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub error: String,
}

pub fn watch_key(context: &str, api_version: &str, kind: &str, namespace: Option<&str>) -> String {
    format!(
        "{context}|{api_version}|{kind}|{}",
        namespace.unwrap_or("*")
    )
}

pub async fn start_watch(
    app: AppHandle,
    manager: Arc<ClusterManager>,
    context: String,
    api_version: String,
    kind: String,
    namespace: Option<String>,
) -> Result<String> {
    let key = watch_key(&context, &api_version, &kind, namespace.as_deref());
    let cache = manager.discovery(&context).await?;
    if !cache.is_watchable(&api_version, &kind) {
        return Err(KubyError::Message(format!(
            "{kind} cannot be listed or watched; Kubernetes only allows creating this resource"
        )));
    }

    let (api, _ar) = manager
        .resolve_api(&context, &api_version, &kind, namespace.as_deref())
        .await?;

    let app2 = app.clone();
    let context2 = context.clone();
    let api_version2 = api_version.clone();
    let kind2 = kind.clone();
    let namespace2 = namespace.clone();

    let handle = tokio::spawn(async move {
        let stream = watcher::watcher(api, watcher::Config::default()).default_backoff();
        futures::pin_mut!(stream);
        let mut init_buffer: Vec<DynamicObject> = Vec::new();

        while let Some(item) = stream.next().await {
            match item {
                Ok(ev) => {
                    let payload = match ev {
                        Event::Init => {
                            init_buffer.clear();
                            None
                        }
                        Event::InitApply(obj) => {
                            init_buffer.push(obj);
                            None
                        }
                        Event::InitDone => Some(WatchEventPayload {
                            context: context2.clone(),
                            api_version: api_version2.clone(),
                            kind: kind2.clone(),
                            namespace: namespace2.clone(),
                            event: "restarted".into(),
                            object: None,
                            objects: Some(
                                init_buffer.drain(..).map(|o| object_to_json(&o)).collect(),
                            ),
                        }),
                        Event::Apply(obj) => Some(WatchEventPayload {
                            context: context2.clone(),
                            api_version: api_version2.clone(),
                            kind: kind2.clone(),
                            namespace: namespace2.clone(),
                            event: "applied".into(),
                            object: Some(object_to_json(&obj)),
                            objects: None,
                        }),
                        Event::Delete(obj) => Some(WatchEventPayload {
                            context: context2.clone(),
                            api_version: api_version2.clone(),
                            kind: kind2.clone(),
                            namespace: namespace2.clone(),
                            event: "deleted".into(),
                            object: Some(object_to_json(&obj)),
                            objects: None,
                        }),
                    };

                    if let Some(payload) = payload {
                        if let Err(err) = app2.emit("k8s://watch", payload) {
                            warn!(error = %err, "failed to emit watch event");
                            break;
                        }
                    }
                }
                Err(err) => {
                    let unrecoverable = is_unrecoverable_watch_error(&err);
                    let message = watch_error_message(&err);
                    warn!(error = %message, unrecoverable, "watch error");
                    let _ = app2.emit(
                        "k8s://watch-error",
                        WatchErrorPayload {
                            context: context2.clone(),
                            api_version: api_version2.clone(),
                            kind: kind2.clone(),
                            namespace: namespace2.clone(),
                            error: message,
                        },
                    );
                    if unrecoverable {
                        break;
                    }
                }
            }
        }
    });

    manager.register_watch(&context, key.clone(), handle)?;
    Ok(key)
}

pub fn stop_watch(manager: &ClusterManager, context: &str, key: &str) -> Result<()> {
    manager.stop_watch(context, key)
}

fn is_unrecoverable_watch_error(err: &watcher::Error) -> bool {
    match err {
        watcher::Error::InitialListFailed(e)
        | watcher::Error::WatchStartFailed(e)
        | watcher::Error::WatchFailed(e) => kube_is_method_not_allowed(e) || kube_is_forbidden(e),
        watcher::Error::WatchError(status) => status.code == 403 || status.code == 405,
        watcher::Error::NoResourceVersion => true,
    }
}

fn watch_error_message(err: &watcher::Error) -> String {
    match err {
        watcher::Error::InitialListFailed(e)
        | watcher::Error::WatchStartFailed(e)
        | watcher::Error::WatchFailed(e) => kube_api_message(e),
        watcher::Error::WatchError(status) if !status.message.is_empty() => status.message.clone(),
        other => other.to_string(),
    }
}

fn object_to_json(obj: &DynamicObject) -> serde_json::Value {
    let mut value = serde_json::to_value(obj).unwrap_or(json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("uid".into(), json!(obj.uid().unwrap_or_default()));
        map.insert("name".into(), json!(obj.name_any()));
        map.insert(
            "namespace".into(),
            json!(obj.namespace().unwrap_or_default()),
        );
    }
    value
}

pub async fn start_log_stream(
    app: AppHandle,
    manager: Arc<ClusterManager>,
    stream_id: String,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    previous: bool,
    tail_lines: Option<i64>,
) -> Result<String> {
    let client = manager.client(&context)?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut params = LogParams {
        follow: true,
        timestamps: true,
        previous,
        ..LogParams::default()
    };
    if let Some(c) = container {
        params.container = Some(c);
    }
    if let Some(tail) = tail_lines {
        params.tail_lines = Some(tail);
    }

    let app2 = app.clone();
    let stream_id2 = stream_id.clone();
    let context2 = context.clone();
    let namespace2 = namespace.clone();
    let pod2 = pod.clone();

    let handle = tokio::spawn(async move {
        let stream = match api.log_stream(&pod2, &params).await {
            Ok(s) => s,
            Err(err) => {
                let _ = app2.emit(
                    "k8s://log-error",
                    json!({ "streamId": stream_id2, "error": err.to_string() }),
                );
                return;
            }
        };

        let reader = tokio::io::BufReader::new(stream.compat());
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app2.emit(
                "k8s://log",
                json!({
                    "streamId": stream_id2,
                    "context": context2,
                    "namespace": namespace2,
                    "pod": pod2,
                    "line": line,
                }),
            );
        }
        let _ = app2.emit("k8s://log-end", json!({ "streamId": stream_id2 }));
    });

    manager.register_log_stream(&context, stream_id.clone(), handle)?;
    Ok(stream_id)
}

pub fn stop_log_stream(manager: &ClusterManager, context: &str, stream_id: &str) -> Result<()> {
    manager.stop_log_stream(context, stream_id)
}
