import { objectKey, objectNamespace } from "../constants/resources";
import type { K8sObject } from "../types";
import type { StatusLabel, StatusTone } from "./nodeStatus";

export const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function replicaSetRevision(obj: K8sObject | Record<string, unknown>): number | null {
  const meta = asRecord((obj as K8sObject).metadata);
  const annotations = asRecord(meta?.annotations);
  const raw = annotations?.[REVISION_ANNOTATION];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function replicaSetDeploymentOwner(
  obj: K8sObject | Record<string, unknown>,
): { name: string; uid?: string } | null {
  const meta = asRecord((obj as K8sObject).metadata);
  const refs = meta?.ownerReferences;
  if (!Array.isArray(refs)) return null;
  for (const raw of refs) {
    const ref = asRecord(raw);
    if (ref?.kind !== "Deployment" || typeof ref.name !== "string" || !ref.name) continue;
    return {
      name: ref.name,
      uid: typeof ref.uid === "string" ? ref.uid : undefined,
    };
  }
  return null;
}

function replicaSetDesired(obj: K8sObject | Record<string, unknown>): number {
  const spec = asRecord((obj as K8sObject).spec);
  return typeof spec?.replicas === "number" ? spec.replicas : 0;
}

function replicaSetReady(obj: K8sObject | Record<string, unknown>): number {
  const status = asRecord((obj as K8sObject).status);
  return typeof status?.readyReplicas === "number" ? status.readyReplicas : 0;
}

/** Highest-revision ReplicaSet per Deployment owner — the live generation. */
export function currentReplicaSetKeys(items: K8sObject[]): Set<string> {
  type Best = { key: string; revision: number; desired: number; created: number };
  const best = new Map<string, Best>();
  for (const obj of items) {
    const owner = replicaSetDeploymentOwner(obj);
    if (!owner) continue;
    const ownerKey = `${objectNamespace(obj)}|${owner.uid || owner.name}`;
    const revision = replicaSetRevision(obj) ?? -1;
    const desired = replicaSetDesired(obj);
    const created = Date.parse(String(obj.metadata?.creationTimestamp || "")) || 0;
    const key = objectKey(obj);
    const prev = best.get(ownerKey);
    const better =
      !prev ||
      revision > prev.revision ||
      (revision === prev.revision && desired > prev.desired) ||
      (revision === prev.revision && desired === prev.desired && created > prev.created);
    if (better) {
      best.set(ownerKey, { key, revision, desired, created });
    }
  }
  return new Set([...best.values()].map((b) => b.key));
}

function replicaRatioTone(ready: number, desired: number): StatusTone {
  if (desired > 0 && ready >= desired) return "ok";
  if (desired > 0 && ready > 0) return "warn";
  if (desired > 0) return "err";
  return "muted";
}

export function replicaSetStatusLabels(
  obj: K8sObject | Record<string, unknown>,
  currentKeys: Set<string>,
): StatusLabel[] {
  const owner = replicaSetDeploymentOwner(obj);
  const desired = replicaSetDesired(obj);
  const ready = replicaSetReady(obj);
  const rev = replicaSetRevision(obj);
  const labels: StatusLabel[] = [];

  if (owner) {
    const isCurrent = currentKeys.has(objectKey(obj as K8sObject));
    if (isCurrent && desired > 0 && ready < desired) {
      labels.push({ text: "Rolling", tone: "warn" });
    } else if (isCurrent) {
      labels.push({ text: "Current", tone: "ok" });
    } else {
      labels.push({ text: "Old", tone: "muted" });
    }
  } else if (desired === 0) {
    labels.push({ text: "Idle", tone: "muted" });
  }

  labels.push({ text: `${ready}/${desired}`, tone: replicaRatioTone(ready, desired) });
  if (rev != null) {
    labels.push({ text: `rev ${rev}`, tone: "muted" });
  }
  return labels;
}

export function replicaSetStatusRank(
  obj: K8sObject | Record<string, unknown>,
  currentKeys: Set<string>,
): number {
  const generation = replicaSetStatusLabels(obj, currentKeys)[0]?.text;
  if (generation === "Current") return 0;
  if (generation === "Rolling") return 1;
  if (generation === "Old") return 2;
  if (generation === "Idle") return 3;
  return 4;
}

export function replicaSetStatusText(
  obj: K8sObject | Record<string, unknown>,
  currentKeys: Set<string>,
): string {
  return replicaSetStatusLabels(obj, currentKeys)
    .map((l) => l.text)
    .join(" ");
}

export function canRollbackReplicaSet(
  obj: K8sObject | Record<string, unknown>,
  currentKeys: Set<string>,
): boolean {
  if (!replicaSetDeploymentOwner(obj)) return false;
  return !currentKeys.has(objectKey(obj as K8sObject));
}
