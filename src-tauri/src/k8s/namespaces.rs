//! Active vs terminating namespaces.
//!
//! Cluster-wide LIST/WATCH walks every namespace. A large set of namespaces
//! stuck in Terminating makes those calls hang, so bulk reads must skip them.

use std::collections::HashSet;

use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use kube::ResourceExt;

use crate::error::Result;

/// How many namespace-scoped calls to run at once.
pub const BULK_CONCURRENCY: usize = 8;

#[derive(Clone, Debug, Default)]
pub struct NamespaceIndex {
    pub active: Vec<String>,
    terminating: HashSet<String>,
}

impl NamespaceIndex {
    pub fn has_terminating(&self) -> bool {
        !self.terminating.is_empty()
    }

    pub fn is_terminating(&self, name: &str) -> bool {
        self.terminating.contains(name)
    }

    pub fn terminating_list(&self) -> Vec<String> {
        let mut names: Vec<_> = self.terminating.iter().cloned().collect();
        names.sort();
        names
    }
}

/// Cluster-wide call, or an explicit set of namespaces that excludes Terminating.
#[derive(Clone, Debug)]
pub enum NamespaceScope {
    All,
    Only(Vec<String>),
}

pub fn is_terminating(ns: &Namespace) -> bool {
    if ns.metadata.deletion_timestamp.is_some() {
        return true;
    }
    ns.status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        == Some("Terminating")
}

pub fn index_from_items(items: Vec<Namespace>) -> NamespaceIndex {
    let mut active = Vec::new();
    let mut terminating = HashSet::new();
    for ns in items {
        let name = ns.name_any();
        if name.is_empty() {
            continue;
        }
        if is_terminating(&ns) {
            terminating.insert(name);
        } else {
            active.push(name);
        }
    }
    active.sort();
    active.dedup();
    NamespaceIndex {
        active,
        terminating,
    }
}

pub async fn load_index(client: kube::Client) -> Result<NamespaceIndex> {
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    Ok(index_from_items(list.items))
}

/// `requested` is the UI selection. `"*"` (or empty) means every namespace.
///
/// Terminating namespaces are never included. When none are terminating, `"*"`
/// stays a single cluster-wide request.
pub fn resolve_scope(index: &NamespaceIndex, requested: &[String]) -> NamespaceScope {
    let wants_all = requested.is_empty() || requested.iter().any(|n| n.is_empty() || n == "*");
    if wants_all {
        if index.has_terminating() {
            NamespaceScope::Only(index.active.clone())
        } else {
            NamespaceScope::All
        }
    } else {
        NamespaceScope::Only(
            requested
                .iter()
                .filter(|n| !n.is_empty() && *n != "*" && !index.is_terminating(n))
                .cloned()
                .collect(),
        )
    }
}

pub fn requested_names(namespace: Option<&str>) -> Vec<String> {
    match namespace {
        Some(ns) if !ns.is_empty() && ns != "*" => vec![ns.to_string()],
        _ => vec!["*".to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};
    use k8s_openapi::jiff::Timestamp;

    fn ns(name: &str, phase: &str, deleting: bool) -> Namespace {
        Namespace {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                deletion_timestamp: deleting.then_some(Time(Timestamp::UNIX_EPOCH)),
                ..ObjectMeta::default()
            },
            status: Some(k8s_openapi::api::core::v1::NamespaceStatus {
                phase: Some(phase.to_string()),
                ..Default::default()
            }),
            ..Namespace::default()
        }
    }

    #[test]
    fn phase_and_deletion_timestamp_are_terminating() {
        assert!(!is_terminating(&ns("app", "Active", false)));
        assert!(is_terminating(&ns("old", "Terminating", false)));
        assert!(is_terminating(&ns("stuck", "Active", true)));
    }

    #[test]
    fn wildcard_stays_cluster_wide_without_terminating() {
        let index = index_from_items(vec![ns("a", "Active", false), ns("b", "Active", false)]);
        assert!(matches!(
            resolve_scope(&index, &["*".into()]),
            NamespaceScope::All
        ));
    }

    #[test]
    fn wildcard_skips_terminating_namespaces() {
        let index = index_from_items(vec![
            ns("a", "Active", false),
            ns("gone", "Terminating", false),
            ns("stuck", "Active", true),
        ]);
        match resolve_scope(&index, &["*".into()]) {
            NamespaceScope::Only(names) => assert_eq!(names, vec!["a".to_string()]),
            NamespaceScope::All => panic!("expected per-namespace scope"),
        }
    }

    #[test]
    fn explicit_selection_drops_terminating() {
        let index = index_from_items(vec![
            ns("a", "Active", false),
            ns("gone", "Terminating", false),
        ]);
        match resolve_scope(&index, &["a".into(), "gone".into()]) {
            NamespaceScope::Only(names) => assert_eq!(names, vec!["a".to_string()]),
            NamespaceScope::All => panic!("expected explicit scope"),
        }
    }
}
