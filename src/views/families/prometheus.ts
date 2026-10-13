import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const GROUP = "monitoring.coreos.com";

const KINDS = new Set(["ServiceMonitor", "PodMonitor", "Probe", "PrometheusRule", "Prometheus"]);

export const PROMETHEUS_NAV: CrdNavItem[] = [
  {
    kind: "ServiceMonitor",
    apiVersion: "monitoring.coreos.com/v1",
    group: "Observability",
    apiGroup: GROUP,
  },
  {
    kind: "PodMonitor",
    apiVersion: "monitoring.coreos.com/v1",
    group: "Observability",
    apiGroup: GROUP,
  },
  {
    kind: "PrometheusRule",
    apiVersion: "monitoring.coreos.com/v1",
    group: "Observability",
    apiGroup: GROUP,
  },
  {
    kind: "Probe",
    apiVersion: "monitoring.coreos.com/v1",
    group: "Observability",
    apiGroup: GROUP,
  },
];

function match(kind: string, apiVersion?: string | null): boolean {
  return KINDS.has(kind) && matchesApiGroup(apiVersion, GROUP);
}

function endpointCount(obj: K8sObject): number {
  const spec = asRecord(obj.spec);
  const endpoints = Array.isArray(spec?.endpoints) ? spec!.endpoints : [];
  return endpoints.length;
}

function ruleGroupCount(obj: K8sObject): number {
  const spec = asRecord(obj.spec);
  const groups = Array.isArray(spec?.groups) ? spec!.groups : [];
  return groups.length;
}

function summary(obj: K8sObject, kind: string): string {
  if (kind === "ServiceMonitor" || kind === "PodMonitor") {
    const n = endpointCount(obj);
    const interval = asString(
      asRecord((asRecord(obj.spec)?.endpoints as unknown[])?.[0])?.interval,
    );
    return (
      [n ? `${n} endpoint${n === 1 ? "" : "s"}` : null, interval || null]
        .filter(Boolean)
        .join(" · ") || "—"
    );
  }
  if (kind === "PrometheusRule") {
    const n = ruleGroupCount(obj);
    return n ? `${n} group${n === 1 ? "" : "s"}` : "—";
  }
  if (kind === "Probe") {
    const spec = asRecord(obj.spec);
    return asString(asRecord(spec?.prober)?.url) || "—";
  }
  return "—";
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "ServiceMonitor") {
    const selector = asRecord(spec?.selector);
    const labels = asRecord(selector?.matchLabels) || {};
    const labelSelector: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (typeof v === "string") labelSelector[k] = v;
    }
    links.push({
      id: "sm-services",
      group: "Targets",
      title: Object.keys(labelSelector).length ? "Matching Services" : "Services (namespace)",
      apiVersion: "v1",
      kind: "Service",
      namespace: ns,
      labelSelector,
    });
  }

  if (kind === "PodMonitor") {
    const selector = asRecord(spec?.selector);
    const labels = asRecord(selector?.matchLabels) || {};
    const labelSelector: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (typeof v === "string") labelSelector[k] = v;
    }
    links.push({
      id: "pm-pods",
      group: "Targets",
      title: "Matching Pods",
      apiVersion: "v1",
      kind: "Pod",
      namespace: ns,
      labelSelector,
    });
  }

  return links;
}

const views: KindViewDef[] = [
  {
    match,
    hasStatusColumn: false,
    hasSummaryColumn: true,
    listSummary: (obj) => summary(obj, String(obj.kind || "")),
    extractRelations: relations,
  },
];

export const prometheusFamily: CrdFamily = {
  id: "prometheus",
  nav: PROMETHEUS_NAV,
  views,
  clusterHas: (d) => clusterHasApiGroup(d, GROUP),
};
