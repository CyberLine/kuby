use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::error::{kube_is_forbidden, kube_is_not_found, KubyError, Result};
use crate::k8s::discovery::DiscoveredResource;
use crate::k8s::namespaces::{self, NamespaceScope};
use crate::k8s::printer_columns::{self, PrinterColumn, ResourceTable};
use crate::k8s::watch;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceListResult {
    /// Namespaces that are not Terminating. Sidebar and bulk reads use this set.
    pub namespaces: Vec<String>,
    /// Namespaces with phase Terminating or a deletion timestamp. Not queried in bulk.
    pub terminating: Vec<String>,
    /// True when cluster-wide Namespace LIST is forbidden; names are a fallback seed.
    pub restricted: bool,
    pub default_namespace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIdentifier {
    pub context: String,
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[tauri::command]
pub async fn list_api_resources(
    state: State<'_, AppState>,
    context: String,
    refresh: Option<bool>,
) -> Result<Vec<DiscoveredResource>> {
    let cache = if refresh.unwrap_or(false) {
        state.manager.refresh_discovery(&context).await?
    } else {
        let c = state.manager.discovery(&context).await?;
        if c.resources().is_empty() {
            state.manager.refresh_discovery(&context).await?
        } else {
            c
        }
    };
    Ok(cache.resources().to_vec())
}

#[tauri::command]
pub async fn list_namespaces(
    state: State<'_, AppState>,
    context: String,
) -> Result<NamespaceListResult> {
    // Typed core API — do not depend on discovery cache (which broke the sidebar list).
    let default_namespace = state.manager.default_namespace(&context);
    let client = state.manager.client(&context)?;
    let api: Api<Namespace> = Api::all(client);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let index = namespaces::index_from_items(list.items);
            let terminating = index.terminating_list();
            let active = index.active.clone();
            state.manager.set_namespace_index(&context, index);
            Ok(NamespaceListResult {
                namespaces: active,
                terminating,
                restricted: false,
                default_namespace,
            })
        }
        Err(err) if kube_is_forbidden(&err) => Ok(NamespaceListResult {
            namespaces: vec![default_namespace.clone()],
            terminating: Vec::new(),
            restricted: true,
            default_namespace,
        }),
        Err(err) => Err(err.into()),
    }
}

fn is_valid_namespace_name(name: &str) -> bool {
    let len = name.len();
    (1..=63).contains(&len)
        && name.bytes().enumerate().all(|(i, b)| match b {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'-' => i > 0 && i + 1 < len,
            _ => false,
        })
}

#[tauri::command]
pub async fn create_namespace(
    state: State<'_, AppState>,
    context: String,
    name: String,
) -> Result<String> {
    let name = name.trim();
    if !is_valid_namespace_name(name) {
        return Err(KubyError::Message(if name.is_empty() {
            "Enter a namespace name.".into()
        } else {
            format!("Invalid namespace \"{name}\". Use a DNS label (lowercase, digits, hyphens).")
        }));
    }

    let client = state.manager.client(&context)?;
    let api: Api<Namespace> = Api::all(client);
    let ns = Namespace {
        metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
            name: Some(name.to_string()),
            ..Default::default()
        },
        ..Default::default()
    };
    let created = api.create(&PostParams::default(), &ns).await?;
    Ok(created.name_any())
}

#[tauri::command]
pub async fn get_resource(
    state: State<'_, AppState>,
    ident: ResourceIdentifier,
) -> Result<serde_json::Value> {
    let (api, _) = state
        .manager
        .resolve_api(
            &ident.context,
            &ident.api_version,
            &ident.kind,
            ident.namespace.as_deref(),
        )
        .await?;
    let obj = api.get(&ident.name).await?;
    let obj = crate::k8s::ClusterManager::strip_managed_fields(obj);
    Ok(serde_json::to_value(obj)?)
}

#[tauri::command]
pub async fn get_resource_yaml(
    state: State<'_, AppState>,
    ident: ResourceIdentifier,
) -> Result<String> {
    let value = get_resource(state, ident).await?;
    Ok(serde_yaml::to_string(&value)?)
}

