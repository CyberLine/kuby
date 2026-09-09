use std::collections::HashMap;

use anyhow::Context;
use kube::api::ApiResource;
use kube::client::Client;
use kube::discovery::{Discovery, Scope};
use serde::{Deserialize, Serialize};

use crate::error::{KubyError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredResource {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub singular: String,
    pub short_names: Vec<String>,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    pub api_version: String,
    pub curated: bool,
    /// False for create-only APIs such as TokenReview (no LIST/WATCH).
    pub watchable: bool,
}

#[derive(Clone)]
pub struct DiscoveryCache {
    client: Client,
    by_gvk: HashMap<String, ApiResource>,
    resources: Vec<DiscoveredResource>,
}

impl DiscoveryCache {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            by_gvk: HashMap::new(),
            resources: Vec::new(),
        }
    }

    pub async fn refresh(&mut self) -> Result<()> {
        let discovery = Discovery::new(self.client.clone())
            .run()
            .await
            .context("API discovery failed")?;

        let mut by_gvk = HashMap::new();
        let mut resources = Vec::new();

        for group in discovery.groups() {
            for (ar, caps) in group.recommended_resources() {
                let api_version = ar.api_version.clone();
                let key = format!("{api_version}/{}", ar.kind);
                let namespaced = matches!(caps.scope, Scope::Namespaced);
                let curated = is_curated(&ar.group, &ar.kind);
                resources.push(DiscoveredResource {
                    group: ar.group.clone(),
                    version: ar.version.clone(),
                    kind: ar.kind.clone(),
                    plural: ar.plural.clone(),
                    singular: ar.kind.to_lowercase(),
                    short_names: Vec::new(),
                    namespaced,
                    verbs: caps.operations.clone(),
                    api_version: api_version.clone(),
                    curated,
                    watchable: is_watchable(&ar.group, &ar.kind, &caps.operations),
                });
                by_gvk.insert(key, ar);
            }
        }

        resources.sort_by(|a, b| {
            b.curated
                .cmp(&a.curated)
                .then(a.kind.cmp(&b.kind))
                .then(a.group.cmp(&b.group))
        });

        self.by_gvk = by_gvk;
        self.resources = resources;
        Ok(())
    }

    pub fn resources(&self) -> &[DiscoveredResource] {
        &self.resources
    }

    pub fn resolve(&self, api_version: &str, kind: &str) -> Result<Option<(ApiResource, bool)>> {
        let key = format!("{api_version}/{kind}");
        if let Some(ar) = self.by_gvk.get(&key) {
            let namespaced = self
                .resources
                .iter()
                .find(|r| r.api_version == api_version && r.kind == kind)
                .map(|r| r.namespaced)
                .unwrap_or(true);
            return Ok(Some((ar.clone(), namespaced)));
        }
        let mut matches: Vec<_> = self
            .resources
            .iter()
            .filter(|r| r.kind.eq_ignore_ascii_case(kind))
            .collect();
        if matches.is_empty() {
            return Ok(None);
        }
        matches.sort_by_key(|r| (!r.curated, r.group.clone(), r.version.clone()));
        let best = matches[0];
        let key = format!("{}/{}", best.api_version, best.kind);
        Ok(self
            .by_gvk
            .get(&key)
            .cloned()
            .map(|ar| (ar, best.namespaced)))
    }

    pub fn resolve_or_err(&self, api_version: &str, kind: &str) -> Result<(ApiResource, bool)> {
        self.resolve(api_version, kind)?
            .ok_or_else(|| KubyError::Message(format!("resource not found: {api_version}/{kind}")))
    }

    pub fn is_watchable(&self, api_version: &str, kind: &str) -> bool {
        if let Some(r) = self
            .resources
            .iter()
            .find(|r| r.api_version == api_version && r.kind == kind)
        {
            return r.watchable;
        }
        self.resources
            .iter()
            .find(|r| r.kind.eq_ignore_ascii_case(kind))
            .map(|r| r.watchable)
            .unwrap_or(true)
    }
}

fn is_curated(group: &str, kind: &str) -> bool {
    CURATED.iter().any(|(g, k)| *g == group && *k == kind)
}

/// Kubernetes review/binding APIs that only support CREATE, never LIST/WATCH.
const CREATE_ONLY: &[(&str, &str)] = &[
    ("authentication.k8s.io", "TokenReview"),
    ("authentication.k8s.io", "SelfSubjectReview"),
    ("authorization.k8s.io", "SelfSubjectAccessReview"),
    ("authorization.k8s.io", "SelfSubjectRulesReview"),
    ("authorization.k8s.io", "SubjectAccessReview"),
    ("authorization.k8s.io", "LocalSubjectAccessReview"),
    ("", "Binding"),
];

pub fn is_watchable(group: &str, kind: &str, verbs: &[String]) -> bool {
    if CREATE_ONLY.iter().any(|(g, k)| *g == group && *k == kind) {
        return false;
    }
    if verbs.is_empty() {
        return true;
    }
    verbs.iter().any(|v| v == "list" || v == "watch")
}

const CURATED: &[(&str, &str)] = &[
    ("", "Pod"),
    ("", "Service"),
    ("", "ConfigMap"),
    ("", "Secret"),
    ("", "Namespace"),
    ("", "Node"),
    ("", "PersistentVolume"),
    ("", "PersistentVolumeClaim"),
    ("", "ServiceAccount"),
    ("", "Endpoints"),
    ("", "Event"),
    ("", "LimitRange"),
    ("", "ResourceQuota"),
    ("apps", "Deployment"),
    ("apps", "ReplicaSet"),
    ("apps", "StatefulSet"),
    ("apps", "DaemonSet"),
    ("apps", "ControllerRevision"),
    ("batch", "Job"),
    ("batch", "CronJob"),
    ("networking.k8s.io", "Ingress"),
    ("networking.k8s.io", "NetworkPolicy"),
    ("networking.k8s.io", "IngressClass"),
    ("rbac.authorization.k8s.io", "Role"),
    ("rbac.authorization.k8s.io", "RoleBinding"),
    ("rbac.authorization.k8s.io", "ClusterRole"),
    ("rbac.authorization.k8s.io", "ClusterRoleBinding"),
    ("storage.k8s.io", "StorageClass"),
    ("policy", "PodDisruptionBudget"),
    ("autoscaling", "HorizontalPodAutoscaler"),
];
