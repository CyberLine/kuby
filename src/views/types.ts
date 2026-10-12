import type { JSX } from "solid-js";
import type { DiscoveredResource, K8sObject } from "../types";
import type { StatusLabel } from "../utils/conditions";
import type { RelationLink } from "../utils/relations";

export type CrdNavItem = {
  kind: string;
  /** Preferred apiVersion; overridden from discovery when present. */
  apiVersion: string;
  group: string;
  /** API group prefix used for discovery matching, e.g. cert-manager.io */
  apiGroup: string;
  label?: string;
};

export type CrdDetailContext = {
  context: string;
  apiVersion: string;
  kind: string;
  obj: K8sObject;
  discovered: DiscoveredResource[];
  allObjects: K8sObject[];
  openRelation: (link: RelationLink) => void;
};

export type KindViewDef = {
  /** Match kind + apiVersion / group. */
  match: (kind: string, apiVersion?: string | null) => boolean;
  /** Show Status column in the resource list. */
  hasStatusColumn?: boolean;
  /** Show Expires column (cert-manager). */
  hasExpiresColumn?: boolean;
  /** Show Summary column with listSummary text. */
  hasSummaryColumn?: boolean;
  statusLabels?: (obj: K8sObject) => StatusLabel[];
  /** Short secondary list text (hosts, target, …). */
  listSummary?: (obj: K8sObject) => string;
  extractRelations?: (
    obj: K8sObject,
    kind: string,
    discovered?: DiscoveredResource[],
  ) => RelationLink[];
  /** Extra detail UI rendered above Labels / Status JSON. */
  DetailSection?: (props: CrdDetailContext) => JSX.Element;
};

export type CrdFamily = {
  id: string;
  nav: CrdNavItem[];
  views: KindViewDef[];
  /** True when any resource of this family's apiGroup is discovered. */
  clusterHas: (discovered: { group?: string; apiVersion?: string }[] | undefined | null) => boolean;
};
