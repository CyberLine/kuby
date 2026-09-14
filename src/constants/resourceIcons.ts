/** Map Kubernetes kinds → community icon basenames (unlabeled SVGs). */
const KIND_ICON: Record<string, string> = {
  Pod: "pod",
  Deployment: "deploy",
  StatefulSet: "sts",
  DaemonSet: "ds",
  ReplicaSet: "rs",
  Job: "job",
  CronJob: "cronjob",
  Service: "svc",
  Ingress: "ing",
  NetworkPolicy: "netpol",
  Endpoints: "ep",
  EndpointSlice: "ep",
  ConfigMap: "cm",
  Secret: "secret",
  PersistentVolumeClaim: "pvc",
  PersistentVolume: "pv",
  StorageClass: "sc",
  Volume: "vol",
  ServiceAccount: "sa",
  Role: "role",
  RoleBinding: "rb",
  ClusterRole: "c-role",
  ClusterRoleBinding: "crb",
  Namespace: "ns",
  HorizontalPodAutoscaler: "hpa",
  LimitRange: "limits",
  ResourceQuota: "quota",
  PodSecurityPolicy: "psp",
  CustomResourceDefinition: "crd",
  User: "user",
  Group: "group",
};

const iconUrls = import.meta.glob("../assets/k8s-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function urlForBasename(basename: string): string | null {
  const key = Object.keys(iconUrls).find((k) => k.endsWith(`/${basename}.svg`));
  return key ? iconUrls[key] : null;
}

const crdUrl = urlForBasename("crd");

/** Resolve icon URL for a resource kind (falls back to generic CRD icon). */
export function resourceIconUrl(kind: string): string | null {
  if (kind === "Overview" || kind === "Longhorn") return null;
  const basename = KIND_ICON[kind] || "crd";
  return urlForBasename(basename) || crdUrl;
}

export function resourceIconTitle(kind: string): string {
  if (KIND_ICON[kind]) return kind;
  return "Custom resource";
}
