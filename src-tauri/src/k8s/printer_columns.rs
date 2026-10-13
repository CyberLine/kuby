//! Server-side list columns: CRD `additionalPrinterColumns` and meta.k8s.io Table.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ApiResource, DynamicObject};
use kube::client::Client;
use kube::Resource;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

use crate::error::Result;
use crate::k8s::discovery::DiscoveryCache;

const TABLE_ACCEPT: &str =
    "application/json;as=Table;g=meta.k8s.io;v=v1,application/json;as=Table;g=meta.k8s.io;v=v1beta1,application/json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Present for CRD columns; absent for built-in Table columnDefinitions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_path: Option<String>,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTableRow {
    pub cells: Vec<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTable {
    pub columns: Vec<PrinterColumn>,
    pub rows: Vec<ResourceTableRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTable {
    #[serde(default)]
    column_definitions: Vec<RawColumnDefinition>,
    #[serde(default)]
    rows: Vec<RawTableRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawColumnDefinition {
    name: String,
    #[serde(rename = "type", default)]
    type_: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    priority: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTableRow {
    #[serde(default)]
    cells: Vec<Value>,
    #[serde(default)]
    object: Option<Value>,
}

impl From<&RawColumnDefinition> for PrinterColumn {
    fn from(c: &RawColumnDefinition) -> Self {
        Self {
            name: c.name.clone(),
            type_: if c.type_.is_empty() {
                "string".into()
            } else {
                c.type_.clone()
            },
            format: c.format.clone(),
            description: c.description.clone(),
            json_path: None,
            priority: c.priority,
        }
    }
}

fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn row_from_raw(row: &RawTableRow) -> ResourceTableRow {
    let cells = row.cells.iter().map(cell_to_string).collect();
    let meta = row
        .object
        .as_ref()
        .and_then(|o| o.get("metadata"))
        .cloned()
        .unwrap_or(Value::Null);
    let name = meta
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let namespace = meta
        .get("namespace")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let uid = meta
        .get("uid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    ResourceTableRow {
        cells,
        name,
        namespace,
        uid,
    }
}

fn table_list_path(ar: &ApiResource, namespace: Option<&str>, limit: Option<u32>) -> String {
    let base = DynamicObject::url_path(ar, namespace);
    match limit {
        Some(n) => format!("{base}?limit={n}"),
        None => base,
    }
}

async fn fetch_table(
    client: Client,
    ar: &ApiResource,
    namespace: Option<&str>,
    limit: Option<u32>,
) -> Result<RawTable> {
    let path = table_list_path(ar, namespace, limit);
    let req = http::Request::builder()
        .method(http::Method::GET)
        .uri(&path)
        .header(http::header::ACCEPT, TABLE_ACCEPT)
        .body(Vec::new())
        .map_err(|e| anyhow::anyhow!("table request build failed: {e}"))?;

    let value: Value = client.request(req).await?;
    // Fallback: server ignored Table Accept and returned a normal list.
    if value.get("kind").and_then(|k| k.as_str()) != Some("Table") {
        debug!(
            path,
            kind = ?value.get("kind"),
            "list response was not a Table; no printer columns"
        );
        return Ok(RawTable {
            column_definitions: Vec::new(),
            rows: Vec::new(),
        });
    }
    Ok(serde_json::from_value(value)?)
}

fn columns_from_crd(crd: &CustomResourceDefinition, version: &str) -> Vec<PrinterColumn> {
    let ver = crd
        .spec
        .versions
        .iter()
        .find(|v| v.name == version)
        .or_else(|| crd.spec.versions.iter().find(|v| v.storage));
    let Some(ver) = ver else {
        return Vec::new();
    };
    let Some(cols) = ver.additional_printer_columns.as_ref() else {
        return Vec::new();
    };
    cols.iter()
        .map(|c| PrinterColumn {
            name: c.name.clone(),
            type_: c.type_.clone(),
            format: c.format.clone(),
            description: c.description.clone(),
            json_path: Some(c.json_path.clone()),
            priority: c.priority.unwrap_or(0),
        })
        .collect()
}

async fn columns_from_crd_lookup(
    client: Client,
    group: &str,
    version: &str,
    plural: &str,
) -> Result<Option<Vec<PrinterColumn>>> {
    if group.is_empty() {
        return Ok(None);
    }
    let name = format!("{plural}.{group}");
    let api: Api<CustomResourceDefinition> = Api::all(client);
    match api.get(&name).await {
        Ok(crd) => Ok(Some(columns_from_crd(&crd, version))),
        Err(err) => {
            // Not a CRD (or no permission) — fall through to Table.
            debug!(crd = %name, error = %err, "CRD lookup for printer columns failed");
            Ok(None)
        }
    }
}

fn list_namespace(namespaced: bool, namespace: Option<&str>) -> Option<&str> {
    if !namespaced {
        return None;
    }
    match namespace {
        Some("") | None | Some("*") => None,
        Some(ns) => Some(ns),
    }
}

/// Column metadata for a GVK: prefer CRD additionalPrinterColumns, else Table definitions.
pub async fn get_list_columns(
    client: Client,
    cache: &DiscoveryCache,
    api_version: &str,
    kind: &str,
) -> Result<Vec<PrinterColumn>> {
    let (ar, namespaced) = cache.resolve_or_err(api_version, kind)?;
    if let Some(cols) =
        columns_from_crd_lookup(client.clone(), &ar.group, &ar.version, &ar.plural).await?
    {
        if !cols.is_empty() {
            return Ok(cols);
        }
        // CRD exists but has no additionalPrinterColumns — try Table defaults.
    }

    let ns = list_namespace(namespaced, None);
    match fetch_table(client, &ar, ns, Some(1)).await {
        Ok(table) => Ok(table
            .column_definitions
            .iter()
            .map(PrinterColumn::from)
            .collect()),
        Err(err) => {
            debug!(
                api_version,
                kind,
                error = %err,
                "Table columnDefinitions fetch failed"
            );
            Ok(Vec::new())
        }
    }
}

/// Full Table list (columns + cells) for kinds without jsonPath.
pub async fn list_resource_table(
    client: Client,
    cache: &DiscoveryCache,
    api_version: &str,
    kind: &str,
    namespace: Option<&str>,
) -> Result<ResourceTable> {
    let (ar, namespaced) = cache.resolve_or_err(api_version, kind)?;
    let ns = list_namespace(namespaced, namespace);
    let table = fetch_table(client, &ar, ns, None).await?;
    Ok(ResourceTable {
        columns: table
            .column_definitions
            .iter()
            .map(PrinterColumn::from)
            .collect(),
        rows: table.rows.iter().map(row_from_raw).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cell_formats() {
        assert_eq!(cell_to_string(&json!(null)), "");
        assert_eq!(cell_to_string(&json!("Ready")), "Ready");
        assert_eq!(cell_to_string(&json!(3)), "3");
        assert_eq!(cell_to_string(&json!(true)), "true");
    }

    #[test]
    fn row_extracts_meta() {
        let raw = RawTableRow {
            cells: vec![json!("foo"), json!("1h")],
            object: Some(json!({
                "kind": "PartialObjectMetadata",
                "apiVersion": "meta.k8s.io/v1",
                "metadata": {
                    "name": "foo",
                    "namespace": "default",
                    "uid": "abc-123"
                }
            })),
        };
        let row = row_from_raw(&raw);
        assert_eq!(row.name, "foo");
        assert_eq!(row.namespace.as_deref(), Some("default"));
        assert_eq!(row.uid.as_deref(), Some("abc-123"));
        assert_eq!(row.cells, vec!["foo", "1h"]);
    }
}
