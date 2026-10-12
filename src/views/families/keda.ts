import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import { readyConditionLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asNumber, asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const GROUP = "keda.sh";

const KINDS = new Set([
  "ScaledObject",
  "ScaledJob",
  "TriggerAuthentication",
  "ClusterTriggerAuthentication",
]);

export const KEDA_NAV: CrdNavItem[] = [
  { kind: "ScaledObject", apiVersion: "keda.sh/v1alpha1", group: "Autoscaling", apiGroup: GROUP },
  { kind: "ScaledJob", apiVersion: "keda.sh/v1alpha1", group: "Autoscaling", apiGroup: GROUP },
];

function match(kind: string, apiVersion?: string | null): boolean {
  return KINDS.has(kind) && matchesApiGroup(apiVersion, GROUP);
}

function summary(obj: K8sObject, kind: string): string {
  const spec = asRecord(obj.spec);
  const status = asRecord(obj.status);
  if (kind === "ScaledObject" || kind === "ScaledJob") {
    const target = asRecord(spec?.scaleTargetRef);
    const targetName = asString(target?.name);
    const targetKind = asString(target?.kind) || "Deployment";
    const min = asNumber(spec?.minReplicaCount);
    const max = asNumber(spec?.maxReplicaCount);
    const current = asNumber(status?.currentReplicas) ?? asNumber(status?.desiredReplicas);
    const range = min != null || max != null ? `${min ?? "—"}–${max ?? "—"}` : null;
    return (
      [
        targetName && `${targetKind}/${targetName}`,
        range,
        current != null && typeof current === "number" ? `cur:${current}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "—"
    );
  }
  return "—";
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "ScaledObject" || kind === "ScaledJob") {
    const target = asRecord(spec?.scaleTargetRef);
    const name = asString(target?.name);
    const tKind = asString(target?.kind) || "Deployment";
    if (name) {
      const apiVersion =
        tKind === "Deployment" || tKind === "StatefulSet" || tKind === "DaemonSet"
          ? "apps/v1"
          : asString(target?.apiVersion) || "apps/v1";
      links.push({
        id: `keda-target-${name}`,
        group: "Scales",
        title: `${tKind}/${name}`,
        apiVersion,
        kind: tKind,
        namespace: ns,
        name,
      });
    }
    const triggers = Array.isArray(spec?.triggers) ? spec!.triggers : [];
    for (const t of triggers) {
      const tr = asRecord(t);
      const auth = asRecord(tr?.authenticationRef);
      const authName = asString(auth?.name);
      if (!authName) continue;
      links.push({
        id: `keda-auth-${authName}`,
        group: "Auth",
        title: `TriggerAuthentication/${authName}`,
        apiVersion: "keda.sh/v1alpha1",
        kind: "TriggerAuthentication",
        namespace: ns,
        name: authName,
      });
    }
  }

  return links;
}

const views: KindViewDef[] = [
  {
    match,
    hasStatusColumn: true,
    hasSummaryColumn: true,
    statusLabels: (obj) => [readyConditionLabel(obj as Record<string, unknown>)],
    listSummary: (obj) => summary(obj, String(obj.kind || "")),
    extractRelations: relations,
  },
];

export const kedaFamily: CrdFamily = {
  id: "keda",
  nav: KEDA_NAV,
  views,
  clusterHas: (d) => clusterHasApiGroup(d, GROUP),
};
