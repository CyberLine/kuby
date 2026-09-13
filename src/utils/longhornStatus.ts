/** Shared Longhorn Volume / Node status labels (mirrors backend overview cards). */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function conditionStatus(obj: Record<string, unknown>, condType: string): string | null {
  const status = asRecord(obj.status);
  const conditions = status?.conditions;
  if (!Array.isArray(conditions)) return null;
  for (const c of conditions) {
    const rec = asRecord(c);
    if (!rec) continue;
    if (str(rec.type).toLowerCase() !== condType.toLowerCase()) continue;
    const s = str(rec.status) || str(rec.condition);
    return s || null;
  }
  return null;
}

function isTrue(s: string | null): boolean {
  return (s || "").toLowerCase() === "true";
}

export function isLonghornApi(apiVersion: string | null | undefined): boolean {
  return (apiVersion || "").startsWith("longhorn.io/");
}

export function isCoreNode(kind: string, apiVersion: string | null | undefined): boolean {
  return kind === "Node" && (apiVersion === "v1" || !apiVersion);
}

export function longhornVolumeStatusLabel(obj: Record<string, unknown>): {
  text: string;
  tone: "ok" | "warn" | "err" | "muted" | "info";
} {
  const status = asRecord(obj.status) || {};
  const state = str(status.state).toLowerCase();
  const robustness = str(status.robustness).toLowerCase();

  if (robustness === "faulted") return { text: "Fault", tone: "err" };
  if (state === "detached") return { text: "Detached", tone: "muted" };
  if (
    state === "creating" ||
    state === "attaching" ||
    state === "detaching" ||
    state === "deleting"
  ) {
    return { text: "In Progress", tone: "info" };
  }
  if (robustness === "degraded") return { text: "Degraded", tone: "warn" };
  if (robustness === "healthy" && state === "attached") return { text: "Healthy", tone: "ok" };
  if (state === "attached" && (!robustness || robustness === "unknown")) {
    return { text: "Healthy", tone: "ok" };
  }
  if (state || robustness) return { text: "In Progress", tone: "info" };
  return { text: "Unknown", tone: "muted" };
}

export function longhornNodeStatusLabel(obj: Record<string, unknown>): {
  text: string;
  tone: "ok" | "warn" | "err" | "muted";
} {
  const ready = isTrue(conditionStatus(obj, "Ready"));
  if (!ready) return { text: "Down", tone: "err" };
  const spec = asRecord(obj.spec) || {};
  const allow = typeof spec.allowScheduling === "boolean" ? spec.allowScheduling : true;
  if (!allow) return { text: "Disabled", tone: "muted" };
  const sched = conditionStatus(obj, "Schedulable");
  if (sched != null && !isTrue(sched)) return { text: "Unschedulable", tone: "warn" };
  return { text: "Schedulable", tone: "ok" };
}
