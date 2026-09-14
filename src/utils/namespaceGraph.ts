import { objectKey, objectName, objectNamespace } from "../constants/resources";
import type { K8sObject } from "../types";

export type GraphStatusColor = "green" | "red" | "grey" | "";

export type GraphNode = {
  id: string;
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string;
  label: string;
  status: GraphStatusColor;
  obj: K8sObject;
  /** Collapsed group of isolated resources of the same kind. */
  cluster?: boolean;
  /** Member count when `cluster` is true. */
  memberCount?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type NamespaceGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type BuildGraphOptions = {
  /** Kind names that should appear as nodes (Endpoints stay link-only). */
  visibleKinds: Set<string>;
  hideEmptyReplicaSets?: boolean;
  search?: string;
  /**
   * Kind names whose isolated (no-edge) members stay expanded as individual nodes.
   * Other isolated kinds collapse into one cluster node each.
   */
  expandedIsolatedKinds?: Set<string>;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function ownerRefs(obj: K8sObject): { uid?: string; kind: string; name: string }[] {
  const meta = asRecord(obj.metadata);
  const refs = meta?.ownerReferences;
  if (!Array.isArray(refs)) return [];
  return refs
    .map((r) => asRecord(r))
    .filter(Boolean)
    .map((r) => ({
      uid: typeof r!.uid === "string" ? r!.uid : undefined,
      kind: String(r!.kind || ""),
      name: String(r!.name || ""),
    }))
    .filter((r) => r.kind && r.name);
}

function replicaCount(obj: K8sObject): number {
  const status = asRecord(obj.status);
  const spec = asRecord(obj.spec);
  const n = status?.replicas ?? spec?.replicas ?? 0;
  return typeof n === "number" ? n : Number(n) || 0;
}

/** Status colour matching KubeView semantics. */
export function statusColour(obj: K8sObject, kind: string): GraphStatusColor {
  try {
    const status = asRecord(obj.status) || {};
    const spec = asRecord(obj.spec) || {};
    const meta = asRecord(obj.metadata) || {};

    if (kind === "Deployment") {
      const conditions = Array.isArray(status.conditions) ? status.conditions : [];
      const avail = conditions.map((c) => asRecord(c)).find((c) => c?.type === "Available");
      if (!conditions.length) return "grey";
      if (avail && avail.status === "True") return "green";
      return "red";
    }

    if (kind === "ReplicaSet" || kind === "StatefulSet") {
      const replicas = Number(status.replicas ?? 0);
      const ready = Number(status.readyReplicas ?? 0);
      if (replicas === 0) return "grey";
      if (replicas === ready) return "green";
      return "red";
    }

    if (kind === "DaemonSet") {
      const ready = Number(status.numberReady ?? 0);
      const desired = Number(status.desiredNumberScheduled ?? 0);
      if (desired === 0) return "grey";
      if (ready === desired) return "green";
      return "red";
    }

    if (kind === "Pod") {
      if (meta.deletionTimestamp) return "red";
      const conditions = Array.isArray(status.conditions) ? status.conditions : [];
      const ready = conditions.map((c) => asRecord(c)).find((c) => c?.type === "Ready");
      if (ready && ready.status === "True") return "green";
      if (status.phase === "Failed") return "red";
      if (status.phase === "Succeeded") return "green";
      if (status.phase === "Pending") return "grey";
      return "grey";
    }

    if (kind === "PersistentVolumeClaim") {
      if (status.phase === "Bound") return "green";
      if (status.phase === "Pending") return "grey";
      return "red";
    }

    if (kind === "Job") {
      const backoffLimit = Number(spec.backoffLimit ?? 6);
      const succeeded = Number(status.succeeded ?? 0);
      const completions = Number(spec.completions ?? 1);
      const failed = Number(status.failed ?? 0);
      if (succeeded >= completions) return "green";
      if (failed >= backoffLimit) return "red";
      return "grey";
    }
  } catch {
    return "";
  }
  return "";
}

function shortenLabel(name: string, obj: K8sObject): string {
  const labels = obj.metadata?.labels || {};
  const hash = labels["pod-template-hash"];
  if (hash && name.includes(`-${hash}`)) {
    return name.split(`-${hash}`)[0] || name;
  }
  return name;
}

function shouldHideEmptyReplicaSet(obj: K8sObject, kind: string, hideEmpty: boolean): boolean {
  if (!hideEmpty || kind !== "ReplicaSet") return false;
  return replicaCount(obj) === 0;
}

/**
 * Build a KubeView-style relationship graph for one namespace's resources.
 * Endpoints / EndpointSlice are used only to derive Service→Pod edges.
 * Isolated nodes (no edges) of the same kind collapse into one cluster node
 * unless that kind is listed in `expandedIsolatedKinds`.
 */
export function buildNamespaceGraph(
  objects: K8sObject[],
  options: BuildGraphOptions,
): NamespaceGraph {
  const { visibleKinds, hideEmptyReplicaSets = true, search = "", expandedIsolatedKinds } = options;
  const q = search.trim().toLowerCase();
  const expanded = expandedIsolatedKinds || new Set<string>();

  const byUid = new Map<string, K8sObject>();
  const byKindName = new Map<string, K8sObject>();

  for (const obj of objects) {
    const uid = objectKey(obj);
    const kind = String(obj.kind || "");
    const name = objectName(obj);
    if (!uid || !kind) continue;
    byUid.set(uid, obj);
    byKindName.set(`${kind}/${name}`, obj);
  }

  const findByName = (kind: string, name: string): K8sObject | undefined =>
    byKindName.get(`${kind}/${name}`);

  const findPodsByIp = (ip: string): K8sObject[] => {
    const out: K8sObject[] = [];
    for (const obj of byUid.values()) {
      if (String(obj.kind) !== "Pod") continue;
      const status = asRecord(obj.status);
      if (status?.podIP === ip) out.push(obj);
    }
    return out;
  };

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();

  for (const obj of byUid.values()) {
    const kind = String(obj.kind || "");
    if (!visibleKinds.has(kind)) continue;
    if (kind === "Endpoints" || kind === "EndpointSlice") continue;
    if (shouldHideEmptyReplicaSet(obj, kind, hideEmptyReplicaSets)) continue;

    const name = objectName(obj);
    if (q && !name.toLowerCase().includes(q) && !kind.toLowerCase().includes(q)) {
      continue;
    }

    const id = objectKey(obj);
    nodeIds.add(id);
    nodes.push({
      id,
      kind,
      apiVersion: String(obj.apiVersion || ""),
      name,
      namespace: objectNamespace(obj),
      label: shortenLabel(name, obj),
      status: statusColour(obj, kind),
      obj,
    });
  }

  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  const addEdge = (sourceId: string | undefined, targetId: string | undefined) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) return;
    const id = `${sourceId}.${targetId}`;
    if (edgeSet.has(id)) return;
    edgeSet.add(id);
    edges.push({ id, source: sourceId, target: targetId });
  };

  for (const obj of byUid.values()) {
    const kind = String(obj.kind || "");
    const uid = objectKey(obj);
    const spec = asRecord(obj.spec);
    const meta = asRecord(obj.metadata);

    for (const ref of ownerRefs(obj)) {
      if (ref.uid) addEdge(ref.uid, uid);
      else {
        const owner = findByName(ref.kind, ref.name);
        if (owner) addEdge(objectKey(owner), uid);
      }
    }

    if (kind === "Ingress" && spec) {
      const rules = Array.isArray(spec.rules) ? spec.rules : [];
      for (const rule of rules) {
        const r = asRecord(rule);
        const http = asRecord(r?.http);
        const paths = Array.isArray(http?.paths) ? http!.paths : [];
        for (const p of paths) {
          const path = asRecord(p);
          const backend = asRecord(path?.backend);
          const svc = asRecord(backend?.service);
          if (typeof svc?.name === "string") {
            const service = findByName("Service", svc.name);
            if (service) addEdge(uid, objectKey(service));
          }
        }
      }
      const defaultBackend = asRecord(spec.defaultBackend);
      const dbs = asRecord(defaultBackend?.service);
      if (typeof dbs?.name === "string") {
        const service = findByName("Service", dbs.name);
        if (service) addEdge(uid, objectKey(service));
      }
    }

    if (kind === "Endpoints") {
      const service = findByName("Service", objectName(obj));
      if (service) {
        const subsets = Array.isArray(obj.subsets) ? obj.subsets : [];
        for (const sub of subsets) {
          const s = asRecord(sub);
          const addrs = Array.isArray(s?.addresses) ? s!.addresses : [];
          for (const a of addrs) {
            const addr = asRecord(a);
            if (typeof addr?.ip === "string") {
              for (const pod of findPodsByIp(addr.ip)) {
                addEdge(objectKey(service), objectKey(pod));
              }
            }
            const target = asRecord(addr?.targetRef);
            if (target?.kind === "Pod" && typeof target.name === "string") {
              const pod = findByName("Pod", target.name);
              if (pod) addEdge(objectKey(service), objectKey(pod));
            }
          }
        }
      }
    }

    if (kind === "EndpointSlice") {
      const labels = (meta?.labels || {}) as Record<string, string>;
      const serviceName = labels["kubernetes.io/service-name"];
      const service = serviceName ? findByName("Service", serviceName) : undefined;
      if (service) {
        const endpoints = Array.isArray(obj.endpoints) ? obj.endpoints : [];
        for (const ep of endpoints) {
          const e = asRecord(ep);
          const addrs = Array.isArray(e?.addresses) ? e!.addresses : [];
          for (const addr of addrs) {
            if (typeof addr === "string") {
              for (const pod of findPodsByIp(addr)) {
                addEdge(objectKey(service), objectKey(pod));
              }
            }
          }
          const target = asRecord(e?.targetRef);
          if (target?.kind === "Pod" && typeof target.name === "string") {
            const pod = findByName("Pod", target.name);
            if (pod) addEdge(objectKey(service), objectKey(pod));
          }
        }
      }
    }

    if (kind === "Pod" && spec) {
      const volumes = Array.isArray(spec.volumes) ? spec.volumes : [];
      for (const vol of volumes) {
        const v = asRecord(vol);
        const pvc = asRecord(v?.persistentVolumeClaim);
        if (typeof pvc?.claimName === "string") {
          const claim = findByName("PersistentVolumeClaim", pvc.claimName);
          if (claim) addEdge(uid, objectKey(claim));
        }
        const cm = asRecord(v?.configMap);
        if (typeof cm?.name === "string") {
          const configMap = findByName("ConfigMap", cm.name);
          if (configMap) addEdge(uid, objectKey(configMap));
        }
        const secret = asRecord(v?.secret);
        if (typeof secret?.secretName === "string") {
          const sec = findByName("Secret", secret.secretName);
          if (sec) addEdge(uid, objectKey(sec));
        }
      }

      const containers = Array.isArray(spec.containers) ? spec.containers : [];
      for (const container of containers) {
        const c = asRecord(container);
        const env = Array.isArray(c?.env) ? c!.env : [];
        for (const e of env) {
          const envVar = asRecord(e);
          const from = asRecord(envVar?.valueFrom);
          const secretRef = asRecord(from?.secretKeyRef);
          if (typeof secretRef?.name === "string") {
            const sec = findByName("Secret", secretRef.name);
            if (sec) addEdge(uid, objectKey(sec));
          }
          const cmRef = asRecord(from?.configMapKeyRef);
          if (typeof cmRef?.name === "string") {
            const configMap = findByName("ConfigMap", cmRef.name);
            if (configMap) addEdge(uid, objectKey(configMap));
          }
        }
      }
    }

    if (kind === "HorizontalPodAutoscaler" && spec) {
      const scale = asRecord(spec.scaleTargetRef);
      if (scale && typeof scale.kind === "string" && typeof scale.name === "string") {
        const target = findByName(scale.kind, scale.name);
        if (target) addEdge(uid, objectKey(target));
      }
    }
  }

  // When searching, keep neighbours of matching nodes so edges remain meaningful
  let resultNodes = nodes;
  let resultEdges = edges;
  if (q && nodes.length) {
    const keep = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      if (keep.has(e.source) || keep.has(e.target)) {
        keep.add(e.source);
        keep.add(e.target);
      }
    }
    const filteredNodes = nodes.filter((n) => keep.has(n.id));
    // Also re-add neighbour nodes that were filtered out by search but needed for edges
    for (const id of keep) {
      if (filteredNodes.some((n) => n.id === id)) continue;
      const obj = byUid.get(id);
      if (!obj) continue;
      const kind = String(obj.kind || "");
      if (!visibleKinds.has(kind) || kind === "Endpoints" || kind === "EndpointSlice") {
        continue;
      }
      filteredNodes.push({
        id,
        kind,
        apiVersion: String(obj.apiVersion || ""),
        name: objectName(obj),
        namespace: objectNamespace(obj),
        label: shortenLabel(objectName(obj), obj),
        status: statusColour(obj, kind),
        obj,
      });
    }
    const nodeIdSet = new Set(filteredNodes.map((n) => n.id));
    resultNodes = filteredNodes;
    resultEdges = edges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
  }

  return collapseIsolatedKinds(resultNodes, resultEdges, expanded);
}

