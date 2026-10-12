import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import type { StatusLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const GROUP = "argoproj.io";

const KINDS = new Set(["Application", "ApplicationSet", "AppProject"]);

export const ARGO_NAV: CrdNavItem[] = [
  {
    kind: "Application",
    apiVersion: "argoproj.io/v1alpha1",
    group: "GitOps",
    apiGroup: GROUP,
  },
  {
    kind: "ApplicationSet",
    apiVersion: "argoproj.io/v1alpha1",
    group: "GitOps",
    apiGroup: GROUP,
  },
  {
    kind: "AppProject",
    apiVersion: "argoproj.io/v1alpha1",
    group: "GitOps",
    apiGroup: GROUP,
  },
];

function match(kind: string, apiVersion?: string | null): boolean {
  return KINDS.has(kind) && matchesApiGroup(apiVersion, GROUP);
}

export function canArgoRefreshAction(kind: string, apiVersion?: string | null): boolean {
  return kind === "Application" && matchesApiGroup(apiVersion, GROUP);
}

export function canArgoSyncAction(kind: string, apiVersion?: string | null): boolean {
  return kind === "Application" && matchesApiGroup(apiVersion, GROUP);
}

function healthTone(health: string): StatusLabel["tone"] {
  const h = health.toLowerCase();
  if (h === "healthy") return "ok";
  if (h === "progressing" || h === "suspended") return "warn";
  if (h === "degraded" || h === "missing") return "err";
  return "muted";
}

function syncTone(sync: string): StatusLabel["tone"] {
  const s = sync.toLowerCase();
  if (s === "synced") return "ok";
  if (s === "outofsync") return "warn";
  return "muted";
}

function statusLabels(obj: K8sObject): StatusLabel[] {
  const status = asRecord(obj.status);
  const sync = asString(asRecord(status?.sync)?.status) || "Unknown";
  const health = asString(asRecord(status?.health)?.status) || "Unknown";
  return [
    { text: sync, tone: syncTone(sync) },
    { text: health, tone: healthTone(health) },
  ];
}

function summary(obj: K8sObject, kind: string): string {
  const spec = asRecord(obj.spec);
  if (kind === "Application") {
    const project = asString(spec?.project);
    const dest = asRecord(spec?.destination);
    const ns = asString(dest?.namespace);
    const server = asString(dest?.name) || asString(dest?.server);
    return [project && `proj:${project}`, ns, server].filter(Boolean).join(" · ") || "—";
  }
  if (kind === "ApplicationSet") {
    const gens = Array.isArray(spec?.generators) ? spec!.generators.length : 0;
    return gens ? `${gens} generator${gens === 1 ? "" : "s"}` : "—";
  }
  return "—";
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "Application") {
    const project = asString(spec?.project);
    if (project) {
      links.push({
        id: `argo-project-${project}`,
        group: "Project",
        title: `AppProject/${project}`,
        apiVersion: "argoproj.io/v1alpha1",
        kind: "AppProject",
        namespace: ns,
        name: project,
      });
    }
    const destNs = asString(asRecord(spec?.destination)?.namespace);
    if (destNs) {
      links.push({
        id: `argo-dest-ns-${destNs}`,
        group: "Destination",
        title: `Namespace/${destNs}`,
        apiVersion: "v1",
        kind: "Namespace",
        namespace: null,
        name: destNs,
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
    statusLabels,
    listSummary: (obj) => summary(obj, String(obj.kind || "")),
    extractRelations: relations,
  },
];

export const argoFamily: CrdFamily = {
  id: "argo",
  nav: ARGO_NAV,
  views,
  clusterHas: (d) => clusterHasApiGroup(d, GROUP),
};
