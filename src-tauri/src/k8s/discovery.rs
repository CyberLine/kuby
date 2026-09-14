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
    /// False for create-only APIs such as TokenReview (no LIST).
    pub listable: bool,
    /// False when the API has no WATCH verb, or objects lack resourceVersion (metrics.k8s.io).
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
                    listable: is_listable(&ar.group, &ar.kind, &caps.operations),
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

    pub fn is_listable(&self, api_version: &str, kind: &str) -> bool {
        self.lookup(api_version, kind)
            .map(|r| r.listable)
            .unwrap_or(true)
    }

    pub fn is_watchable(&self, api_version: &str, kind: &str) -> bool {
        self.lookup(api_version, kind)
            .map(|r| r.watchable)
            .unwrap_or(true)
    }

    fn lookup(&self, api_version: &str, kind: &str) -> Option<&DiscoveredResource> {
        self.resources
            .iter()
            .find(|r| r.api_version == api_version && r.kind == kind)
            .or_else(|| {
                self.resources
                    .iter()
                    .find(|r| r.kind.eq_ignore_ascii_case(kind))
            })
    }
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

/// Aggregated metrics APIs are list-only: objects are computed and have no resourceVersion.
const LIST_ONLY_GROUPS: &[&str] = &[
    "metrics.k8s.io",
    "custom.metrics.k8s.io",
    "external.metrics.k8s.io",
];

fn has_verb(verbs: &[String], verb: &str) -> bool {
    verbs.iter().any(|v| v.eq_ignore_ascii_case(verb))
}

fn is_create_only(group: &str, kind: &str) -> bool {
    CREATE_ONLY.iter().any(|(g, k)| *g == group && *k == kind)
}

fn is_list_only_group(group: &str) -> bool {
    LIST_ONLY_GROUPS.contains(&group)
}

pub fn is_listable(group: &str, kind: &str, verbs: &[String]) -> bool {
    if is_create_only(group, kind) {
        return false;
    }
    if verbs.is_empty() {
        return true;
    }
    has_verb(verbs, "list")
}

pub fn is_watchable(group: &str, kind: &str, verbs: &[String]) -> bool {
    if is_create_only(group, kind) || is_list_only_group(group) {
        return false;
    }
    if verbs.is_empty() {
        return true;
    }
    has_verb(verbs, "watch")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verbs(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn metrics_are_listable_but_not_watchable() {
        let v = verbs(&["get", "list"]);
        assert!(is_listable("metrics.k8s.io", "PodMetrics", &v));
        assert!(!is_watchable("metrics.k8s.io", "PodMetrics", &v));
        assert!(is_listable("metrics.k8s.io", "NodeMetrics", &v));
        assert!(!is_watchable("metrics.k8s.io", "NodeMetrics", &v));
    }

    #[test]
    fn metrics_stay_unwatchable_even_if_watch_is_advertised() {
        let v = verbs(&["get", "list", "watch"]);
        assert!(!is_watchable("metrics.k8s.io", "PodMetrics", &v));
        assert!(!is_watchable("custom.metrics.k8s.io", "MetricValue", &v));
    }

    #[test]
    fn pods_are_listable_and_watchable() {
        let v = verbs(&["get", "list", "watch", "create"]);
        assert!(is_listable("", "Pod", &v));
        assert!(is_watchable("", "Pod", &v));
    }

    #[test]
    fn token_review_is_neither() {
        let v = verbs(&["create"]);
        assert!(!is_listable("authentication.k8s.io", "TokenReview", &v));
        assert!(!is_watchable("authentication.k8s.io", "TokenReview", &v));
    }

    #[test]
    fn generic_list_without_watch_skips_watch() {
        let v = verbs(&["get", "list"]);
        assert!(is_listable("example.com", "Foo", &v));
        assert!(!is_watchable("example.com", "Foo", &v));
    }
}