/** Synthetic stub object for collapsed cluster nodes (inspector / open disabled). */
function clusterStub(kind: string, count: number): K8sObject {
  return {
    apiVersion: "",
    kind,
    metadata: {
      name: `${kind} (${count})`,
      uid: `cluster:${kind}`,
      labels: {},
    },
  };
}

/**
 * Collapse degree-0 nodes of the same kind into one cluster node,
 * unless that kind is in `expandedIsolatedKinds`.
 */
function collapseIsolatedKinds(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expandedIsolatedKinds: Set<string>,
): NamespaceGraph {
  const degree = new Set<string>();
  for (const e of edges) {
    degree.add(e.source);
    degree.add(e.target);
  }

  const isolatedByKind = new Map<string, GraphNode[]>();
  const kept: GraphNode[] = [];

  for (const n of nodes) {
    if (degree.has(n.id)) {
      kept.push(n);
      continue;
    }
    // Searching already narrowed the set — still collapse large isolates unless expanded.
    if (expandedIsolatedKinds.has(n.kind)) {
      kept.push(n);
      continue;
    }
    const list = isolatedByKind.get(n.kind) || [];
    list.push(n);
    isolatedByKind.set(n.kind, list);
  }

  for (const [kind, members] of isolatedByKind) {
    // Single isolated node: keep as-is (no benefit collapsing).
    if (members.length <= 1) {
      kept.push(...members);
      continue;
    }
    const count = members.length;
    kept.push({
      id: `cluster:${kind}`,
      kind,
      apiVersion: members[0]?.apiVersion || "",
      name: `${kind} (${count})`,
      namespace: members[0]?.namespace || "",
      label: `${kind} (${count})`,
      status: "",
      obj: clusterStub(kind, count),
      cluster: true,
      memberCount: count,
    });
  }

  const keepIds = new Set(kept.map((n) => n.id));
  return {
    nodes: kept,
    edges: edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)),
  };
}
