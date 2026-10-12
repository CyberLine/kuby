import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import { readyConditionLabel, type StatusLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const HELM = "helm.toolkit.fluxcd.io";
const SOURCE = "source.toolkit.fluxcd.io";
const KUSTOMIZE = "kustomize.toolkit.fluxcd.io";

const FLUX_KINDS = new Set([
  "HelmRelease",
  "GitRepository",
  "HelmRepository",
  "OCIRepository",
  "Bucket",
  "Kustomization",
  "HelmChart",
]);

export const FLUX_NAV: CrdNavItem[] = [
  {
    kind: "GitRepository",
    apiVersion: "source.toolkit.fluxcd.io/v1",
    group: "GitOps",
    apiGroup: SOURCE,
  },
  {
    kind: "HelmRepository",
    apiVersion: "source.toolkit.fluxcd.io/v1",
    group: "GitOps",
    apiGroup: SOURCE,
  },
  {
    kind: "OCIRepository",
    apiVersion: "source.toolkit.fluxcd.io/v1beta2",
    group: "GitOps",
    apiGroup: SOURCE,
  },
  {
    kind: "Kustomization",
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    group: "GitOps",
    apiGroup: KUSTOMIZE,
  },
];

export function isFluxKind(kind: string, apiVersion?: string | null): boolean {
  if (!FLUX_KINDS.has(kind)) return false;
  return (
    matchesApiGroup(apiVersion, HELM) ||
    matchesApiGroup(apiVersion, SOURCE) ||
    matchesApiGroup(apiVersion, KUSTOMIZE)
  );
}

export function canFluxReconcileAction(kind: string, apiVersion?: string | null): boolean {
  return isFluxKind(kind, apiVersion);
}

export function canFluxSuspendAction(kind: string, apiVersion?: string | null): boolean {
  return (
    (kind === "HelmRelease" && matchesApiGroup(apiVersion, HELM)) ||
    (kind === "Kustomization" && matchesApiGroup(apiVersion, KUSTOMIZE)) ||
    ((kind === "GitRepository" ||
      kind === "HelmRepository" ||
      kind === "OCIRepository" ||
      kind === "Bucket") &&
      matchesApiGroup(apiVersion, SOURCE))
  );
}

function isSuspended(obj: K8sObject): boolean {
  return Boolean(asRecord(obj.spec)?.suspend);
}

function statusLabels(obj: K8sObject): StatusLabel[] {
  const labels: StatusLabel[] = [readyConditionLabel(obj as Record<string, unknown>)];
  if (isSuspended(obj)) labels.push({ text: "Suspended", tone: "warn" });
  return labels;
}

function revision(obj: K8sObject): string {
  const status = asRecord(obj.status);
  return (
    asString(status?.lastAppliedRevision) ||
    asString(status?.lastAttemptedRevision) ||
    asString(asRecord(status?.artifact)?.revision) ||
    "—"
  );
}

function summary(obj: K8sObject, kind: string): string {
  const spec = asRecord(obj.spec);
  if (kind === "HelmRelease") {
    const chart = asRecord(asRecord(spec?.chart)?.spec);
    const chartName = asString(chart?.chart);
    const ver = asString(chart?.version);
    return (
      [chartName, ver, revision(obj) !== "—" ? revision(obj) : null].filter(Boolean).join(" · ") ||
      "—"
    );
  }
  if (kind === "Kustomization") {
    const path = asString(spec?.path);
    const src = asRecord(spec?.sourceRef);
    return (
      [asString(src?.kind) && asString(src?.name) && `${src!.kind}/${src!.name}`, path]
        .filter(Boolean)
        .join(" · ") || revision(obj)
    );
  }
  if (kind === "GitRepository" || kind === "OCIRepository" || kind === "HelmRepository") {
    return asString(spec?.url) || revision(obj);
  }
  return revision(obj);
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "HelmRelease") {
    const chart = asRecord(asRecord(spec?.chart)?.spec);
    const src = asRecord(chart?.sourceRef);
    const srcName = asString(src?.name);
    if (srcName) {
      links.push({
        id: `flux-hr-src-${srcName}`,
        group: "Source",
        title: `${asString(src?.kind) || "HelmRepository"}/${srcName}`,
        apiVersion: "source.toolkit.fluxcd.io/v1",
        kind: asString(src?.kind) || "HelmRepository",
        namespace: asString(src?.namespace) || ns,
        name: srcName,
      });
    }
    const targetNs = asString(spec?.targetNamespace);
    if (targetNs) {
      links.push({
        id: `flux-hr-ns-${targetNs}`,
        group: "Target",
        title: `Namespace/${targetNs}`,
        apiVersion: "v1",
        kind: "Namespace",
        namespace: null,
        name: targetNs,
      });
    }
  }

  if (kind === "Kustomization") {
    const src = asRecord(spec?.sourceRef);
    const srcName = asString(src?.name);
    if (srcName) {
      links.push({
        id: `flux-ks-src-${srcName}`,
        group: "Source",
        title: `${asString(src?.kind) || "GitRepository"}/${srcName}`,
        apiVersion: "source.toolkit.fluxcd.io/v1",
        kind: asString(src?.kind) || "GitRepository",
        namespace: asString(src?.namespace) || ns,
        name: srcName,
      });
    }
  }

  return links;
}

const views: KindViewDef[] = [
  {
    match: isFluxKind,
    hasStatusColumn: true,
    hasSummaryColumn: true,
    statusLabels,
    listSummary: (obj) => summary(obj, String(obj.kind || "")),
    extractRelations: relations,
  },
];

export const fluxFamily: CrdFamily = {
  id: "flux",
  nav: FLUX_NAV,
  views,
  clusterHas: (d) =>
    clusterHasApiGroup(d, HELM) ||
    clusterHasApiGroup(d, SOURCE) ||
    clusterHasApiGroup(d, KUSTOMIZE),
};

export function isFluxSuspended(obj: K8sObject): boolean {
  return isSuspended(obj);
}
