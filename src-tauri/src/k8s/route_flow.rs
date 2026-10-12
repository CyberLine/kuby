use std::collections::HashSet;

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::api::discovery::v1::EndpointSlice;
use kube::api::ListParams;
use kube::Api;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{KubyError, Result};
use crate::k8s::ClusterManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFlowNode {
    pub id: String,
    pub kind: String,
    pub api_version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFlowGraph {
    pub nodes: Vec<RouteFlowNode>,
    pub edges: Vec<RouteFlowEdge>,
    pub notes: Vec<String>,
}

fn node_id(kind: &str, namespace: Option<&str>, name: &str) -> String {
    format!("{}/{}/{}", kind, namespace.unwrap_or(""), name)
}

fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(|x| x.as_str())
}

fn push_node(
    nodes: &mut Vec<RouteFlowNode>,
    seen: &mut HashSet<String>,
    kind: &str,
    api_version: &str,
    name: &str,
    namespace: Option<&str>,
    detail: Option<String>,
    status: Option<&str>,
) -> String {
    let id = node_id(kind, namespace, name);
    if seen.insert(id.clone()) {
        nodes.push(RouteFlowNode {
            id: id.clone(),
            kind: kind.to_string(),
            api_version: api_version.to_string(),
            name: name.to_string(),
            namespace: namespace.map(|s| s.to_string()),
            label: Some(name.to_string()),
            detail,
            status: status.map(|s| s.to_string()),
        });
    }
    id
}

fn push_edge(
    edges: &mut Vec<RouteFlowEdge>,
    seen: &mut HashSet<String>,
    source: &str,
    target: &str,
) {
    let id = format!("{source}->{target}");
    if seen.insert(id.clone()) {
        edges.push(RouteFlowEdge {
            id,
            source: source.to_string(),
            target: target.to_string(),
        });
    }
}

async fn resolve_service_pods(
    manager: &ClusterManager,
    context: &str,
    namespace: &str,
    service_name: &str,
    nodes: &mut Vec<RouteFlowNode>,
    edges: &mut Vec<RouteFlowEdge>,
    seen_nodes: &mut HashSet<String>,
    seen_edges: &mut HashSet<String>,
    from_id: &str,
) -> Result<()> {
    let svc_id = push_node(
        nodes,
        seen_nodes,
        "Service",
        "v1",
        service_name,
        Some(namespace),
        None,
        Some("ok"),
    );
    push_edge(edges, seen_edges, from_id, &svc_id);

    let client = manager.client(context)?;
    let slices: Api<EndpointSlice> = Api::namespaced(client.clone(), namespace);
    let label = format!("kubernetes.io/service-name={service_name}");
    let lp = ListParams::default().labels(&label);
    let list = match slices.list(&lp).await {
        Ok(l) => l,
        Err(_) => {
            return Ok(());
        }
    };

    let mut pod_names: HashSet<String> = HashSet::new();
    for slice in list.items {
        for ep in slice.endpoints.unwrap_or_default() {
            if let Some(target) = ep.target_ref {
                if target.kind.as_deref() == Some("Pod") {
                    if let Some(name) = target.name {
                        pod_names.insert(name);
                    }
                }
            }
        }
    }

    let pods_api: Api<Pod> = Api::namespaced(client, namespace);
    for pod_name in pod_names {
        let status = match pods_api.get(&pod_name).await {
            Ok(pod) => {
                let phase = pod.status.as_ref().and_then(|s| s.phase.clone());
                match phase.as_deref() {
                    Some("Running") => "ok",
                    Some("Failed") => "err",
                    _ => "idle",
                }
            }
            Err(_) => "idle",
        };
        let pod_id = push_node(
            nodes,
            seen_nodes,
            "Pod",
            "v1",
            &pod_name,
            Some(namespace),
            None,
            Some(status),
        );
        push_edge(edges, seen_edges, &svc_id, &pod_id);
    }
    Ok(())
}

