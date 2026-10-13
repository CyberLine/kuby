import type { DiscoveredResource, K8sObject } from "../types";
import type { StatusLabel } from "../utils/conditions";
import type { RelationLink } from "../utils/relations";
import { argoFamily } from "./families/argo";
import { certManagerFamily } from "./families/certManager";
import { externalSecretsFamily } from "./families/externalSecrets";
import { fluxFamily } from "./families/flux";
import { kedaFamily } from "./families/keda";
import { prometheusFamily } from "./families/prometheus";
import { routingFamily } from "./families/routing";
import { resolveNavApiVersion } from "./helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "./types";

export const CRD_FAMILIES: CrdFamily[] = [
  routingFamily,
  certManagerFamily,
  prometheusFamily,
  externalSecretsFamily,
  fluxFamily,
  argoFamily,
  kedaFamily,
];

const ALL_VIEWS: KindViewDef[] = CRD_FAMILIES.flatMap((f) => f.views);

export function findKindView(kind: string, apiVersion?: string | null): KindViewDef | null {
  return ALL_VIEWS.find((v) => v.match(kind, apiVersion)) ?? null;
}

export function kindViewHasStatusColumn(kind: string, apiVersion?: string | null): boolean {
  return Boolean(findKindView(kind, apiVersion)?.hasStatusColumn);
}

export function kindViewHasExpiresColumn(kind: string, apiVersion?: string | null): boolean {
  return Boolean(findKindView(kind, apiVersion)?.hasExpiresColumn);
}

export function kindViewHasSummaryColumn(kind: string, apiVersion?: string | null): boolean {
  return Boolean(findKindView(kind, apiVersion)?.hasSummaryColumn);
}

export function kindViewStatusLabels(
  obj: K8sObject,
  kind: string,
  apiVersion?: string | null,
): StatusLabel[] | null {
  const view = findKindView(kind, apiVersion);
  if (!view?.statusLabels) return null;
  return view.statusLabels({ ...obj, kind: obj.kind || kind });
}

export function kindViewListSummary(
  obj: K8sObject,
  kind: string,
  apiVersion?: string | null,
): string | null {
  const view = findKindView(kind, apiVersion);
  if (!view?.listSummary) return null;
  return view.listSummary({ ...obj, kind: obj.kind || kind });
}

export function kindViewRelations(
  obj: K8sObject,
  kind: string,
  discovered?: DiscoveredResource[],
): RelationLink[] {
  const apiVersion = typeof obj.apiVersion === "string" ? obj.apiVersion : undefined;
  const view = findKindView(kind, apiVersion);
  if (!view?.extractRelations) return [];
  return view.extractRelations(obj, kind, discovered);
}

/** Curated nav entries for CRD families present in the cluster. */
export function curatedCrdNavItems(
  discovered: DiscoveredResource[] | undefined | null,
): CrdNavItem[] {
  const out: CrdNavItem[] = [];
  for (const family of CRD_FAMILIES) {
    if (!family.clusterHas(discovered)) continue;
    for (const item of family.nav) {
      if (!clusterHasKind(discovered, item.kind, item.apiGroup)) continue;
      out.push({
        ...item,
        apiVersion: resolveNavApiVersion(item, discovered),
      });
    }
  }
  return out;
}

function clusterHasKind(
  discovered: DiscoveredResource[] | undefined | null,
  kind: string,
  apiGroup: string,
): boolean {
  if (!discovered?.length) return false;
  const want = apiGroup.toLowerCase();
  return discovered.some(
    (r) =>
      r.kind === kind &&
      ((r.group || "").toLowerCase() === want ||
        (r.apiVersion || "").toLowerCase().startsWith(`${want}/`)),
  );
}

export type { CrdNavItem, KindViewDef } from "./types";
