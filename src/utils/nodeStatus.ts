export type StatusTone = "ok" | "warn" | "err" | "muted";

export type StatusLabel = {
  text: string;
  tone: StatusTone;
};

function conditionsOf(obj: Record<string, unknown>) {
  const status = obj.status as Record<string, unknown> | undefined;
  const conditions = status?.conditions;
  return Array.isArray(conditions) ? (conditions as Record<string, unknown>[]) : [];
}

export function isNodeUnschedulable(obj: Record<string, unknown>): boolean {
  const spec = obj.spec as Record<string, unknown> | undefined;
  return Boolean(spec?.unschedulable);
}

/** Node roles from labels like node-role.kubernetes.io/control-plane. */
export function nodeRoles(obj: Record<string, unknown>): string[] {
  const labels = (obj.metadata as { labels?: Record<string, string> } | undefined)?.labels || {};
  const roles: string[] = [];
  for (const key of Object.keys(labels)) {
    if (key.startsWith("node-role.kubernetes.io/")) {
      const role = key.slice("node-role.kubernetes.io/".length);
      if (role) roles.push(role);
    }
  }
  roles.sort();
  return roles;
}

/**
 * Derive display labels for a Node: Ready/NotReady, pressure conditions,
 * SchedulingDisabled when cordoned/draining, plus roles as muted chips.
 */
export function nodeStatusLabels(obj: Record<string, unknown>): StatusLabel[] {
  const labels: StatusLabel[] = [];
  const conditions = conditionsOf(obj);

  const ready = conditions.find((c) => c.type === "Ready");
  if (ready?.status === "True") {
    labels.push({ text: "Ready", tone: "ok" });
  } else if (ready?.status === "False") {
    labels.push({ text: "NotReady", tone: "err" });
  } else if (ready?.status === "Unknown") {
    labels.push({ text: "Unknown", tone: "warn" });
  } else {
    labels.push({ text: "Unknown", tone: "muted" });
  }

  for (const c of conditions) {
    const type = typeof c.type === "string" ? c.type : "";
    if (
      (type === "MemoryPressure" ||
        type === "DiskPressure" ||
        type === "PIDPressure" ||
        type === "NetworkUnavailable") &&
      c.status === "True"
    ) {
      labels.push({ text: type, tone: "warn" });
    }
  }

  if (isNodeUnschedulable(obj)) {
    labels.push({ text: "SchedulingDisabled", tone: "warn" });
  }

  for (const role of nodeRoles(obj)) {
    labels.push({ text: role, tone: "muted" });
  }

  return labels;
}

/** Flat string used for sorting / filtering. */
export function nodeStatusText(obj: Record<string, unknown>): string {
  return nodeStatusLabels(obj)
    .map((l) => l.text)
    .join(" ");
}

export function nodeKubeletVersion(obj: Record<string, unknown>): string {
  const status = obj.status as { nodeInfo?: { kubeletVersion?: string } } | undefined;
  const version = status?.nodeInfo?.kubeletVersion;
  return typeof version === "string" ? version : "";
}

function resourceQuantity(list: unknown, key: string): number | null {
  if (!list || typeof list !== "object") return null;
  const raw = (list as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Scheduler limit: allocatable.pods, then capacity.pods. */
export function nodePodLimit(obj: Record<string, unknown>): number | null {
  const status = obj.status as Record<string, unknown> | undefined;
  return (
    resourceQuantity(status?.allocatable, "pods") ?? resourceQuantity(status?.capacity, "pods")
  );
}

/**
 * Node a non-terminated pod is bound to. Succeeded/Failed pods are omitted
 * so the count matches kubectl describe / kube-scheduler occupancy.
 */
export function countedPodNodeName(obj: Record<string, unknown>): string {
  const spec = obj.spec as Record<string, unknown> | undefined;
  const nodeName = spec?.nodeName;
  if (typeof nodeName !== "string" || !nodeName) return "";
  const status = obj.status as Record<string, unknown> | undefined;
  const phase = typeof status?.phase === "string" ? status.phase : "";
  if (phase === "Succeeded" || phase === "Failed") return "";
  return nodeName;
}

export function formatNodePodUsage(used: number | null, limit: number | null): string {
  const left = used == null ? "—" : String(used);
  const right = limit == null ? "—" : String(limit);
  return `${left} / ${right}`;
}
