export const CURATED_NAV = [
  { kind: "Overview", apiVersion: "kuby.io/overview", group: "Workloads" },
  { kind: "Pod", apiVersion: "v1", group: "Workloads" },
  { kind: "Deployment", apiVersion: "apps/v1", group: "Workloads" },
  { kind: "StatefulSet", apiVersion: "apps/v1", group: "Workloads" },
  { kind: "DaemonSet", apiVersion: "apps/v1", group: "Workloads" },
  { kind: "ReplicaSet", apiVersion: "apps/v1", group: "Workloads" },
  { kind: "Job", apiVersion: "batch/v1", group: "Workloads" },
  { kind: "CronJob", apiVersion: "batch/v1", group: "Workloads" },
  { kind: "Service", apiVersion: "v1", group: "Network" },
  { kind: "Ingress", apiVersion: "networking.k8s.io/v1", group: "Network" },
  {
    kind: "NetworkPolicy",
    apiVersion: "networking.k8s.io/v1",
    group: "Network",
  },
  { kind: "Endpoints", apiVersion: "v1", group: "Network" },
  { kind: "ConfigMap", apiVersion: "v1", group: "Config" },
  { kind: "Secret", apiVersion: "v1", group: "Config" },
  { kind: "PersistentVolumeClaim", apiVersion: "v1", group: "Storage" },
  { kind: "PersistentVolume", apiVersion: "v1", group: "Storage" },
  { kind: "StorageClass", apiVersion: "storage.k8s.io/v1", group: "Storage" },
  { kind: "ServiceAccount", apiVersion: "v1", group: "Access" },
  { kind: "Role", apiVersion: "rbac.authorization.k8s.io/v1", group: "Access" },
  {
    kind: "RoleBinding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    group: "Access",
  },
  {
    kind: "ClusterRole",
    apiVersion: "rbac.authorization.k8s.io/v1",
    group: "Access",
  },
  {
    kind: "ClusterRoleBinding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    group: "Access",
  },
  { kind: "Node", apiVersion: "v1", group: "Cluster" },
  { kind: "Namespace", apiVersion: "v1", group: "Cluster" },
  { kind: "Event", apiVersion: "v1", group: "Cluster" },
  {
    kind: "HorizontalPodAutoscaler",
    apiVersion: "autoscaling/v2",
    group: "Cluster",
  },
  { kind: "PodDisruptionBudget", apiVersion: "policy/v1", group: "Cluster" },
  { kind: "LimitRange", apiVersion: "v1", group: "Cluster" },
  { kind: "ResourceQuota", apiVersion: "v1", group: "Cluster" },
] as const;

/** Kinds watched for the namespace relationship graph (KubeView parity). */
export const GRAPH_KINDS = [
  { kind: "Pod", apiVersion: "v1", visible: true },
  { kind: "Deployment", apiVersion: "apps/v1", visible: true },
  { kind: "ReplicaSet", apiVersion: "apps/v1", visible: true },
  { kind: "StatefulSet", apiVersion: "apps/v1", visible: true },
  { kind: "DaemonSet", apiVersion: "apps/v1", visible: true },
  { kind: "Job", apiVersion: "batch/v1", visible: true },
  { kind: "CronJob", apiVersion: "batch/v1", visible: true },
  { kind: "Service", apiVersion: "v1", visible: true },
  { kind: "Ingress", apiVersion: "networking.k8s.io/v1", visible: true },
  { kind: "Endpoints", apiVersion: "v1", visible: false },
  { kind: "EndpointSlice", apiVersion: "discovery.k8s.io/v1", visible: false },
  { kind: "ConfigMap", apiVersion: "v1", visible: true },
  { kind: "Secret", apiVersion: "v1", visible: true },
  { kind: "PersistentVolumeClaim", apiVersion: "v1", visible: true },
  {
    kind: "HorizontalPodAutoscaler",
    apiVersion: "autoscaling/v2",
    visible: true,
  },
] as const;

export type GraphKindSpec = (typeof GRAPH_KINDS)[number];

/** Second wave: bulky / link-only kinds loaded after first paint. */
const GRAPH_WAVE2_KINDS = new Set(["ConfigMap", "Secret", "Endpoints", "EndpointSlice"]);

/** Workload + networking kinds for progressive first paint. */
export const GRAPH_KINDS_WAVE1 = GRAPH_KINDS.filter((k) => !GRAPH_WAVE2_KINDS.has(k.kind));

/** ConfigMaps, Secrets, Endpoints — deferred until the map is visible. */
export const GRAPH_KINDS_WAVE2 = GRAPH_KINDS.filter((k) => GRAPH_WAVE2_KINDS.has(k.kind));

export const GRAPH_VISIBLE_KINDS = GRAPH_KINDS.filter((k) => k.visible).map((k) => k.kind);

const CLUSTER_SCOPED_KINDS = new Set([
  "Node",
  "Namespace",
  "PersistentVolume",
  "StorageClass",
  "ClusterRole",
  "ClusterRoleBinding",
]);

/** Namespace column is empty for cluster-scoped types. */
export function kindHasNamespaceColumn(kind: string): boolean {
  return !CLUSTER_SCOPED_KINDS.has(kind);
}

/** CPU/Mem is only populated for pods and nodes. */
export function kindHasMetricsColumn(kind: string): boolean {
  return kind === "Pod" || kind === "Node";
}

/** Running pods vs allocatable pod limit is only shown on nodes. */
export function kindHasPodsColumn(kind: string): boolean {
  return kind === "Node";
}

/** False for create-only APIs (TokenReview, SubjectAccessReview, …). */
export function resourceIsWatchable(r: { watchable?: boolean; verbs?: string[] }): boolean {
  if (typeof r.watchable === "boolean") return r.watchable;
  if (!r.verbs?.length) return true;
  return r.verbs.includes("list") || r.verbs.includes("watch");
}

export function objectKey(obj: {
  metadata?: { uid?: string; namespace?: string; name?: string };
  uid?: string;
  namespace?: string;
  name?: string;
}): string {
  return (
    obj.metadata?.uid ||
    obj.uid ||
    `${obj.metadata?.namespace || obj.namespace || ""}/${obj.metadata?.name || obj.name || ""}`
  );
}

export function objectName(obj: { metadata?: { name?: string }; name?: string }): string {
  return obj.metadata?.name || obj.name || "";
}

export function objectNamespace(obj: {
  metadata?: { namespace?: string };
  namespace?: string;
}): string {
  return obj.metadata?.namespace || obj.namespace || "";
}

export function ageFromTimestamp(ts?: string): string {
  if (!ts) return "-";
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "-";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
