import { objectName, objectNamespace } from "../constants/resources";
import type { K8sObject } from "../types";

export type RelationLink = {
  id: string;
  /** Short group label in the UI */
  group: string;
  /** Button / link text */
  title: string;
  apiVersion: string;
  kind: string;
  namespace?: string | null;
  /** Jump to a concrete resource name (also used as search fallback) */
  name?: string;
  /** Filter list by label selector */
  labelSelector?: Record<string, string>;
  /** Filter list by ownerReference */
  owner?: { kind: string; name: string; uid?: string };
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringRecord(v: unknown): Record<string, string> | null {
  const r = asRecord(v);
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

function ownerRefs(obj: K8sObject): {
  apiVersion?: string;
  kind: string;
  name: string;
  uid?: string;
  controller?: boolean;
}[] {
  const meta = asRecord(obj.metadata);
  const refs = meta?.ownerReferences;
  if (!Array.isArray(refs)) return [];
  return refs
    .map((r) => asRecord(r))
    .filter(Boolean)
    .map((r) => ({
      apiVersion: typeof r!.apiVersion === "string" ? r!.apiVersion : undefined,
      kind: String(r!.kind || ""),
      name: String(r!.name || ""),
      uid: typeof r!.uid === "string" ? r!.uid : undefined,
      controller: Boolean(r!.controller),
    }))
    .filter((r) => r.kind && r.name);
}

function gvkForKind(
  kind: string,
  apiVersion?: string,
): {
  apiVersion: string;
  kind: string;
} {
  if (apiVersion) return { apiVersion, kind };
  const map: Record<string, string> = {
    Pod: "v1",
    Service: "v1",
    ConfigMap: "v1",
    Secret: "v1",
    Namespace: "v1",
    Node: "v1",
    PersistentVolumeClaim: "v1",
    PersistentVolume: "v1",
    Endpoints: "v1",
    ServiceAccount: "v1",
    Event: "v1",
    LimitRange: "v1",
    ResourceQuota: "v1",
    ReplicationController: "v1",
    Deployment: "apps/v1",
    ReplicaSet: "apps/v1",
    StatefulSet: "apps/v1",
    DaemonSet: "apps/v1",
    Job: "batch/v1",
    CronJob: "batch/v1",
    Ingress: "networking.k8s.io/v1",
    NetworkPolicy: "networking.k8s.io/v1",
    HorizontalPodAutoscaler: "autoscaling/v2",
    PodDisruptionBudget: "policy/v1",
    Role: "rbac.authorization.k8s.io/v1",
    RoleBinding: "rbac.authorization.k8s.io/v1",
    ClusterRole: "rbac.authorization.k8s.io/v1",
    ClusterRoleBinding: "rbac.authorization.k8s.io/v1",
    StorageClass: "storage.k8s.io/v1",
  };
  return { apiVersion: map[kind] || "v1", kind };
}

function matchLabelsOf(obj: K8sObject): Record<string, string> | null {
  const spec = asRecord(obj.spec);
  const selector = asRecord(spec?.selector);
  // Service: spec.selector is flat map
  if (selector && !selector.matchLabels && !selector.matchExpressions) {
    return asStringRecord(selector);
  }
  return asStringRecord(selector?.matchLabels);
}

/** Extract navigable relations for the detail pane. */
export function extractRelations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const name = objectName(obj);
  const ns = objectNamespace(obj) || null;
  const uid =
    (typeof obj.metadata?.uid === "string" && obj.metadata.uid) ||
    (typeof obj.uid === "string" ? obj.uid : undefined);
  const spec = asRecord(obj.spec);

  // Controllers / owners (up)
  for (const ref of ownerRefs(obj)) {
    const gvk = gvkForKind(ref.kind, ref.apiVersion);
    links.push({
      id: `owner-${ref.kind}-${ref.name}`,
      group: "Controlled by",
      title: `${ref.kind}/${ref.name}`,
      ...gvk,
      namespace: ns,
      name: ref.name,
    });
  }

  // Workload → Pods (and intermediate kinds)
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind)) {
    const labels = matchLabelsOf(obj);
    if (labels) {
      links.push({
        id: `pods-selector-${name}`,
        group: "Workloads",
        title: "Pods (selector)",
        apiVersion: "v1",
        kind: "Pod",
        namespace: ns,
        labelSelector: labels,
      });
    }
    links.push({
      id: `pods-owner-${name}`,
      group: "Workloads",
      title: "Pods (owned)",
      apiVersion: "v1",
      kind: "Pod",
      namespace: ns,
      owner: { kind, name, uid },
    });
  }

  if (kind === "Deployment") {
    links.push({
      id: `rs-owner-${name}`,
      group: "Workloads",
      title: "ReplicaSets",
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      namespace: ns,
      owner: { kind: "Deployment", name, uid },
    });
  }

  if (kind === "CronJob") {
    links.push({
      id: `jobs-owner-${name}`,
      group: "Workloads",
      title: "Jobs",
      apiVersion: "batch/v1",
      kind: "Job",
      namespace: ns,
      owner: { kind: "CronJob", name, uid },
    });
    // Jobs from this CronJob carry label often; pods via job-name is harder — Jobs link is enough
  }

  if (kind === "Job") {
    const jobLabels = { "job-name": name };
    links.push({
      id: `pods-job-label-${name}`,
      group: "Workloads",
      title: "Pods (job-name)",
      apiVersion: "v1",
      kind: "Pod",
      namespace: ns,
      labelSelector: jobLabels,
    });
  }

  if (kind === "Service") {
    const selector = asStringRecord(spec?.selector);
    if (selector) {
      links.push({
        id: `svc-pods-${name}`,
        group: "Network",
        title: "Pods",
        apiVersion: "v1",
        kind: "Pod",
        namespace: ns,
        labelSelector: selector,
      });
    }
    links.push({
      id: `svc-endpoints-${name}`,
      group: "Network",
      title: `Endpoints/${name}`,
      apiVersion: "v1",
      kind: "Endpoints",
      namespace: ns,
      name,
    });
  }

  if (kind === "Ingress") {
    const rules = Array.isArray(spec?.rules) ? spec!.rules : [];
    const seen = new Set<string>();
    const addService = (svcName: string) => {
      if (seen.has(svcName)) return;
      seen.add(svcName);
      links.push({
        id: `ing-svc-${svcName}`,
        group: "Backends",
        title: `Service/${svcName}`,
        apiVersion: "v1",
        kind: "Service",
        namespace: ns,
        name: svcName,
      });
    };
    for (const rule of rules) {
      const r = asRecord(rule);
      const http = asRecord(r?.http);
      const paths = Array.isArray(http?.paths) ? http!.paths : [];
      for (const p of paths) {
        const path = asRecord(p);
        const backend = asRecord(path?.backend);
        const svc = asRecord(backend?.service);
        if (typeof svc?.name === "string") addService(svc.name);
      }
    }
    const db = asRecord(spec?.defaultBackend);
    const dbs = asRecord(db?.service);
    if (typeof dbs?.name === "string") addService(dbs.name);
  }

  if (kind === "NetworkPolicy") {
    const podSelector = asRecord(spec?.podSelector);
    const labels = asStringRecord(podSelector?.matchLabels) || {};
    links.push({
      id: `np-pods-${name}`,
      group: "Network",
      title: Object.keys(labels).length ? "Selected Pods" : "All Pods in namespace",
      apiVersion: "v1",
      kind: "Pod",
      namespace: ns,
      labelSelector: labels,
    });
  }

  if (kind === "HorizontalPodAutoscaler") {
    const scale = asRecord(spec?.scaleTargetRef);
    if (scale && typeof scale.kind === "string" && typeof scale.name === "string") {
      const gvk = gvkForKind(
        scale.kind,
        typeof scale.apiVersion === "string" ? scale.apiVersion : undefined,
      );
      links.push({
        id: `hpa-target-${scale.name}`,
        group: "Scales",
        title: `${scale.kind}/${scale.name}`,
        ...gvk,
        namespace: ns,
        name: scale.name,
      });
    }
  }

  if (kind === "PersistentVolumeClaim") {
    const volumeName = typeof spec?.volumeName === "string" ? spec.volumeName : null;
    if (volumeName) {
      links.push({
        id: `pvc-pv-${volumeName}`,
        group: "Storage",
        title: `PersistentVolume/${volumeName}`,
        apiVersion: "v1",
        kind: "PersistentVolume",
        namespace: null,
        name: volumeName,
      });
    }
  }

  if (kind === "PersistentVolume") {
    const claim = asRecord(spec?.claimRef);
    if (claim && typeof claim.name === "string") {
      links.push({
        id: `pv-pvc-${claim.name}`,
        group: "Storage",
        title: `PersistentVolumeClaim/${claim.name}`,
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        namespace: typeof claim.namespace === "string" ? claim.namespace : ns,
        name: claim.name,
      });
    }
  }

  if (kind === "Endpoints") {
    const subsets = Array.isArray(obj.subsets) ? obj.subsets : [];
    const seen = new Set<string>();
    for (const sub of subsets) {
      const s = asRecord(sub);
      const addrs = [
        ...(Array.isArray(s?.addresses) ? s!.addresses : []),
        ...(Array.isArray(s?.notReadyAddresses) ? s!.notReadyAddresses : []),
      ];
      for (const a of addrs) {
        const addr = asRecord(a);
        const target = asRecord(addr?.targetRef);
        if (
          target &&
          target.kind === "Pod" &&
          typeof target.name === "string" &&
          !seen.has(target.name)
        ) {
          seen.add(target.name);
          links.push({
            id: `ep-pod-${target.name}`,
            group: "Targets",
            title: `Pod/${target.name}`,
            apiVersion: "v1",
            kind: "Pod",
            namespace: typeof target.namespace === "string" ? target.namespace : ns,
            name: target.name,
          });
        }
      }
    }
  }

  // Pod → node, volumes, service account
  if (kind === "Pod") {
    const nodeName = typeof spec?.nodeName === "string" ? spec.nodeName : null;
    if (nodeName) {
      links.push({
        id: `pod-node-${nodeName}`,
        group: "Cluster",
        title: `Node/${nodeName}`,
        apiVersion: "v1",
        kind: "Node",
        namespace: null,
        name: nodeName,
      });
    }
    const volumes = Array.isArray(spec?.volumes) ? spec!.volumes : [];
    for (const vol of volumes) {
      const v = asRecord(vol);
      const pvc = asRecord(v?.persistentVolumeClaim);
      if (pvc && typeof pvc.claimName === "string") {
        links.push({
          id: `pod-pvc-${pvc.claimName}`,
          group: "Storage",
          title: `PersistentVolumeClaim/${pvc.claimName}`,
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          namespace: ns,
          name: pvc.claimName,
        });
      }
    }
    const sa =
      typeof spec?.serviceAccountName === "string"
        ? spec.serviceAccountName
        : typeof spec?.serviceAccount === "string"
          ? spec.serviceAccount
          : null;
    if (sa) {
      links.push({
        id: `pod-sa-${sa}`,
        group: "Access",
        title: `ServiceAccount/${sa}`,
        apiVersion: "v1",
        kind: "ServiceAccount",
        namespace: ns,
        name: sa,
      });
    }
  }

  return links;
}

export function matchesLabelSelector(obj: K8sObject, selector: Record<string, string>): boolean {
  // Empty selector means "everything" (NetworkPolicy edge case)
  const entries = Object.entries(selector);
  if (!entries.length) return true;
  const labels = obj.metadata?.labels || {};
  return entries.every(([k, v]) => labels[k] === v);
}

export function matchesOwnerFilter(
  obj: K8sObject,
  owner: { kind: string; name: string; uid?: string },
): boolean {
  return ownerRefs(obj).some((r) => {
    if (r.kind !== owner.kind) return false;
    if (owner.uid && r.uid) return r.uid === owner.uid;
    return r.name === owner.name;
  });
}

/** Group links for display */
export function groupRelations(links: RelationLink[]): { group: string; links: RelationLink[] }[] {
  const order: string[] = [];
  const map = new Map<string, RelationLink[]>();
  for (const link of links) {
    if (!map.has(link.group)) {
      map.set(link.group, []);
      order.push(link.group);
    }
    map.get(link.group)!.push(link);
  }
  return order.map((group) => ({ group, links: map.get(group)! }));
}
