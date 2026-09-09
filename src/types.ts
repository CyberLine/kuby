export interface AuthSummary {
  method: string;
  detail: string;
  execCommand?: string | null;
  execArgs: string[];
  supportsRefresh: boolean;
}

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string | null;
  current: boolean;
  auth: AuthSummary;
}

export interface ClusterStatus {
  context: string;
  connected: boolean;
  server?: string | null;
  version?: string | null;
  error?: string | null;
}

export interface NamespaceListResult {
  namespaces: string[];
  restricted: boolean;
  defaultNamespace: string;
}

export interface NamespaceAccess {
  restricted: boolean;
  defaultNamespace: string;
}

export interface DiscoveredResource {
  group: string;
  version: string;
  kind: string;
  plural: string;
  singular: string;
  shortNames: string[];
  namespaced: boolean;
  verbs: string[];
  apiVersion: string;
  curated: boolean;
  watchable: boolean;
}

export interface ResourceIdentifier {
  context: string;
  apiVersion: string;
  kind: string;
  namespace?: string | null;
  name: string;
}

export interface RollbackResult {
  skipped: boolean;
  revision: number;
  deployment: string;
  replicaset: string;
}

export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  status?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  uid?: string;
  name?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface WatchEventPayload {
  context: string;
  apiVersion: string;
  kind: string;
  namespace?: string | null;
  event: "applied" | "deleted" | "restarted" | string;
  object?: K8sObject | null;
  objects?: K8sObject[] | null;
}

export interface WatchErrorPayload {
  context: string;
  apiVersion: string;
  kind: string;
  namespace?: string | null;
  error: string;
}

export interface LogLine {
  streamId: string;
  context: string;
  namespace: string;
  pod: string;
  line: string;
}

export interface PodMetrics {
  name: string;
  namespace: string;
  cpu: string;
  memory: string;
  containers: { name: string; cpu: string; memory: string }[];
}

export interface NodeMetrics {
  name: string;
  cpu: string;
  memory: string;
}

export interface OverviewSegment {
  label: string;
  count: number;
  tone: "ok" | "warn" | "err" | "idle" | string;
}

export interface OverviewCard {
  kind: string;
  total: number;
  segments: OverviewSegment[];
}

export interface OverviewWarning {
  reason: string;
  count: number;
  lastSeen: string;
  age: string;
  message: string;
  involved: string;
  involvedKind: string;
  involvedName: string;
  involvedNamespace?: string | null;
  involvedApiVersion?: string | null;
  context: string;
}

export interface OverviewOpenTarget {
  kind: string;
  name: string;
  namespace?: string | null;
  apiVersion?: string | null;
}

export interface OverviewRestart {
  context: string;
  namespace: string;
  pod: string;
  container: string;
  reason: string;
  exitCode?: number | null;
  restartCount: number;
  age: string;
}

export interface OverviewUsage {
  context: string;
  namespace: string;
  pod: string;
  container: string;
  cpu: string;
  memory: string;
  cpuPercent: number;
  memoryPercent: number;
}

export interface WorkloadOverview {
  cards: OverviewCard[];
  warnings: OverviewWarning[];
  restarts: OverviewRestart[];
  usage: OverviewUsage[];
}

export interface DiffHunk {
  tag: "equal" | "delete" | "insert" | string;
  value: string;
}

export interface PortForwardInfo {
  id: string;
  context: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
}

export type PanelTab = "detail" | "yaml" | "logs" | "exec" | "diff" | "portforward";
