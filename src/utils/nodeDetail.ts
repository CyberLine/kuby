import type { StatusLabel } from "./nodeStatus";

export type NodeAddress = {
  type: string;
  address: string;
};

export type NodeTaint = {
  key: string;
  value: string;
  effect: string;
};

export type NodeCondition = {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransitionTime: string;
};

export type NodeSystemInfo = {
  kubeletVersion: string;
  osImage: string;
  operatingSystem: string;
  architecture: string;
  containerRuntimeVersion: string;
  kernelVersion: string;
};

export type ResourceQuantityMap = Record<string, string>;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function statusOf(obj: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(obj.status);
}

function specOf(obj: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(obj.spec);
}

export function nodeAddresses(obj: Record<string, unknown>): NodeAddress[] {
  const status = statusOf(obj);
  const addrs = status?.addresses;
  if (!Array.isArray(addrs)) return [];
  const out: NodeAddress[] = [];
  for (const a of addrs) {
    const r = asRecord(a);
    if (!r) continue;
    const type = typeof r.type === "string" ? r.type : "";
    const address = typeof r.address === "string" ? r.address : "";
    if (type && address) out.push({ type, address });
  }
  return out;
}

export function nodeAddressByType(obj: Record<string, unknown>, type: string): string | null {
  return nodeAddresses(obj).find((a) => a.type === type)?.address ?? null;
}

export function nodeTaints(obj: Record<string, unknown>): NodeTaint[] {
  const spec = specOf(obj);
  const taints = spec?.taints;
  if (!Array.isArray(taints)) return [];
  const out: NodeTaint[] = [];
  for (const t of taints) {
    const r = asRecord(t);
    if (!r) continue;
    const key = typeof r.key === "string" ? r.key : "";
    if (!key) continue;
    out.push({
      key,
      value: typeof r.value === "string" ? r.value : "",
      effect: typeof r.effect === "string" ? r.effect : "",
    });
  }
  return out;
}

export function nodeConditions(obj: Record<string, unknown>): NodeCondition[] {
  const status = statusOf(obj);
  const conditions = status?.conditions;
  if (!Array.isArray(conditions)) return [];
  const out: NodeCondition[] = [];
  for (const c of conditions) {
    const r = asRecord(c);
    if (!r) continue;
    const type = typeof r.type === "string" ? r.type : "";
    if (!type) continue;
    out.push({
      type,
      status: typeof r.status === "string" ? r.status : "",
      reason: typeof r.reason === "string" ? r.reason : "",
      message: typeof r.message === "string" ? r.message : "",
      lastTransitionTime: typeof r.lastTransitionTime === "string" ? r.lastTransitionTime : "",
    });
  }
  return out;
}

export function conditionTone(c: NodeCondition): StatusLabel["tone"] {
  const pressure =
    c.type === "MemoryPressure" ||
    c.type === "DiskPressure" ||
    c.type === "PIDPressure" ||
    c.type === "NetworkUnavailable";
  if (c.type === "Ready") {
    if (c.status === "True") return "ok";
    if (c.status === "False") return "err";
    return "warn";
  }
  if (pressure) {
    return c.status === "True" ? "warn" : "ok";
  }
  return c.status === "True" ? "ok" : "muted";
}

export function nodeSystemInfo(obj: Record<string, unknown>): NodeSystemInfo {
  const status = statusOf(obj);
  const info = asRecord(status?.nodeInfo);
  return {
    kubeletVersion: typeof info?.kubeletVersion === "string" ? info.kubeletVersion : "",
    osImage: typeof info?.osImage === "string" ? info.osImage : "",
    operatingSystem: typeof info?.operatingSystem === "string" ? info.operatingSystem : "",
    architecture: typeof info?.architecture === "string" ? info.architecture : "",
    containerRuntimeVersion:
      typeof info?.containerRuntimeVersion === "string" ? info.containerRuntimeVersion : "",
    kernelVersion: typeof info?.kernelVersion === "string" ? info.kernelVersion : "",
  };
}

function quantityMap(v: unknown): ResourceQuantityMap {
  const r = asRecord(v);
  if (!r) return {};
  const out: ResourceQuantityMap = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = String(val);
  }
  return out;
}

export function nodeCapacity(obj: Record<string, unknown>): ResourceQuantityMap {
  return quantityMap(statusOf(obj)?.capacity);
}

export function nodeAllocatable(obj: Record<string, unknown>): ResourceQuantityMap {
  return quantityMap(statusOf(obj)?.allocatable);
}

/** Prefer allocatable, fall back to capacity. */
export function nodeResourceLimit(obj: Record<string, unknown>, key: string): string | null {
  const alloc = nodeAllocatable(obj)[key];
  if (alloc) return alloc;
  const cap = nodeCapacity(obj)[key];
  return cap || null;
}

export function nodeLabels(obj: Record<string, unknown>): [string, string][] {
  const meta = asRecord(obj.metadata);
  const labels = asRecord(meta?.labels);
  if (!labels) return [];
  return Object.entries(labels)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

export function podRestartCount(obj: Record<string, unknown>): number {
  const status = asRecord(obj.status);
  const containers = status?.containerStatuses;
  if (!Array.isArray(containers)) return 0;
  let total = 0;
  for (const c of containers) {
    const r = asRecord(c);
    if (!r) continue;
    const n = typeof r.restartCount === "number" ? r.restartCount : Number(r.restartCount);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

export function podPhaseLabel(obj: Record<string, unknown>): StatusLabel {
  const meta = asRecord(obj.metadata);
  if (meta?.deletionTimestamp) return { text: "Terminating", tone: "warn" };
  const status = asRecord(obj.status);
  const phase = typeof status?.phase === "string" ? status.phase : "Unknown";
  const containerStatuses = Array.isArray(status?.containerStatuses)
    ? (status.containerStatuses as Record<string, unknown>[])
    : [];
  let waiting: string | undefined;
  for (const cs of containerStatuses) {
    const st = asRecord(cs.state);
    if (!st) continue;
    const w = asRecord(st.waiting);
    const t = asRecord(st.terminated);
    if (typeof w?.reason === "string") {
      waiting = w.reason;
      break;
    }
    if (typeof t?.reason === "string") {
      waiting = t.reason;
      break;
    }
  }
  let text = phase;
  if (waiting === "ImagePullBackOff" || waiting === "ErrImagePull") text = "ImagePullBackOff";
  else if (waiting === "CrashLoopBackOff") text = "CrashLoopBackOff";
  else if (waiting === "CreateContainerConfigError") text = "ConfigError";
  else if (waiting === "Error") text = "Error";
  else if (phase === "Succeeded") text = "Completed";

  const lower = text.toLowerCase();
  let tone: StatusLabel["tone"] = "muted";
  if (lower === "running" || lower === "completed" || lower === "succeeded") tone = "ok";
  else if (lower === "pending" || lower === "unknown" || lower.includes("backoff")) tone = "warn";
  else if (
    lower === "failed" ||
    lower === "error" ||
    lower === "crashloopbackoff" ||
    lower === "imagepullbackoff"
  )
    tone = "err";
  return { text, tone };
}
