import { objectName, objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import type { StatusLabel } from "../../utils/conditions";
import { readyConditionLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const TRAEFIK = "traefik.io";
const GATEWAY = "gateway.networking.k8s.io";

const TRAEFIK_KINDS = new Set([
  "IngressRoute",
  "IngressRouteTCP",
  "IngressRouteUDP",
  "Middleware",
  "TraefikService",
]);

const GATEWAY_KINDS = new Set([
  "Gateway",
  "HTTPRoute",
  "GRPCRoute",
  "TCPRoute",
  "TLSRoute",
  "GatewayClass",
  "ReferenceGrant",
]);

export const ROUTING_NAV: CrdNavItem[] = [
  { kind: "IngressRoute", apiVersion: "traefik.io/v1alpha1", group: "Network", apiGroup: TRAEFIK },
  {
    kind: "IngressRouteTCP",
    apiVersion: "traefik.io/v1alpha1",
    group: "Network",
    apiGroup: TRAEFIK,
  },
  { kind: "Middleware", apiVersion: "traefik.io/v1alpha1", group: "Network", apiGroup: TRAEFIK },
  {
    kind: "TraefikService",
    apiVersion: "traefik.io/v1alpha1",
    group: "Network",
    apiGroup: TRAEFIK,
  },
  {
    kind: "Gateway",
    apiVersion: "gateway.networking.k8s.io/v1",
    group: "Network",
    apiGroup: GATEWAY,
  },
  {
    kind: "HTTPRoute",
    apiVersion: "gateway.networking.k8s.io/v1",
    group: "Network",
    apiGroup: GATEWAY,
  },
  {
    kind: "GRPCRoute",
    apiVersion: "gateway.networking.k8s.io/v1",
    group: "Network",
    apiGroup: GATEWAY,
  },
];

export function isRoutingKind(kind: string, apiVersion?: string | null): boolean {
  if (kind === "Ingress" && (!apiVersion || apiVersion.startsWith("networking.k8s.io/"))) {
    return true;
  }
  if (TRAEFIK_KINDS.has(kind) && matchesApiGroup(apiVersion, TRAEFIK)) return true;
  if (GATEWAY_KINDS.has(kind) && matchesApiGroup(apiVersion, GATEWAY)) return true;
  return false;
}

export function isRouteFlowKind(kind: string, apiVersion?: string | null): boolean {
  if (kind === "Ingress" && (!apiVersion || apiVersion.startsWith("networking.k8s.io/"))) {
    return true;
  }
  if (
    (kind === "IngressRoute" || kind === "IngressRouteTCP" || kind === "IngressRouteUDP") &&
    matchesApiGroup(apiVersion, TRAEFIK)
  ) {
    return true;
  }
  if (
    (kind === "HTTPRoute" || kind === "GRPCRoute" || kind === "TCPRoute" || kind === "TLSRoute") &&
    matchesApiGroup(apiVersion, GATEWAY)
  ) {
    return true;
  }
  if (kind === "Gateway" && matchesApiGroup(apiVersion, GATEWAY)) return true;
  return false;
}

function traefikHosts(obj: K8sObject): string {
  const spec = asRecord(obj.spec);
  const routes = Array.isArray(spec?.routes) ? spec!.routes : [];
  const hosts: string[] = [];
  for (const r of routes) {
    const match = asString(asRecord(r)?.match);
    if (!match) continue;
    const re = /Host(?:SNI)?\(`([^`]+)`\)/g;
    for (const m of match.matchAll(re)) {
      if (m[1]) hosts.push(m[1]);
    }
  }
  return [...new Set(hosts)].join(", ") || asString(asRecord(routes[0])?.match) || "—";
}

function gatewayHosts(obj: K8sObject): string {
  const spec = asRecord(obj.spec);
  const hostnames = Array.isArray(spec?.hostnames)
    ? spec!.hostnames.filter((h): h is string => typeof h === "string")
    : [];
  if (hostnames.length) return hostnames.join(", ");
  const listeners = Array.isArray(spec?.listeners) ? spec!.listeners : [];
  const ports = listeners
    .map((l) => asRecord(l))
    .filter(Boolean)
    .map((l) => `${asString(l!.protocol)}:${asString(l!.port) || asString(l!.name)}`)
    .filter(Boolean);
  return ports.join(", ") || "—";
}

function ingressHosts(obj: K8sObject): string {
  const spec = asRecord(obj.spec);
  const rules = Array.isArray(spec?.rules) ? spec!.rules : [];
  const hosts = rules.map((r) => asString(asRecord(r)?.host)).filter(Boolean);
  return hosts.join(", ") || "—";
}

function middlewareSummary(obj: K8sObject): string {
  const spec = asRecord(obj.spec) || {};
  const keys = Object.keys(spec).filter((k) => k !== "apiVersion" && k !== "kind");
  return keys.length ? keys.join(", ") : "—";
}

function routingSummary(obj: K8sObject, kind: string): string {
  if (kind === "Middleware") return middlewareSummary(obj);
  if (kind === "TraefikService") {
    const spec = asRecord(obj.spec);
    if (asRecord(spec?.weighted)) return "weighted";
    if (asRecord(spec?.mirroring)) return "mirroring";
    return "—";
  }
  if (kind.startsWith("IngressRoute") || kind === "IngressRoute") return traefikHosts(obj);
  if (kind === "HTTPRoute" || kind === "GRPCRoute" || kind === "TCPRoute" || kind === "TLSRoute") {
    return gatewayHosts(obj);
  }
  if (kind === "Gateway") return gatewayHosts(obj);
  if (kind === "Ingress") return ingressHosts(obj);
  return "—";
}

function routingStatus(obj: K8sObject, kind: string): StatusLabel[] {
  if (kind === "Gateway" || kind === "HTTPRoute" || kind === "GRPCRoute") {
    return [
      readyConditionLabel(obj as Record<string, unknown>, ["Accepted", "Programmed", "Ready"]),
    ];
  }
  if (kind.startsWith("IngressRoute") || kind === "Ingress") {
    return [{ text: "Configured", tone: "ok" }];
  }
  return [readyConditionLabel(obj as Record<string, unknown>)];
}

function routingRelations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const name = objectName(obj);
  const spec = asRecord(obj.spec);

  if (kind === "IngressRoute" || kind === "IngressRouteTCP" || kind === "IngressRouteUDP") {
    const routes = Array.isArray(spec?.routes) ? spec!.routes : [];
    const seenMw = new Set<string>();
    const seenSvc = new Set<string>();
    for (const r of routes) {
      const route = asRecord(r);
      const middlewares = Array.isArray(route?.middlewares) ? route!.middlewares : [];
      for (const mw of middlewares) {
        const m = asRecord(mw);
        const mwName = asString(m?.name);
        if (!mwName || seenMw.has(mwName)) continue;
        seenMw.add(mwName);
        links.push({
          id: `traefik-mw-${mwName}`,
          group: "Middleware",
          title: `Middleware/${mwName}`,
          apiVersion: "traefik.io/v1alpha1",
          kind: "Middleware",
          namespace: asString(m?.namespace) || ns,
          name: mwName,
        });
      }
      const services = Array.isArray(route?.services) ? route!.services : [];
      for (const svc of services) {
        const s = asRecord(svc);
        const svcName = asString(s?.name);
        if (!svcName || seenSvc.has(svcName)) continue;
        seenSvc.add(svcName);
        const kindHint = asString(s?.kind) || "Service";
        links.push({
          id: `traefik-svc-${svcName}`,
          group: "Backends",
          title: `${kindHint}/${svcName}`,
          apiVersion: kindHint === "TraefikService" ? "traefik.io/v1alpha1" : "v1",
          kind: kindHint,
          namespace: asString(s?.namespace) || ns,
          name: svcName,
        });
      }
    }
    const tls = asRecord(spec?.tls);
    const secretName = asString(tls?.secretName);
    if (secretName) {
      links.push({
        id: `traefik-tls-${secretName}`,
        group: "TLS",
        title: `Secret/${secretName}`,
        apiVersion: "v1",
        kind: "Secret",
        namespace: ns,
        name: secretName,
      });
    }
  }

  if (kind === "HTTPRoute" || kind === "GRPCRoute" || kind === "TCPRoute" || kind === "TLSRoute") {
    const parents = Array.isArray(spec?.parentRefs) ? spec!.parentRefs : [];
    for (const p of parents) {
      const parent = asRecord(p);
      const pName = asString(parent?.name);
      if (!pName) continue;
      links.push({
        id: `gw-parent-${pName}`,
        group: "Gateway",
        title: `Gateway/${pName}`,
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: asString(parent?.kind) || "Gateway",
        namespace: asString(parent?.namespace) || ns,
        name: pName,
      });
    }
    const rules = Array.isArray(spec?.rules) ? spec!.rules : [];
    const seen = new Set<string>();
    for (const rule of rules) {
      const backends = Array.isArray(asRecord(rule)?.backendRefs)
        ? (asRecord(rule)!.backendRefs as unknown[])
        : [];
      for (const b of backends) {
        const br = asRecord(b);
        const bName = asString(br?.name);
        if (!bName || seen.has(bName)) continue;
        seen.add(bName);
        links.push({
          id: `gw-backend-${bName}`,
          group: "Backends",
          title: `Service/${bName}`,
          apiVersion: "v1",
          kind: asString(br?.kind) || "Service",
          namespace: asString(br?.namespace) || ns,
          name: bName,
        });
      }
    }
  }

  if (kind === "Gateway") {
    const gc = asString(spec?.gatewayClassName);
    if (gc) {
      links.push({
        id: `gw-class-${gc}`,
        group: "Class",
        title: `GatewayClass/${gc}`,
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "GatewayClass",
        namespace: null,
        name: gc,
      });
    }
  }

  void name;
  return links;
}

const views: KindViewDef[] = [
  {
    match: (kind, apiVersion) => isRoutingKind(kind, apiVersion),
    hasStatusColumn: true,
    hasSummaryColumn: true,
    statusLabels: (obj) => routingStatus(obj, String(obj.kind || "")),
    listSummary: (obj) => routingSummary(obj, String(obj.kind || "")),
    extractRelations: (obj, kind) => routingRelations(obj, kind),
  },
];

export const routingFamily: CrdFamily = {
  id: "routing",
  nav: ROUTING_NAV,
  views,
  clusterHas: (discovered) =>
    clusterHasApiGroup(discovered, TRAEFIK) || clusterHasApiGroup(discovered, GATEWAY),
};