async fn apply_yaml_inner(
    state: &AppState,
    context: &str,
    yaml: &str,
    dry_run: bool,
) -> Result<DynamicObject> {
    let obj = crate::k8s::ClusterManager::dynamic_from_yaml(yaml)?;
    let types = obj
        .types
        .clone()
        .ok_or_else(|| KubyError::from("missing types"))?;
    let ns = obj.namespace();
    let name = obj.name_any();
    let (api, _) = state
        .manager
        .resolve_api(context, &types.api_version, &types.kind, ns.as_deref())
        .await?;

    let mut patch_params = PatchParams::apply("kuby").force();
    let mut post_params = PostParams::default();
    if dry_run {
        patch_params = patch_params.dry_run();
        post_params.dry_run = true;
    }

    // Server-side apply with create fallback when the object does not exist yet.
    match api.patch(&name, &patch_params, &Patch::Apply(&obj)).await {
        Ok(obj) => Ok(obj),
        Err(err) if kube_is_not_found(&err) => Ok(api.create(&post_params, &obj).await?),
        Err(err) => Err(err.into()),
    }
}

#[tauri::command]
pub async fn apply_yaml(
    state: State<'_, AppState>,
    context: String,
    yaml: String,
) -> Result<serde_json::Value> {
    let patched = apply_yaml_inner(&state, &context, &yaml, false).await?;
    Ok(serde_json::to_value(patched)?)
}

#[tauri::command]
pub async fn validate_yaml(
    state: State<'_, AppState>,
    context: String,
    yaml: String,
) -> Result<serde_json::Value> {
    let patched = apply_yaml_inner(&state, &context, &yaml, true).await?;
    Ok(json!({ "ok": true, "name": patched.name_any() }))
}

/// Replace the `data` map on a ConfigMap or Secret via JSON Patch.
/// `data` values must already be in API form (plain for ConfigMap, base64 for Secret).
#[tauri::command]
pub async fn patch_resource_data(
    state: State<'_, AppState>,
    ident: ResourceIdentifier,
    data: std::collections::HashMap<String, String>,
) -> Result<serde_json::Value> {
    let (api, _) = state
        .manager
        .resolve_api(
            &ident.context,
            &ident.api_version,
            &ident.kind,
            ident.namespace.as_deref(),
        )
        .await?;

    let data_value = serde_json::to_value(&data)?;
    // `add` replaces an existing `/data` value (RFC 6902), so deleted keys are gone.
    let patch_value = json!([{ "op": "add", "path": "/data", "value": data_value }]);
    let patch: json_patch::Patch = serde_json::from_value(patch_value)?;
    let patched = api
        .patch(
            &ident.name,
            &PatchParams::default(),
            &Patch::Json::<()>(patch),
        )
        .await?;
    let patched = crate::k8s::ClusterManager::strip_managed_fields(patched);
    Ok(serde_json::to_value(patched)?)
}

#[tauri::command]
pub async fn delete_resource(state: State<'_, AppState>, ident: ResourceIdentifier) -> Result<()> {
    // Cluster-scoped core types: avoid discovery/namespaced mistakes.
    if ident.kind == "Namespace" && (ident.api_version == "v1" || ident.api_version.is_empty()) {
        let client = state.manager.client(&ident.context)?;
        let api: Api<Namespace> = Api::all(client);
        api.delete(&ident.name, &DeleteParams::default()).await?;
        return Ok(());
    }

    let (api, _) = state
        .manager
        .resolve_api(
            &ident.context,
            &ident.api_version,
            &ident.kind,
            ident.namespace.as_deref(),
        )
        .await?;
    api.delete(&ident.name, &DeleteParams::default()).await?;
    Ok(())
}

#[tauri::command]
pub async fn start_resource_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    kind: String,
    namespace: Option<String>,
) -> Result<String> {
    watch::start_watch(
        app,
        state.manager.clone(),
        context,
        api_version,
        kind,
        namespace,
    )
    .await
}

#[tauri::command]
pub async fn stop_resource_watch(
    state: State<'_, AppState>,
    context: String,
    key: String,
) -> Result<()> {
    watch::stop_watch(&state.manager, &context, &key)
}

#[tauri::command]
pub async fn list_resources_once(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    kind: String,
    namespace: Option<String>,
) -> Result<Vec<serde_json::Value>> {
    if resource_is_namespaced(&state, &context, &api_version, &kind).await? {
        if let Some(scope) = bulk_scope(&state, &context, namespace.as_deref()) {
            return list_namespaced_values(&state, &context, &api_version, &kind, scope).await;
        }
    }
    list_one(&state, &context, &api_version, &kind, namespace.as_deref()).await
}

