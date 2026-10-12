import { canArgoRefreshAction, canArgoSyncAction } from "../views/families/argo";
import { canFluxReconcileAction, canFluxSuspendAction } from "../views/families/flux";

/** Kinds that support a simple Kubernetes DELETE. */
export function canDeleteKind(kind: string): boolean {
  if (!kind || kind === "Overview" || kind === "Longhorn" || kind === "Helm") return false;
  // Binding-like cluster objects are deletable; Node delete is rarely what users want
  if (kind === "Node") return false;
  return true;
}

/** Flux HelmRelease supports suspend / resume / reconcile via patch. */
export function canFluxHelmReleaseAction(kind: string, apiVersion?: string | null): boolean {
  return kind === "HelmRelease" && (apiVersion || "").startsWith("helm.toolkit.fluxcd.io/");
}

/** Any Flux resource that supports reconcile annotation. */
export function canFluxAction(kind: string, apiVersion?: string | null): boolean {
  return canFluxReconcileAction(kind, apiVersion);
}

export function canFluxSuspend(kind: string, apiVersion?: string | null): boolean {
  return canFluxSuspendAction(kind, apiVersion);
}

export function canArgoRefresh(kind: string, apiVersion?: string | null): boolean {
  return canArgoRefreshAction(kind, apiVersion);
}

export function canArgoSync(kind: string, apiVersion?: string | null): boolean {
  return canArgoSyncAction(kind, apiVersion);
}

export function canScaleKind(kind: string): boolean {
  return ["Deployment", "StatefulSet", "ReplicaSet"].includes(kind);
}

export function canRestartKind(kind: string): boolean {
  return ["Deployment", "StatefulSet", "DaemonSet"].includes(kind);
}

export function canRollbackDeployment(kind: string): boolean {
  return kind === "Deployment";
}

export function canNodeAction(kind: string, apiVersion?: string | null): boolean {
  return kind === "Node" && (!apiVersion || apiVersion === "v1");
}

const PROTECTED_NAMESPACES = new Set(["default", "kube-system", "kube-public", "kube-node-lease"]);

export function isProtectedNamespace(name: string): boolean {
  return PROTECTED_NAMESPACES.has(name);
}
