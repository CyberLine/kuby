/** Shared status.conditions helpers for CRD list badges and detail panels. */

export type StatusTone = "ok" | "warn" | "err" | "muted" | "info";

export type StatusLabel = {
  text: string;
  tone: StatusTone;
};

export type ConditionInfo = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function objectConditions(obj: Record<string, unknown> | null | undefined): ConditionInfo[] {
  const status = asRecord(obj?.status);
  const conditions = status?.conditions;
  if (!Array.isArray(conditions)) return [];
  const out: ConditionInfo[] = [];
  for (const c of conditions) {
    const rec = asRecord(c);
    if (!rec) continue;
    const type = str(rec.type);
    if (!type) continue;
    out.push({
      type,
      status: str(rec.status) || str(rec.condition) || "Unknown",
      reason: str(rec.reason) || undefined,
      message: str(rec.message) || undefined,
      lastTransitionTime: str(rec.lastTransitionTime) || undefined,
    });
  }
  return out;
}

export function findCondition(
  obj: Record<string, unknown> | null | undefined,
  type: string,
): ConditionInfo | null {
  const want = type.toLowerCase();
  return objectConditions(obj).find((c) => c.type.toLowerCase() === want) ?? null;
}

export function conditionIsTrue(c: ConditionInfo | null | undefined): boolean {
  return (c?.status || "").toLowerCase() === "true";
}

/** Prefer Ready, then Synced / Healthy / Available. */
export function primaryCondition(
  obj: Record<string, unknown> | null | undefined,
  preferred: string[] = ["Ready", "Synced", "Healthy", "Available"],
): ConditionInfo | null {
  const all = objectConditions(obj);
  if (!all.length) return null;
  for (const name of preferred) {
    const hit = all.find((c) => c.type.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return all[0] ?? null;
}

export function conditionTone(c: ConditionInfo | null | undefined): StatusTone {
  if (!c) return "muted";
  const status = c.status.toLowerCase();
  const reason = (c.reason || "").toLowerCase();
  if (status === "true") return "ok";
  if (status === "unknown" || reason.includes("progress") || reason.includes("reconcil")) {
    return "warn";
  }
  if (status === "false") return "err";
  return "muted";
}

export function readyConditionLabel(
  obj: Record<string, unknown> | null | undefined,
  preferred?: string[],
): StatusLabel {
  const c = primaryCondition(obj, preferred);
  if (!c) return { text: "—", tone: "muted" };
  const text = c.reason || (conditionIsTrue(c) ? c.type : `Not ${c.type}`);
  return { text, tone: conditionTone(c) };
}

export function asObjRecord(v: unknown): Record<string, unknown> | null {
  return asRecord(v);
}

export function asString(v: unknown): string {
  return str(v);
}
