use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context};
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use kube::client::Client;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Config, Resource};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::error::{KubyError, Result};
use crate::k8s::auth::{describe_auth, AuthSummary};
use crate::k8s::discovery::DiscoveryCache;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub current: bool,
    pub auth: AuthSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStatus {
    pub context: String,
    pub connected: bool,
    pub server: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

struct ClusterHandle {
    client: Client,
    #[allow(dead_code)]
    config: Config,
    discovery: Arc<Mutex<DiscoveryCache>>,
    watches: HashMap<String, JoinHandle<()>>,
    log_streams: HashMap<String, JoinHandle<()>>,
    exec_sessions: HashMap<String, JoinHandle<()>>,
    port_forwards: HashMap<String, JoinHandle<()>>,
}

pub struct ClusterManager {
    inner: RwLock<HashMap<String, ClusterHandle>>,
    active: RwLock<Vec<String>>,
}

impl ClusterManager {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            active: RwLock::new(Vec::new()),
        }
    }

    pub fn load_kubeconfig() -> Result<Kubeconfig> {
        // Honors KUBECONFIG (colon/semicolon separated) via kube-rs helpers.
        let cfg = Kubeconfig::read().context("failed to read kubeconfig")?;
        Ok(cfg)
    }

    pub fn list_contexts() -> Result<Vec<ContextInfo>> {
        let cfg = Self::load_kubeconfig()?;
        let current = cfg.current_context.clone().unwrap_or_default();
        let mut out = Vec::new();
        for ctx in cfg.contexts.iter() {
            let name = ctx.name.clone();
            let cluster = ctx
                .context
                .as_ref()
                .map(|c| c.cluster.clone())
                .unwrap_or_default();
            let user = ctx
                .context
                .as_ref()
                .and_then(|c| c.user.clone())
                .unwrap_or_default();
            let namespace = ctx.context.as_ref().and_then(|c| c.namespace.clone());
            let auth = describe_auth(&cfg, &user);
            out.push(ContextInfo {
                name: name.clone(),
                cluster,
                user,
                namespace,
                current: name == current,
                auth,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub async fn connect(&self, context: &str) -> Result<ClusterStatus> {
        if self.inner.read().contains_key(context) {
            return self.test_connection(context).await;
        }

        let auth = Self::auth_for_context(context);

        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };
        let config = match Config::from_kubeconfig(&options).await {
            Ok(cfg) => cfg,
            Err(err) => {
                let err = anyhow::Error::from(err)
                    .context(format!("failed to load config for context {context}"));
                tracing::error!(
                    context,
                    error = %format!("{err:#}"),
                    path = ?std::env::var("PATH").ok(),
                    auth_method = auth.as_ref().map(|a| a.method.as_str()),
                    exec_command = auth.as_ref().and_then(|a| a.exec_command.as_deref()),
                    "failed to load config for context"
                );
                return Err(err.into());
            }
        };
        let server = Some(config.cluster_url.to_string());
        let client = match Client::try_from(config.clone()) {
            Ok(c) => c,
            Err(err) => {
                let err = anyhow::Error::from(err)
                    .context(format!("failed to build client for context {context}"));
                tracing::error!(
                    context,
                    error = %format!("{err:#}"),
                    path = ?std::env::var("PATH").ok(),
                    auth_method = auth.as_ref().map(|a| a.method.as_str()),
                    exec_command = auth.as_ref().and_then(|a| a.exec_command.as_deref()),
                    "failed to build client for context"
                );
                return Err(err.into());
            }
        };

        let mut discovery = DiscoveryCache::new(client.clone());
        if let Err(err) = discovery.refresh().await {
            warn!(context, error = %err, "initial discovery failed");
        }

        let handle = ClusterHandle {
            client,
            config,
            discovery: Arc::new(Mutex::new(discovery)),
            watches: HashMap::new(),
            log_streams: HashMap::new(),
            exec_sessions: HashMap::new(),
            port_forwards: HashMap::new(),
        };
        self.inner.write().insert(context.to_string(), handle);
        {
            let mut active = self.active.write();
            if !active.iter().any(|c| c == context) {
                active.push(context.to_string());
            }
        }
        info!(context, "connected cluster");
        let mut status = self.test_connection(context).await?;
        status.server = server;
        Ok(status)
    }

    fn auth_for_context(context: &str) -> Option<AuthSummary> {
        let cfg = Self::load_kubeconfig().ok()?;
        let user = cfg
            .contexts
            .iter()
            .find(|c| c.name == context)
            .and_then(|c| c.context.as_ref())
            .and_then(|c| c.user.clone())?;
        Some(describe_auth(&cfg, &user))
    }

    pub async fn disconnect(&self, context: &str) -> Result<()> {
        let mut map = self.inner.write();
        if let Some(mut handle) = map.remove(context) {
            for (_, task) in handle.watches.drain() {
                task.abort();
            }
            for (_, task) in handle.log_streams.drain() {
                task.abort();
            }
            for (_, task) in handle.exec_sessions.drain() {
                task.abort();
            }
            for (_, task) in handle.port_forwards.drain() {
                task.abort();
            }
        }
        self.active.write().retain(|c| c != context);
        Ok(())
    }

    pub fn active_contexts(&self) -> Vec<String> {
        self.active.read().clone()
    }

    pub fn client(&self, context: &str) -> Result<Client> {
        self.inner
            .read()
            .get(context)
            .map(|h| h.client.clone())
            .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))
    }

    pub fn default_namespace(&self, context: &str) -> String {
        self.inner
            .read()
            .get(context)
            .map(|h| h.config.default_namespace.clone())
            .filter(|ns| !ns.is_empty())
            .unwrap_or_else(|| "default".to_string())
    }

    pub async fn discovery(&self, context: &str) -> Result<DiscoveryCache> {
        let discovery = {
            let map = self.inner.read();
            let handle = map
                .get(context)
                .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
            handle.discovery.clone()
        };
        let guard = discovery.lock().await;
        Ok(guard.clone())
    }

    pub async fn refresh_discovery(&self, context: &str) -> Result<DiscoveryCache> {
        let discovery = {
            let map = self.inner.read();
            let handle = map
                .get(context)
                .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
            handle.discovery.clone()
        };
        let mut guard = discovery.lock().await;
        guard.refresh().await?;
        Ok(guard.clone())
    }

    pub async fn test_connection(&self, context: &str) -> Result<ClusterStatus> {
        let client = self.client(context)?;
        match client.apiserver_version().await {
            Ok(v) => Ok(ClusterStatus {
                context: context.to_string(),
                connected: true,
                server: None,
                version: Some(format!("{}.{}", v.major, v.minor)),
                error: None,
            }),
            Err(err) => Ok(ClusterStatus {
                context: context.to_string(),
                connected: false,
                server: None,
                version: None,
                error: Some(err.to_string()),
            }),
        }
    }

    pub fn register_watch(&self, context: &str, key: String, handle: JoinHandle<()>) -> Result<()> {
        let mut map = self.inner.write();
        let cluster = map
            .get_mut(context)
            .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
        if let Some(prev) = cluster.watches.insert(key, handle) {
            prev.abort();
        }
        Ok(())
    }

    pub fn stop_watch(&self, context: &str, key: &str) -> Result<()> {
        let mut map = self.inner.write();
        if let Some(cluster) = map.get_mut(context) {
            if let Some(prev) = cluster.watches.remove(key) {
                prev.abort();
            }
        }
        Ok(())
    }

    pub fn register_log_stream(
        &self,
        context: &str,
        key: String,
        handle: JoinHandle<()>,
    ) -> Result<()> {
        let mut map = self.inner.write();
        let cluster = map
            .get_mut(context)
            .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
        if let Some(prev) = cluster.log_streams.insert(key, handle) {
            prev.abort();
        }
        Ok(())
    }

    pub fn stop_log_stream(&self, context: &str, key: &str) -> Result<()> {
        let mut map = self.inner.write();
        if let Some(cluster) = map.get_mut(context) {
            if let Some(prev) = cluster.log_streams.remove(key) {
                prev.abort();
            }
        }
        Ok(())
    }

    pub fn register_exec(&self, context: &str, key: String, handle: JoinHandle<()>) -> Result<()> {
        let mut map = self.inner.write();
        let cluster = map
            .get_mut(context)
            .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
        if let Some(prev) = cluster.exec_sessions.insert(key, handle) {
            prev.abort();
        }
        Ok(())
    }

    pub fn stop_exec(&self, context: &str, key: &str) -> Result<()> {
        let mut map = self.inner.write();
        if let Some(cluster) = map.get_mut(context) {
            if let Some(prev) = cluster.exec_sessions.remove(key) {
                prev.abort();
            }
        }
        Ok(())
    }

    pub fn register_port_forward(
        &self,
        context: &str,
        key: String,
        handle: JoinHandle<()>,
    ) -> Result<()> {
        let mut map = self.inner.write();
        let cluster = map
            .get_mut(context)
            .ok_or_else(|| KubyError::Message(format!("cluster not connected: {context}")))?;
        if let Some(prev) = cluster.port_forwards.insert(key, handle) {
            prev.abort();
        }
        Ok(())
    }

    pub fn stop_port_forward(&self, context: &str, key: &str) -> Result<()> {
        let mut map = self.inner.write();
        if let Some(cluster) = map.get_mut(context) {
            if let Some(prev) = cluster.port_forwards.remove(key) {
                prev.abort();
            }
        }
        Ok(())
    }

    pub async fn resolve_api(
        &self,
        context: &str,
        api_version: &str,
        kind: &str,
        namespace: Option<&str>,
    ) -> Result<(kube::Api<DynamicObject>, ApiResource)> {
        let client = self.client(context)?;
        let cache = self.discovery(context).await?;
        let (ar, namespaced) = cache
            .resolve(api_version, kind)?
            .ok_or_else(|| anyhow!("unknown resource {api_version}/{kind}"))?;
        let api = if namespaced {
            match namespace {
                Some("") | None | Some("*") => kube::Api::all_with(client, &ar),
                Some(ns) => kube::Api::namespaced_with(client, ns, &ar),
            }
        } else {
            kube::Api::all_with(client, &ar)
        };
        Ok((api, ar))
    }

    pub fn parse_gvk(api_version: &str, kind: &str) -> GroupVersionKind {
        let (group, version) = if let Some((g, v)) = api_version.split_once('/') {
            (g.to_string(), v.to_string())
        } else {
            (String::new(), api_version.to_string())
        };
        GroupVersionKind {
            group,
            version,
            kind: kind.to_string(),
        }
    }

    pub fn dynamic_from_yaml(yaml: &str) -> Result<DynamicObject> {
        let value: serde_yaml::Value = serde_yaml::from_str(yaml)?;
        let obj: DynamicObject = serde_json::from_value(serde_json::to_value(value)?)?;
        if obj.types.is_none() {
            return Err(KubyError::Message(
                "YAML missing apiVersion/kind".to_string(),
            ));
        }
        if obj.metadata.name.as_deref().unwrap_or("").is_empty() {
            return Err(KubyError::Message("YAML missing metadata.name".to_string()));
        }
        Ok(obj)
    }

    pub fn strip_managed_fields(mut obj: DynamicObject) -> DynamicObject {
        obj.metadata.managed_fields = None;
        obj
    }

    pub fn ensure_meta(obj: &mut DynamicObject) {
        let _ = Resource::meta(obj);
    }
}

impl Default for ClusterManager {
    fn default() -> Self {
        Self::new()
    }
}