fn bulk_scope(state: &AppState, context: &str, namespace: Option<&str>) -> Option<NamespaceScope> {
    let index = state.manager.namespace_index(context)?;
    let scope = namespaces::resolve_scope(&index, &namespaces::requested_names(namespace));
    // No terminating namespaces: keep the single cluster-wide call.
    if !index.has_terminating() {
        return None;
    }
    Some(scope)
}

/// Namespace to sample for a limit=1 table read. None keeps the cluster-wide call.
fn sample_namespace(state: &AppState, context: &str) -> Option<String> {
    let index = state.manager.namespace_index(context)?;
    if !index.has_terminating() {
        return None;
    }
    index.active.first().cloned()
}

async fn resource_is_namespaced(
    state: &AppState,
    context: &str,
    api_version: &str,
    kind: &str,
) -> Result<bool> {
    let cache = state.manager.discovery(context).await?;
    Ok(cache
        .resolve(api_version, kind)?
        .map(|(_, namespaced)| namespaced)
        .unwrap_or(true))
}

async fn list_namespaced_values(
    state: &AppState,
    context: &str,
    api_version: &str,
    kind: &str,
    scope: NamespaceScope,
) -> Result<Vec<serde_json::Value>> {
    let NamespaceScope::Only(names) = scope else {
        return list_one(state, context, api_version, kind, None).await;
    };
    let mut out = Vec::new();
    for chunk in names.chunks(namespaces::BULK_CONCURRENCY) {
        let parts = futures::future::join_all(chunk.iter().cloned().map(|ns| async move {
            list_one(state, context, api_version, kind, Some(ns.as_str())).await
        }))
        .await;
        for part in parts {
            out.extend(part?);
        }
    }
    Ok(out)
}

async fn list_one(
    state: &AppState,
    context: &str,
    api_version: &str,
    kind: &str,
    namespace: Option<&str>,
) -> Result<Vec<serde_json::Value>> {
    let (api, _) = state
        .manager
        .resolve_api(context, api_version, kind, namespace)
        .await?;
    let list = api.list(&ListParams::default()).await?;
    Ok(list
        .items
        .into_iter()
        .map(|o| serde_json::to_value(o).unwrap_or(json!({})))
        .collect())
}

#[tauri::command]
pub async fn get_list_columns(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    kind: String,
) -> Result<Vec<PrinterColumn>> {
    let client = state.manager.client(&context)?;
    let cache = state.manager.discovery(&context).await?;
    if let Some(index) = state.manager.namespace_index(&context) {
        if index.has_terminating() && index.active.is_empty() {
            return Ok(Vec::new());
        }
    }
    // Sample one active namespace so column discovery does not scan Terminating ones.
    let sample = sample_namespace(&state, &context);
    printer_columns::get_list_columns(client, &cache, &api_version, &kind, sample.as_deref()).await
}

#[tauri::command]
pub async fn list_resource_table(
    state: State<'_, AppState>,
    context: String,
    api_version: String,
    kind: String,
    namespace: Option<String>,
) -> Result<ResourceTable> {
    let client = state.manager.client(&context)?;
    let cache = state.manager.discovery(&context).await?;
    if let Some(NamespaceScope::Only(names)) = bulk_scope(&state, &context, namespace.as_deref())
        .filter(|_| {
            cache
                .resolve(&api_version, &kind)
                .ok()
                .flatten()
                .map(|(_, namespaced)| namespaced)
                .unwrap_or(true)
        })
    {
        return list_table_in_namespaces(client, &cache, &api_version, &kind, &names).await;
    }
    printer_columns::list_resource_table(client, &cache, &api_version, &kind, namespace.as_deref())
        .await
}

async fn list_table_in_namespaces(
    client: kube::Client,
    cache: &crate::k8s::discovery::DiscoveryCache,
    api_version: &str,
    kind: &str,
    names: &[String],
) -> Result<ResourceTable> {
    if names.is_empty() {
        return Ok(ResourceTable {
            columns: Vec::new(),
            rows: Vec::new(),
        });
    }
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    for chunk in names.chunks(namespaces::BULK_CONCURRENCY) {
        let parts = futures::future::join_all(chunk.iter().map(|ns| {
            let client = client.clone();
            let ns = ns.clone();
            async move {
                printer_columns::list_resource_table(
                    client,
                    cache,
                    api_version,
                    kind,
                    Some(ns.as_str()),
                )
                .await
            }
        }))
        .await;
        for part in parts {
            let table = part?;
            if columns.is_empty() {
                columns = table.columns;
            }
            rows.extend(table.rows);
        }
    }
    Ok(ResourceTable { columns, rows })
}
