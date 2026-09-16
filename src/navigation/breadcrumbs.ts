import { kindIsClusterScoped } from "../constants/resources";
import type { NavLocation, NavMode } from "./history";

export type BreadcrumbAction = "overview" | "kind-list" | "close-visualize" | "close-node" | null;

export type BreadcrumbSegment = {
  id: string;
  label: string;
  title?: string;
  /** null = current / not clickable */
  action: BreadcrumbAction;
};

function modeFromKind(kind: string, mode: NavMode): NavMode {
  if (mode === "node" || mode === "visualize") return mode;
  if (kind === "Overview") return "overview";
  if (kind === "Longhorn") return "longhorn";
  return mode;
}

/** Structural crumbs: Cluster › Namespace › Kind › Resource (plus overlay modes). */
export function buildBreadcrumbs(loc: NavLocation): BreadcrumbSegment[] {
  const crumbs: BreadcrumbSegment[] = [];
  const mode = modeFromKind(loc.kind, loc.mode);

  crumbs.push({
    id: "context",
    label: loc.context || "Cluster",
    title: "Go to Overview",
    action: mode === "overview" && !loc.objectName ? null : "overview",
  });

  const clusterScoped = kindIsClusterScoped(loc.kind) || mode === "node";
  const nss = (loc.namespaces || []).filter((n) => n && n !== "*");
  const allNs = (loc.namespaces || []).includes("*");

  if (mode === "visualize" && loc.visualizeNamespace) {
    crumbs.push({
      id: "ns",
      label: loc.visualizeNamespace,
      title: "Leave visualize",
      action: "close-visualize",
    });
    crumbs.push({
      id: "visualize",
      label: "Visualize",
      action: null,
    });
    return crumbs;
  }

  if (!clusterScoped) {
    if (nss.length === 1) {
      crumbs.push({
        id: "ns",
        label: nss[0]!,
        title: nss[0],
        action: null,
      });
    } else if (nss.length > 1) {
      crumbs.push({
        id: "ns",
        label: `${nss.length} namespaces`,
        title: nss.join(", "),
        action: null,
      });
    } else if (allNs) {
      crumbs.push({
        id: "ns",
        label: "All namespaces",
        action: null,
      });
    }
  }

  if (mode === "overview") {
    crumbs.push({ id: "kind", label: "Overview", action: null });
    return crumbs;
  }

  if (mode === "longhorn") {
    crumbs.push({ id: "kind", label: "Longhorn", action: null });
    return crumbs;
  }

  if (mode === "node" && loc.viewingNodeName) {
    crumbs.push({
      id: "kind",
      label: "Node",
      title: "Back to Nodes list",
      action: "close-node",
    });
    crumbs.push({
      id: "resource",
      label: loc.viewingNodeName,
      action: null,
    });
    return crumbs;
  }

  const kindLabel = loc.kind;
  const hasResource = Boolean(loc.objectName || (mode === "detail" && loc.objectKey));

  crumbs.push({
    id: "kind",
    label: kindLabel,
    title: hasResource ? `Show ${kindLabel} list` : undefined,
    action: hasResource ? "kind-list" : null,
  });

  if (loc.objectName) {
    crumbs.push({
      id: "resource",
      label: loc.objectName,
      action: null,
    });
  }

  return crumbs;
}
