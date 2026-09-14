use std::collections::HashMap;

use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, DynamicObject, ListParams};
use serde::{Deserialize, Serialize};

use crate::error::{kube_is_forbidden, kube_is_not_found, Result};
use crate::k8s::ClusterManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSegment {
    pub label: String,
    pub count: u32,
    /// ok | warn | err | idle
    pub tone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCard {
    pub kind: String,
    pub total: u32,
    pub segments: Vec<OverviewSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LonghornEvent {
    pub reason: String,
    pub count: u32,
    pub last_seen: String,
    pub age: String,
    pub message: String,
    pub involved: String,
    pub involved_kind: String,
    pub involved_name: String,
    pub involved_namespace: Option<String>,
    pub involved_api_version: Option<String>,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LonghornStorage {
    pub maximum: i64,
    pub available: i64,
    pub reserved: i64,
    pub scheduled: i64,
    pub disabled: i64,
    pub volume_size: i64,
    pub actual_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LonghornOverview {
    pub volume_api_version: Option<String>,
    pub node_api_version: Option<String>,
    pub volume: OverviewCard,
    pub node: OverviewCard,
    pub storage: LonghornStorage,
    pub events: Vec<LonghornEvent>,
}

fn empty_overview() -> LonghornOverview {
    LonghornOverview {
        volume_api_version: None,
        node_api_version: None,
        volume: OverviewCard {
            kind: "Volume".into(),
            total: 0,
            segments: Vec::new(),
        },
        node: OverviewCard {
            kind: "Node".into(),
            total: 0,
            segments: Vec::new(),
        },
        storage: LonghornStorage {
            maximum: 0,
            available: 0,
            reserved: 0,
            scheduled: 0,
            disabled: 0,
            volume_size: 0,
            actual_size: 0,
        },
        events: Vec::new(),
    }
}

/// Aggregate Longhorn dashboard data (volumes, nodes, storage, events).
///
/// Missing CRDs (404) or missing RBAC (403) yield an empty overview so the UI
/// stays usable when Longhorn is not installed.
pub async fn get_overview(manager: &ClusterManager, context: &str) -> Result<LonghornOverview> {
    let cache = manager.discovery(context).await?;
    let volume_av = prefer_api_version(cache.resources(), "Volume");
    let node_av = prefer_api_version(cache.resources(), "Node");

    if volume_av.is_none() && node_av.is_none() {
        return Ok(empty_overview());
    }

    let volumes = if let Some(ref av) = volume_av {
        list_dynamic(manager, context, av, "Volume").await
    } else {
        Vec::new()
    };
    let nodes = if let Some(ref av) = node_av {
        list_dynamic(manager, context, av, "Node").await
    } else {
        Vec::new()
    };

    let client = manager.client(context)?;
    let events = list_events(client).await;

    let mut overview = empty_overview();
    overview.volume_api_version = volume_av;
    overview.node_api_version = node_av;
    overview.volume = volume_card(&volumes);
    overview.node = node_card(&nodes);
    overview.storage = storage_stats(&volumes, &nodes);
    overview.events = aggregate_events(context, &events);
    Ok(overview)
}

fn prefer_api_version(
    resources: &[crate::k8s::discovery::DiscoveredResource],
    kind: &str,
) -> Option<String> {
    let matches: Vec<_> = resources
        .iter()
        .filter(|r| r.group == "longhorn.io" && r.kind == kind)
        .collect();
    if matches.is_empty() {
        return None;
    }
    if let Some(r) = matches.iter().find(|r| r.version == "v1beta2") {
        return Some(r.api_version.clone());
    }
    if let Some(r) = matches.iter().find(|r| r.version == "v1beta1") {
        return Some(r.api_version.clone());
    }
    Some(matches[0].api_version.clone())
}

async fn list_dynamic(
    manager: &ClusterManager,
    context: &str,
    api_version: &str,
    kind: &str,
) -> Vec<DynamicObject> {
    let (api, _) = match manager
        .resolve_api(context, api_version, kind, Some("*"))
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, api_version, kind, "longhorn resolve failed");
            return Vec::new();
        }
    };
    match api.list(&ListParams::default()).await {
        Ok(list) => list.items,
        Err(e) if kube_is_not_found(&e) || kube_is_forbidden(&e) => {
            tracing::debug!(error = %e, api_version, kind, "longhorn list unavailable");
            Vec::new()
        }
        Err(e) => {
            tracing::warn!(error = %e, api_version, kind, "longhorn list failed");
            Vec::new()
        }
    }
}

async fn list_events(client: kube::Client) -> Vec<Event> {
    let api: Api<Event> = Api::all(client);
    match api.list(&ListParams::default()).await {
        Ok(list) => list.items,
        Err(e) => {
            tracing::warn!(error = %e, "longhorn event list failed");
            Vec::new()
        }
    }
}

fn bump(map: &mut HashMap<String, (u32, String)>, label: &str, tone: &str) {
    let entry = map
        .entry(label.to_string())
        .or_insert((0, tone.to_string()));
    entry.0 += 1;
}

fn segments_from(map: HashMap<String, (u32, String)>) -> Vec<OverviewSegment> {
    let order = [
        "Healthy",
        "Degraded",
        "In Progress",
        "Fault",
        "Detached",
        "Unknown",
        "Schedulable",
        "Unschedulable",
        "Disabled",
        "Down",
    ];
    let mut segs: Vec<_> = map
        .into_iter()
        .map(|(label, (count, tone))| OverviewSegment { label, count, tone })
        .collect();
    segs.sort_by(|a, b| {
        let ai = order
            .iter()
            .position(|l| *l == a.label)
            .unwrap_or(order.len());
        let bi = order
            .iter()
            .position(|l| *l == b.label)
            .unwrap_or(order.len());
        ai.cmp(&bi).then(b.count.cmp(&a.count))
    });
    segs
}

fn str_field(obj: &DynamicObject, path: &str) -> String {
    obj.data
        .pointer(path)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn i64_field(obj: &DynamicObject, path: &str) -> i64 {
    let Some(v) = obj.data.pointer(path) else {
        return 0;
    };
    if let Some(n) = v.as_i64() {
        return n;
    }
    if let Some(n) = v.as_u64() {
        return n as i64;
    }
    if let Some(s) = v.as_str() {
        return parse_size(s);
    }
    0
}

fn bool_field(obj: &DynamicObject, path: &str) -> Option<bool> {
    obj.data.pointer(path).and_then(|v| v.as_bool())
}

/// Parse Longhorn size fields (bytes as number or string).
fn parse_size(s: &str) -> i64 {
    let raw = s.trim();
    if raw.is_empty() {
        return 0;
    }
    if let Ok(n) = raw.parse::<i64>() {
        return n;
    }
    // Fallback: treat as Kubernetes quantity-ish Gi/Mi
    let units: [(&str, i64); 5] = [
        ("Gi", 1024i64.pow(3)),
        ("Mi", 1024i64.pow(2)),
        ("Ki", 1024),
        ("G", 1000i64.pow(3)),
        ("M", 1000i64.pow(2)),
    ];
    for (suf, mul) in units {
        if let Some(n) = raw.strip_suffix(suf) {
            if let Ok(v) = n.trim().parse::<f64>() {
                return (v * mul as f64) as i64;
            }
        }
    }
    0
}

fn volume_label(obj: &DynamicObject) -> (&'static str, &'static str) {
    let state = str_field(obj, "/status/state").to_lowercase();
    let robustness = str_field(obj, "/status/robustness").to_lowercase();

    if robustness == "faulted" {
        return ("Fault", "err");
    }
    if state == "detached" {
        return ("Detached", "idle");
    }
    if matches!(
        state.as_str(),
        "creating" | "attaching" | "detaching" | "deleting"
    ) {
        return ("In Progress", "info");
    }
    if robustness == "degraded" {
        return ("Degraded", "warn");
    }
    if robustness == "healthy" && state == "attached" {
        return ("Healthy", "ok");
    }
    if state == "attached" && (robustness.is_empty() || robustness == "unknown") {
        return ("Healthy", "ok");
    }
    if !state.is_empty() || !robustness.is_empty() {
        return ("In Progress", "info");
    }
    ("Unknown", "idle")
}

fn volume_card(volumes: &[DynamicObject]) -> OverviewCard {
    let mut map = HashMap::new();
    for v in volumes {
        let (label, tone) = volume_label(v);
        bump(&mut map, label, tone);
    }
    OverviewCard {
        kind: "Volume".into(),
        total: volumes.len() as u32,
        segments: segments_from(map),
    }
}

fn condition_status(obj: &DynamicObject, cond_type: &str) -> Option<String> {
    let conditions = obj.data.pointer("/status/conditions")?.as_array()?;
    for c in conditions {
        let t = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t.eq_ignore_ascii_case(cond_type) {
            // Longhorn uses either status: "True"/"False" or condition: "True"
            if let Some(s) = c.get("status").and_then(|v| v.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = c.get("condition").and_then(|v| v.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn is_true(s: Option<String>) -> bool {
    s.as_deref()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn node_label(obj: &DynamicObject) -> (&'static str, &'static str) {
    let ready = is_true(condition_status(obj, "Ready"));
    if !ready {
        return ("Down", "err");
    }
    let allow = bool_field(obj, "/spec/allowScheduling").unwrap_or(true);
    if !allow {
        return ("Disabled", "idle");
    }
    let schedulable = condition_status(obj, "Schedulable")
        .map(|s| s.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    if !schedulable {
        return ("Unschedulable", "warn");
    }
    ("Schedulable", "ok")
}

fn node_card(nodes: &[DynamicObject]) -> OverviewCard {
    let mut map = HashMap::new();
    for n in nodes {
        let (label, tone) = node_label(n);
        bump(&mut map, label, tone);
    }
    OverviewCard {
        kind: "Node".into(),
        total: nodes.len() as u32,
        segments: segments_from(map),
    }
}

fn storage_stats(volumes: &[DynamicObject], nodes: &[DynamicObject]) -> LonghornStorage {
    let mut maximum = 0i64;
    let mut available = 0i64;
    let mut reserved = 0i64;
    let mut scheduled = 0i64;
    let mut disabled = 0i64;

    for node in nodes {
        let disks = node
            .data
            .pointer("/status/diskStatus")
            .and_then(|v| v.as_object());
        let spec_disks = node.data.pointer("/spec/disks").and_then(|v| v.as_object());

        if let Some(disks) = disks {
            for (name, disk) in disks {
                let allow = spec_disks
                    .and_then(|sd| sd.get(name))
                    .and_then(|d| d.get("allowScheduling"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let max = disk.get("storageMaximum").and_then(json_i64).unwrap_or(0);
                let avail = disk.get("storageAvailable").and_then(json_i64).unwrap_or(0);
                let sched = disk.get("storageScheduled").and_then(json_i64).unwrap_or(0);
                let res = spec_disks
                    .and_then(|sd| sd.get(name))
                    .and_then(|d| d.get("storageReserved"))
                    .and_then(json_i64)
                    .unwrap_or(0);

                if allow {
                    maximum += max;
                    available += avail;
                    reserved += res;
                    scheduled += sched;
                } else {
                    disabled += max;
                }
            }
        }
    }

    let mut volume_size = 0i64;
    let mut actual_size = 0i64;
    for v in volumes {
        volume_size += i64_field(v, "/spec/size");
        actual_size += i64_field(v, "/status/actualSize");
    }

    LonghornStorage {
        maximum,
        available,
        reserved,
        scheduled,
        disabled,
        volume_size,
        actual_size,
    }
}

fn json_i64(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_u64() {
        return Some(n as i64);
    }
    if let Some(s) = v.as_str() {
        return Some(parse_size(s));
    }
    None
}

fn is_longhorn_event(ev: &Event) -> bool {
    let api = ev.involved_object.api_version.as_deref().unwrap_or("");
    if api.contains("longhorn.io") {
        return true;
    }
    let reason = ev.reason.as_deref().unwrap_or("");
    if reason.to_lowercase().contains("longhorn") {
        return true;
    }
    let source = ev
        .source
        .as_ref()
        .and_then(|s| s.component.as_deref())
        .unwrap_or("");
    source.to_lowercase().contains("longhorn")
}

fn aggregate_events(context: &str, events: &[Event]) -> Vec<LonghornEvent> {
    let mut by_key: HashMap<String, LonghornEvent> = HashMap::new();
    for ev in events {
        if !is_longhorn_event(ev) {
            continue;
        }
        let typ = ev.type_.as_deref().unwrap_or("");
        // Surface warnings and errors; skip routine Normal noise unless nothing else.
        if !typ.eq_ignore_ascii_case("Warning") && !typ.eq_ignore_ascii_case("Error") {
            continue;
        }

        let reason = ev.reason.clone().unwrap_or_else(|| "Event".into());
        let last = ev
            .last_timestamp
            .as_ref()
            .map(|t| t.0)
            .or_else(|| ev.event_time.as_ref().map(|t| t.0))
            .or_else(|| ev.metadata.creation_timestamp.as_ref().map(|t| t.0));
        let last_str = last.map(|t| t.to_string()).unwrap_or_default();
        let count = ev.count.unwrap_or(1) as u32;
        let involved_kind = ev
            .involved_object
            .kind
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "?".into());
        let involved_name = ev
            .involved_object
            .name
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "?".into());
        let involved_namespace = ev
            .involved_object
            .namespace
            .clone()
            .filter(|s| !s.is_empty());
        let involved_api_version = ev
            .involved_object
            .api_version
            .clone()
            .filter(|s| !s.is_empty());
        let involved = format!("{involved_kind}/{involved_name}");
        let message = ev.message.clone().unwrap_or_default();
        let age = age_from(&last);
        let key = format!("{reason}|{involved}");

        by_key
            .entry(key)
            .and_modify(|w| {
                w.count += count;
                if last_str > w.last_seen {
                    w.last_seen = last_str.clone();
                    w.age = age.clone();
                    w.message = message.clone();
                    w.involved = involved.clone();
                    w.involved_kind = involved_kind.clone();
                    w.involved_name = involved_name.clone();
                    w.involved_namespace = involved_namespace.clone();
                    w.involved_api_version = involved_api_version.clone();
                }
            })
            .or_insert(LonghornEvent {
                reason,
                count,
                last_seen: last_str,
                age,
                message,
                involved,
                involved_kind,
                involved_name,
                involved_namespace,
                involved_api_version,
                context: context.to_string(),
            });
    }
    let mut out: Vec<_> = by_key.into_values().collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out.truncate(40);
    out
}

fn age_from(ts: &Option<k8s_openapi::jiff::Timestamp>) -> String {
    let Some(t) = ts.as_ref() else {
        return "-".into();
    };
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let sec = (now_secs - t.as_second()).max(0);
    if sec < 60 {
        format!("{sec}s ago")
    } else if sec < 3600 {
        format!("{}m ago", sec / 60)
    } else if sec < 86400 {
        format!("{}h ago", sec / 3600)
    } else {
        format!("{}d ago", sec / 86400)
    }
}
