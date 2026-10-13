import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import { readyConditionLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const GROUP = "external-secrets.io";

const KINDS = new Set(["ExternalSecret", "SecretStore", "ClusterSecretStore", "PushSecret"]);

export const EXTERNAL_SECRETS_NAV: CrdNavItem[] = [
  {
    kind: "ExternalSecret",
    apiVersion: "external-secrets.io/v1",
    group: "Secrets",
    apiGroup: GROUP,
  },
  {
    kind: "SecretStore",
    apiVersion: "external-secrets.io/v1",
    group: "Secrets",
    apiGroup: GROUP,
  },
  {
    kind: "ClusterSecretStore",
    apiVersion: "external-secrets.io/v1",
    group: "Secrets",
    apiGroup: GROUP,
  },
  {
    kind: "PushSecret",
    apiVersion: "external-secrets.io/v1alpha1",
    group: "Secrets",
    apiGroup: GROUP,
  },
];

function match(kind: string, apiVersion?: string | null): boolean {
  return KINDS.has(kind) && matchesApiGroup(apiVersion, GROUP);
}

function summary(obj: K8sObject, kind: string): string {
  const spec = asRecord(obj.spec);
  if (kind === "ExternalSecret") {
    const store = asRecord(spec?.secretStoreRef);
    const storeName = asString(store?.name);
    const target = asString(asRecord(spec?.target)?.name);
    const refresh = asString(spec?.refreshInterval);
    return (
      [storeName && `store:${storeName}`, target && `→ ${target}`, refresh]
        .filter(Boolean)
        .join(" · ") || "—"
    );
  }
  if (kind === "SecretStore" || kind === "ClusterSecretStore") {
    const provider = asRecord(spec?.provider) || {};
    const keys = Object.keys(provider);
    return keys[0] || "—";
  }
  if (kind === "PushSecret") {
    const refs = Array.isArray(spec?.secretStoreRefs) ? (spec!.secretStoreRefs as unknown[]) : [];
    return asString(asRecord(refs[0])?.name) || "—";
  }
  return "—";
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "ExternalSecret") {
    const store = asRecord(spec?.secretStoreRef);
    const storeName = asString(store?.name);
    const storeKind = asString(store?.kind) || "SecretStore";
    if (storeName) {
      links.push({
        id: `eso-store-${storeName}`,
        group: "Store",
        title: `${storeKind}/${storeName}`,
        apiVersion: "external-secrets.io/v1",
        kind: storeKind,
        namespace: storeKind === "ClusterSecretStore" ? null : ns,
        name: storeName,
      });
    }
    const targetName = asString(asRecord(spec?.target)?.name);
    if (targetName) {
      links.push({
        id: `eso-target-${targetName}`,
        group: "Target",
        title: `Secret/${targetName}`,
        apiVersion: "v1",
        kind: "Secret",
        namespace: ns,
        name: targetName,
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
    statusLabels: (obj) => [
      readyConditionLabel(obj as Record<string, unknown>, ["Ready", "Synced"]),
    ],
    listSummary: (obj) => summary(obj, String(obj.kind || "")),
    extractRelations: relations,
  },
];

export const externalSecretsFamily: CrdFamily = {
  id: "external-secrets",
  nav: EXTERNAL_SECRETS_NAV,
  views,
  clusterHas: (d) => clusterHasApiGroup(d, GROUP),
};
