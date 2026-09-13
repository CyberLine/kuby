import { invoke } from "@tauri-apps/api/core";
import { demoWorkloadOverview, isDemoMode } from "../fixtures/demo";
import type {
  ClusterStatus,
  ContextInfo,
  DiffHunk,
  DiscoveredResource,
  LonghornOverview,
  NamespaceListResult,
  NodeMetrics,
  NodeStats,
  PodMetrics,
  PortForwardInfo,
  ResourceIdentifier,
  RollbackResult,
  WorkloadOverview,
} from "../types";

export const api = {
  listContexts: () => invoke<ContextInfo[]>("list_contexts"),
  connectCluster: (context: string) => invoke<ClusterStatus>("connect_cluster", { context }),
  disconnectCluster: (context: string) => invoke<void>("disconnect_cluster", { context }),
  listActiveClusters: () => invoke<string[]>("list_active_clusters"),
  testCluster: (context: string) => invoke<ClusterStatus>("test_cluster", { context }),
  getAuthInfo: (context: string) => invoke("get_auth_info", { context }),

  listApiResources: (context: string, refresh = false) =>
    invoke<DiscoveredResource[]>("list_api_resources", { context, refresh }),
  listNamespaces: (context: string) => invoke<NamespaceListResult>("list_namespaces", { context }),
  createNamespace: (context: string, name: string) =>
    invoke<string>("create_namespace", { context, name }),
  getResource: (ident: ResourceIdentifier) =>
    invoke<Record<string, unknown>>("get_resource", { ident }),
  getResourceYaml: (ident: ResourceIdentifier) => invoke<string>("get_resource_yaml", { ident }),
  applyYaml: (context: string, yaml: string) => invoke("apply_yaml", { context, yaml }),
  patchResourceData: (ident: ResourceIdentifier, data: Record<string, string>) =>
    invoke<Record<string, unknown>>("patch_resource_data", { ident, data }),
  deleteResource: (ident: ResourceIdentifier) => invoke<void>("delete_resource", { ident }),
  startResourceWatch: (
    context: string,
    apiVersion: string,
    kind: string,
    namespace?: string | null,
  ) =>
    invoke<string>("start_resource_watch", {
      context,
      apiVersion,
      kind,
      namespace: namespace ?? null,
    }),
  stopResourceWatch: (context: string, key: string) =>
    invoke<void>("stop_resource_watch", { context, key }),
  listResourcesOnce: (
    context: string,
    apiVersion: string,
    kind: string,
    namespace?: string | null,
  ) =>
    invoke<Record<string, unknown>[]>("list_resources_once", {
      context,
      apiVersion,
      kind,
      namespace: namespace ?? null,
    }),

  scaleWorkload: (
    context: string,
    kind: string,
    namespace: string,
    name: string,
    replicas: number,
  ) =>
    invoke<void>("scale_workload", {
      context,
      kind,
      namespace,
      name,
      replicas,
    }),
  restartWorkload: (context: string, kind: string, namespace: string, name: string) =>
    invoke<void>("restart_workload", { context, kind, namespace, name }),
  rollbackDeployment: (args: {
    context: string;
    namespace: string;
    name: string;
    toRevision?: number | null;
    fromReplicaSet?: string | null;
  }) => invoke<RollbackResult>("rollback_deployment", args),
  deletePod: (context: string, namespace: string, name: string) =>
    invoke<void>("delete_pod", { context, namespace, name }),
  resourceAction: (action: string, ident: ResourceIdentifier, replicas?: number) =>
    invoke<void>("resource_action", { action, ident, replicas }),

  cordonNode: (context: string, name: string) => invoke<void>("cordon_node", { context, name }),
  uncordonNode: (context: string, name: string) => invoke<void>("uncordon_node", { context, name }),
  drainNode: (context: string, name: string) => invoke<void>("drain_node", { context, name }),

  startPodLogs: (args: {
    context: string;
    namespace: string;
    pod: string;
    container?: string;
    previous?: boolean;
    tailLines?: number;
  }) => invoke<string>("start_pod_logs", args),
  stopPodLogs: (context: string, streamId: string) =>
    invoke<void>("stop_pod_logs", { context, streamId }),
  startAggregatedLogs: (
    targets: {
      context: string;
      namespace: string;
      pod: string;
      container?: string;
    }[],
    previous?: boolean,
    tailLines?: number,
  ) =>
    invoke<string[]>("start_aggregated_logs", {
      targets,
      previous,
      tailLines,
    }),

  startExecSession: (args: {
    context: string;
    namespace: string;
    pod: string;
    container?: string;
    command?: string[];
  }) => invoke<string>("start_exec_session", args),
  writeExecStdin: (sessionId: string, data: string) =>
    invoke<void>("write_exec_stdin", { sessionId, data }),
  stopExecSession: (context: string, sessionId: string) =>
    invoke<void>("stop_exec_session", { context, sessionId }),

  startPortForward: (args: {
    context: string;
    namespace: string;
    pod: string;
    localPort: number;
    remotePort: number;
  }) => invoke<PortForwardInfo>("start_port_forward", args),
  stopPortForward: (context: string, id: string) =>
    invoke<void>("stop_port_forward", { context, id }),

  getPodMetrics: (context: string, namespace?: string | null) =>
    invoke<PodMetrics[]>("get_pod_metrics", { context, namespace }),
  getNodeMetrics: (context: string) => invoke<NodeMetrics[]>("get_node_metrics", { context }),
  getNodeStats: (context: string, name: string) =>
    invoke<NodeStats>("get_node_stats", { context, name }),
  getWorkloadOverview: (context: string, namespaces: string[], usageThreshold?: number) =>
    isDemoMode()
      ? Promise.resolve(demoWorkloadOverview(context))
      : invoke<WorkloadOverview>("get_workload_overview", {
          context,
          namespaces,
          usageThreshold,
        }),
  getLonghornOverview: (context: string) =>
    invoke<LonghornOverview>("get_longhorn_overview", { context }),
  diffResources: (leftYaml: string, rightYaml: string) =>
    invoke<{ hunks: DiffHunk[] }>("diff_resources", { leftYaml, rightYaml }),
  setTelemetryEnabled: (enabled: boolean) => invoke<void>("set_telemetry_enabled", { enabled }),
};
