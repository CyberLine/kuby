import { objectNamespace } from "../../constants/resources";
import type { K8sObject } from "../../types";
import { readyConditionLabel } from "../../utils/conditions";
import type { RelationLink } from "../../utils/relations";
import { asRecord, asString, clusterHasApiGroup, matchesApiGroup } from "../helpers";
import type { CrdFamily, CrdNavItem, KindViewDef } from "../types";

const GROUP = "cert-manager.io";
const ACME = "acme.cert-manager.io";

const KINDS = new Set([
  "Certificate",
  "CertificateRequest",
  "Issuer",
  "ClusterIssuer",
  "Order",
  "Challenge",
]);

export const CERT_MANAGER_NAV: CrdNavItem[] = [
  { kind: "Certificate", apiVersion: "cert-manager.io/v1", group: "Certificates", apiGroup: GROUP },
  { kind: "Issuer", apiVersion: "cert-manager.io/v1", group: "Certificates", apiGroup: GROUP },
  {
    kind: "ClusterIssuer",
    apiVersion: "cert-manager.io/v1",
    group: "Certificates",
    apiGroup: GROUP,
  },
  {
    kind: "CertificateRequest",
    apiVersion: "cert-manager.io/v1",
    group: "Certificates",
    apiGroup: GROUP,
  },
];

function match(kind: string, apiVersion?: string | null): boolean {
  if (!KINDS.has(kind)) return false;
  return matchesApiGroup(apiVersion, GROUP) || matchesApiGroup(apiVersion, ACME);
}

function issuerSummary(obj: K8sObject): string {
  const spec = asRecord(obj.spec) || {};
  if (asRecord(spec.acme)) return "ACME";
  if (asRecord(spec.vault)) return "Vault";
  if (asRecord(spec.ca)) return "CA";
  if (asRecord(spec.selfSigned)) return "SelfSigned";
  if (asRecord(spec.venafi)) return "Venafi";
  return "—";
}

function certSummary(obj: K8sObject): string {
  const spec = asRecord(obj.spec);
  const secret = asString(spec?.secretName);
  const issuer = asRecord(spec?.issuerRef);
  const issuerName = asString(issuer?.name);
  const parts = [issuerName && `issuer:${issuerName}`, secret && `secret:${secret}`].filter(
    Boolean,
  );
  return parts.join(" · ") || "—";
}

function relations(obj: K8sObject, kind: string): RelationLink[] {
  const links: RelationLink[] = [];
  const ns = objectNamespace(obj) || null;
  const spec = asRecord(obj.spec);

  if (kind === "Certificate") {
    const issuer = asRecord(spec?.issuerRef);
    const issuerName = asString(issuer?.name);
    if (issuerName) {
      const issuerKind = asString(issuer?.kind) || "Issuer";
      links.push({
        id: `cm-issuer-${issuerName}`,
        group: "Issuer",
        title: `${issuerKind}/${issuerName}`,
        apiVersion: "cert-manager.io/v1",
        kind: issuerKind,
        namespace: issuerKind === "ClusterIssuer" ? null : ns,
        name: issuerName,
      });
    }
    const secretName = asString(spec?.secretName);
    if (secretName) {
      links.push({
        id: `cm-secret-${secretName}`,
        group: "Secret",
        title: `Secret/${secretName}`,
        apiVersion: "v1",
        kind: "Secret",
        namespace: ns,
        name: secretName,
      });
    }
  }

  if (kind === "CertificateRequest") {
    const issuer = asRecord(spec?.issuerRef);
    const issuerName = asString(issuer?.name);
    if (issuerName) {
      const issuerKind = asString(issuer?.kind) || "Issuer";
      links.push({
        id: `cm-cr-issuer-${issuerName}`,
        group: "Issuer",
        title: `${issuerKind}/${issuerName}`,
        apiVersion: "cert-manager.io/v1",
        kind: issuerKind,
        namespace: issuerKind === "ClusterIssuer" ? null : ns,
        name: issuerName,
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
    hasExpiresColumn: true,
    statusLabels: (obj) => [readyConditionLabel(obj as Record<string, unknown>)],
    listSummary: (obj) => {
      const kind = String(obj.kind || "");
      if (kind === "Certificate") return certSummary(obj);
      if (kind === "Issuer" || kind === "ClusterIssuer") return issuerSummary(obj);
      return "—";
    },
    extractRelations: relations,
  },
];

export const certManagerFamily: CrdFamily = {
  id: "cert-manager",
  nav: CERT_MANAGER_NAV,
  views,
  clusterHas: (d) => clusterHasApiGroup(d, GROUP),
};
