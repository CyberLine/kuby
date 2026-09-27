import type { PodMetrics } from "../types";
import { nodeResourceLimit } from "./nodeDetail";
import { parseCpuMillis, parseMemoryBytes } from "./quantity";

/** One resource (CPU in millicores, or memory in bytes) against its budget. */
export type ResourceQuantity = {
  used: number | null;
  /** Set only when every counted container declares a request. */
  request: number | null;
  /** Set only when every counted container declares a limit. */
  limit: number | null;
  limitedCount: number;
  containerCount: number;
};

export type ResourceBudget = {
  cpu: ResourceQuantity;
  memory: ResourceQuantity;
};

type SideAcc = {
  used: number;
  usedSeen: boolean;
  request: number;
  requestCount: number;
  limit: number;
  limitCount: number;
  count: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function quantityMap(v: unknown): Record<string, string> {
  const r = asRecord(v);
  if (!r) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = String(val);
  }
  return out;
}

function containerList(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of v) {
    const r = asRecord(item);
    if (r) out.push(r);
  }
  return out;
}

function positive(n: number | null): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

function emptyAcc(): SideAcc {
  return {
    used: 0,
    usedSeen: false,
    request: 0,
    requestCount: 0,
    limit: 0,
    limitCount: 0,
    count: 0,
  };
}

function addSide(acc: SideAcc, used: number | null, request: number | null, limit: number | null) {
  acc.count += 1;
  if (used != null && Number.isFinite(used)) {
    acc.used += used;
    acc.usedSeen = true;
  }
  const req = positive(request);
  if (req != null) {
    acc.request += req;
    acc.requestCount += 1;
  }
  const lim = positive(limit);
  if (lim != null) {
    acc.limit += lim;
    acc.limitCount += 1;
  }
}

function finishSide(acc: SideAcc): ResourceQuantity {
  const complete = acc.count > 0;
  return {
    used: acc.usedSeen ? acc.used : null,
    request: complete && acc.requestCount === acc.count ? acc.request : null,
    limit: complete && acc.limitCount === acc.count ? acc.limit : null,
    limitedCount: acc.limitCount,
    containerCount: acc.count,
  };
}

function resourcesOf(spec: Record<string, unknown> | undefined): {
  requests: Record<string, string>;
  limits: Record<string, string>;
} {
  const resources = asRecord(spec?.resources);
  return {
    requests: quantityMap(resources?.requests),
    limits: quantityMap(resources?.limits),
  };
}

function blankSide(used: number | null): ResourceQuantity {
  return { used, request: null, limit: null, limitedCount: 0, containerCount: 0 };
}

/** Usage percent that may exceed 100. Null when either side is missing. */
export function uncappedUsagePercent(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit)) {
    return null;
  }
  if (limit <= 0) return null;
  return Math.max(0, (used / limit) * 100);
}

/** Single container: bar only when that container declares the limit. */
export function containerResourceBudget(
  spec: Record<string, unknown> | undefined,
  cpuUsed: string | null | undefined,
  memoryUsed: string | null | undefined,
): ResourceBudget {
  const { requests, limits } = resourcesOf(spec);
  const cpu = emptyAcc();
  const memory = emptyAcc();
  addSide(cpu, parseCpuMillis(cpuUsed), parseCpuMillis(requests.cpu), parseCpuMillis(limits.cpu));
  addSide(
    memory,
    parseMemoryBytes(memoryUsed),
    parseMemoryBytes(requests.memory),
    parseMemoryBytes(limits.memory),
  );
  return { cpu: finishSide(cpu), memory: finishSide(memory) };
}

/**
 * Pod row: sum app containers only. The limit (and the bar) is set only when
 * every app container declares that limit. Init containers are excluded.
 */
export function podResourceBudget(
  obj: Record<string, unknown>,
  metrics: PodMetrics | null | undefined,
): ResourceBudget {
  const spec = asRecord(obj.spec);
  const containers = containerList(spec?.containers);
  if (!containers.length) {
    return {
      cpu: blankSide(parseCpuMillis(metrics?.cpu)),
      memory: blankSide(parseMemoryBytes(metrics?.memory)),
    };
  }

  const byName = new Map<string, { cpu: string; memory: string }>();
  for (const c of metrics?.containers ?? []) {
    if (c.name) byName.set(c.name, c);
  }

  const cpu = emptyAcc();
  const memory = emptyAcc();
  for (const container of containers) {
    const name = typeof container.name === "string" ? container.name : "";
    const sample = name ? byName.get(name) : undefined;
    const { requests, limits } = resourcesOf(container);
    addSide(
      cpu,
      sample ? parseCpuMillis(sample.cpu) : null,
      parseCpuMillis(requests.cpu),
      parseCpuMillis(limits.cpu),
    );
    addSide(
      memory,
      sample ? parseMemoryBytes(sample.memory) : null,
      parseMemoryBytes(requests.memory),
      parseMemoryBytes(limits.memory),
    );
  }

  const cpuSide = finishSide(cpu);
  const memorySide = finishSide(memory);
  if (cpuSide.used == null && metrics?.cpu) {
    cpuSide.used = parseCpuMillis(metrics.cpu);
  }
  if (memorySide.used == null && metrics?.memory) {
    memorySide.used = parseMemoryBytes(metrics.memory);
  }
  return { cpu: cpuSide, memory: memorySide };
}

/** Node row: usage against allocatable (capacity as fallback). No requests. */
export function nodeResourceBudget(
  obj: Record<string, unknown>,
  metrics: { cpu: string; memory: string } | null | undefined,
): ResourceBudget {
  const cpuLimit = positive(parseCpuMillis(nodeResourceLimit(obj, "cpu")));
  const memoryLimit = positive(parseMemoryBytes(nodeResourceLimit(obj, "memory")));
  return {
    cpu: {
      used: parseCpuMillis(metrics?.cpu),
      request: null,
      limit: cpuLimit,
      limitedCount: cpuLimit != null ? 1 : 0,
      containerCount: 0,
    },
    memory: {
      used: parseMemoryBytes(metrics?.memory),
      request: null,
      limit: memoryLimit,
      limitedCount: memoryLimit != null ? 1 : 0,
      containerCount: 0,
    },
  };
}

export function resourceTooltip(
  heading: string,
  side: ResourceQuantity,
  format: (n: number) => string,
): string {
  const lines = [heading];
  lines.push(side.used == null ? "Used —" : `Used ${format(side.used)}`);
  if (side.request != null) lines.push(`Request ${format(side.request)}`);
  if (side.limit != null) {
    lines.push(`Limit ${format(side.limit)}`);
    const pct = uncappedUsagePercent(side.used, side.limit);
    if (pct != null) lines.push(`${Math.round(pct)}%`);
  } else if (side.containerCount > 1) {
    lines.push(`Limit on ${side.limitedCount}/${side.containerCount} containers`);
  } else {
    lines.push("No limit");
  }
  return lines.join("\n");
}