async fn get_dynamic(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<Value> {
    let (api, _) = manager
        .resolve_api(context, api_version, kind, namespace)
        .await?;
    let obj = api.get(name).await.map_err(KubyError::from)?;
    Ok(serde_json::to_value(obj)?)
}

pub async fn build_route_flow(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<RouteFlowGraph> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen_nodes = HashSet::new();
    let mut seen_edges = HashSet::new();
    let mut notes = Vec::new();

    let root = get_dynamic(manager, context, api_version, kind, namespace, name).await?;
    let root_ns = namespace.map(|s| s.to_string()).or_else(|| {
        root.pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });
    let root_id = push_node(
        &mut nodes,
        &mut seen_nodes,
        kind,
        api_version,
        name,
        root_ns.as_deref(),
        None,
        Some("ok"),
    );

    let spec = root.get("spec").cloned().unwrap_or(Value::Null);

    if kind == "Ingress" {
        build_ingress(
            manager,
            context,
            &spec,
            root_ns.as_deref(),
            &root_id,
            &mut nodes,
            &mut edges,
            &mut seen_nodes,
            &mut seen_edges,
            &mut notes,
        )
        .await?;
    } else if kind.starts_with("IngressRoute") {
        build_traefik(
            manager,
            context,
            &spec,
            root_ns.as_deref(),
            &root_id,
            &mut nodes,
            &mut edges,
            &mut seen_nodes,
            &mut seen_edges,
            &mut notes,
        )
        .await?;
    } else if kind == "HTTPRoute"
        || kind == "GRPCRoute"
        || kind == "TCPRoute"
        || kind == "TLSRoute"
        || kind == "Gateway"
    {
        build_gateway(
            manager,
            context,
            kind,
            api_version,
            &spec,
            root_ns.as_deref(),
            &root_id,
            &mut nodes,
            &mut edges,
            &mut seen_nodes,
            &mut seen_edges,
            &mut notes,
        )
        .await?;
    } else {
        notes.push(format!("No specialized flow for {kind}"));
    }

    Ok(RouteFlowGraph {
        nodes,
        edges,
        notes,
    })
}

async fn build_ingress(
    manager: &ClusterManager,
    context: &str,
    spec: &Value,
    ns: Option<&str>,
    root_id: &str,
    nodes: &mut Vec<RouteFlowNode>,
    edges: &mut Vec<RouteFlowEdge>,
    seen_nodes: &mut HashSet<String>,
    seen_edges: &mut HashSet<String>,
    notes: &mut Vec<String>,
) -> Result<()> {
    let Some(namespace) = ns else {
        notes.push("Ingress has no namespace".into());
        return Ok(());
    };
    let mut services: HashSet<String> = HashSet::new();
    if let Some(rules) = spec.get("rules").and_then(|v| v.as_array()) {
        for rule in rules {
            if let Some(paths) = rule.pointer("/http/paths").and_then(|v| v.as_array()) {
                for path in paths {
                    if let Some(name) = as_str(path.pointer("/backend/service/name")) {
                        services.insert(name.to_string());
                    }
                }
            }
        }
    }
    if let Some(name) = as_str(spec.pointer("/defaultBackend/service/name")) {
        services.insert(name.to_string());
    }
    if let Some(secret) = as_str(spec.pointer("/tls/0/secretName")) {
        let tls_id = push_node(
            nodes,
            seen_nodes,
            "Secret",
            "v1",
            secret,
            Some(namespace),
            Some("TLS".into()),
            Some("ok"),
        );
        push_edge(edges, seen_edges, root_id, &tls_id);
    }
    for svc in services {
        resolve_service_pods(
            manager, context, namespace, &svc, nodes, edges, seen_nodes, seen_edges, root_id,
        )
        .await?;
    }
    Ok(())
}

async fn build_traefik(
    manager: &ClusterManager,
    context: &str,
    spec: &Value,
    ns: Option<&str>,
    root_id: &str,
    nodes: &mut Vec<RouteFlowNode>,
    edges: &mut Vec<RouteFlowEdge>,
    seen_nodes: &mut HashSet<String>,
    seen_edges: &mut HashSet<String>,
    notes: &mut Vec<String>,
) -> Result<()> {
    let Some(namespace) = ns else {
        notes.push("IngressRoute has no namespace".into());
        return Ok(());
    };

    if let Some(secret) = as_str(spec.pointer("/tls/secretName")) {
        let tls_id = push_node(
            nodes,
            seen_nodes,
            "Secret",
            "v1",
            secret,
            Some(namespace),
            Some("TLS".into()),
            Some("ok"),
        );
        push_edge(edges, seen_edges, root_id, &tls_id);
    }

    let routes = spec
        .get("routes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut last_mw: Option<String> = None;
    for route in &routes {
        if let Some(mws) = route.get("middlewares").and_then(|v| v.as_array()) {
            for mw in mws {
                let mw_name = match as_str(mw.get("name")) {
                    Some(n) => n,
                    None => continue,
                };
                let mw_ns = as_str(mw.get("namespace")).unwrap_or(namespace);
                let mw_id = push_node(
                    nodes,
                    seen_nodes,
                    "Middleware",
                    "traefik.io/v1alpha1",
                    mw_name,
                    Some(mw_ns),
                    None,
                    Some("ok"),
                );
                let from = last_mw.as_deref().unwrap_or(root_id);
                push_edge(edges, seen_edges, from, &mw_id);
                last_mw = Some(mw_id);
            }
        }
        let from = last_mw.as_deref().unwrap_or(root_id);
        if let Some(services) = route.get("services").and_then(|v| v.as_array()) {
            for svc in services {
                let svc_name = match as_str(svc.get("name")) {
                    Some(n) => n,
                    None => continue,
                };
                let svc_ns = as_str(svc.get("namespace")).unwrap_or(namespace);
                let svc_kind = as_str(svc.get("kind")).unwrap_or("Service");
                if svc_kind == "TraefikService" {
                    let ts_id = push_node(
                        nodes,
                        seen_nodes,
                        "TraefikService",
                        "traefik.io/v1alpha1",
                        svc_name,
                        Some(svc_ns),
                        None,
                        Some("ok"),
                    );
                    push_edge(edges, seen_edges, from, &ts_id);
                    // Best-effort: expand weighted services to core Services.
                    if let Ok(ts) = get_dynamic(
                        manager,
                        context,
                        "traefik.io/v1alpha1",
                        "TraefikService",
                        Some(svc_ns),
                        svc_name,
                    )
                    .await
                    {
                        if let Some(services) = ts
                            .pointer("/spec/weighted/services")
                            .and_then(|v| v.as_array())
                        {
                            for w in services {
                                if let Some(n) = as_str(w.get("name")) {
                                    let wns = as_str(w.get("namespace")).unwrap_or(svc_ns);
                                    resolve_service_pods(
                                        manager, context, wns, n, nodes, edges, seen_nodes,
                                        seen_edges, &ts_id,
                                    )
                                    .await?;
                                }
                            }
                        }
                    }
                } else {
                    resolve_service_pods(
                        manager, context, svc_ns, svc_name, nodes, edges, seen_nodes, seen_edges,
                        from,
                    )
                    .await?;
                }
            }
        }
        last_mw = None;
    }
    Ok(())
}

async fn build_gateway(
    manager: &ClusterManager,
    context: &str,
    kind: &str,
    api_version: &str,
    spec: &Value,
    ns: Option<&str>,
    root_id: &str,
    nodes: &mut Vec<RouteFlowNode>,
    edges: &mut Vec<RouteFlowEdge>,
    seen_nodes: &mut HashSet<String>,
    seen_edges: &mut HashSet<String>,
    notes: &mut Vec<String>,
) -> Result<()> {
    if kind == "Gateway" {
        if let Some(gc) = as_str(spec.get("gatewayClassName")) {
            let id = push_node(
                nodes,
                seen_nodes,
                "GatewayClass",
                api_version,
                gc,
                None,
                None,
                Some("ok"),
            );
            push_edge(edges, seen_edges, &id, root_id);
        }
        notes.push("Open an HTTPRoute attached to this Gateway to see backends.".into());
        return Ok(());
    }

    let namespace = ns.unwrap_or("");
    if let Some(parents) = spec.get("parentRefs").and_then(|v| v.as_array()) {
        for p in parents {
            let p_name = match as_str(p.get("name")) {
                Some(n) => n,
                None => continue,
            };
            let p_ns = as_str(p.get("namespace")).unwrap_or(namespace);
            let p_kind = as_str(p.get("kind")).unwrap_or("Gateway");
            let pid = push_node(
                nodes,
                seen_nodes,
                p_kind,
                api_version,
                p_name,
                if p_ns.is_empty() { None } else { Some(p_ns) },
                None,
                Some("ok"),
            );
            push_edge(edges, seen_edges, &pid, root_id);
        }
    }

    let mut filter_chain_end = root_id.to_string();
    if let Some(rules) = spec.get("rules").and_then(|v| v.as_array()) {
        for rule in rules {
            if let Some(filters) = rule.get("filters").and_then(|v| v.as_array()) {
                for (i, f) in filters.iter().enumerate() {
                    let ftype = as_str(f.get("type")).unwrap_or("Filter");
                    let fid = push_node(
                        nodes,
                        seen_nodes,
                        "Filter",
                        api_version,
                        &format!("{ftype}-{i}"),
                        if namespace.is_empty() {
                            None
                        } else {
                            Some(namespace)
                        },
                        Some(ftype.to_string()),
                        Some("ok"),
                    );
                    push_edge(edges, seen_edges, &filter_chain_end, &fid);
                    filter_chain_end = fid;
                }
            }
            if let Some(backends) = rule.get("backendRefs").and_then(|v| v.as_array()) {
                for b in backends {
                    let b_name = match as_str(b.get("name")) {
                        Some(n) => n,
                        None => continue,
                    };
                    let b_ns = as_str(b.get("namespace")).unwrap_or(namespace);
                    let b_kind = as_str(b.get("kind")).unwrap_or("Service");
                    if b_kind == "Service" && !b_ns.is_empty() {
                        resolve_service_pods(
                            manager,
                            context,
                            b_ns,
                            b_name,
                            nodes,
                            edges,
                            seen_nodes,
                            seen_edges,
                            &filter_chain_end,
                        )
                        .await?;
                    } else {
                        let bid = push_node(
                            nodes,
                            seen_nodes,
                            b_kind,
                            "v1",
                            b_name,
                            if b_ns.is_empty() { None } else { Some(b_ns) },
                            None,
                            Some("ok"),
                        );
                        push_edge(edges, seen_edges, &filter_chain_end, &bid);
                    }
                }
            }
            filter_chain_end = root_id.to_string();
        }
    }
    Ok(())
}
