import type { AuthSummary, ClusterStatus, ContextInfo, WorkloadOverview } from "../types";

/** Screenshot / README preview without a live cluster. */
export function isDemoMode(): boolean {
  if (import.meta.env.VITE_KUBY_DEMO === "1") return true;
  try {
    if (new URLSearchParams(window.location.search).get("demo") === "1") return true;
    if (window.location.hash === "#demo") return true;
    if (localStorage.getItem("kuby-demo") === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

export const DEMO_NAMESPACES = [
  "catalog",
  "cert-manager",
  "checkout",
  "default",
  "ingress-nginx",
  "kube-system",
  "observability",
  "payments",
];

function auth(method: string, detail: string, command: string, args: string[]): AuthSummary {
  return {
    method,
    detail,
    execCommand: command,
    execArgs: args,
    supportsRefresh: true,
  };
}

export function demoContexts(): ContextInfo[] {
  return [
    {
      name: "prod-eu-central",
      cluster: "prod-eu-central.eu-central-1.eks",
      user: "arn:aws:iam::123456789012:role/kuby",
      namespace: "checkout",
      current: true,
      auth: auth("aws-eks", "exec: aws eks get-token --cluster-name prod-eu-central", "aws", [
        "eks",
        "get-token",
        "--cluster-name",
        "prod-eu-central",
      ]),
    },
    {
      name: "staging-us-east",
      cluster: "staging-us-east.gke",
      user: "gke-staging",
      namespace: "default",
      current: false,
      auth: auth("gcp-gke", "exec: gke-gcloud-auth-plugin", "gke-gcloud-auth-plugin", []),
    },
  ];
}

export function demoStatus(context: string): ClusterStatus {
  const servers: Record<string, string> = {
    "prod-eu-central": "https://prod-eu-central.eks.amazonaws.com",
    "staging-us-east": "https://staging-us-east.gke.googleusercontent.com",
  };
  return {
    context,
    connected: true,
    server: servers[context] || "https://kubernetes.default.svc",
    version: "1.32.4",
    error: null,
  };
}

export function demoWorkloadOverview(context: string): WorkloadOverview {
  return {
    cards: [
      {
        kind: "Pods",
        total: 248,
        segments: [
          { label: "Running", count: 231, tone: "ok" },
          { label: "Completed", count: 9, tone: "idle" },
          { label: "Pending", count: 4, tone: "warn" },
          { label: "CrashLoopBackOff", count: 3, tone: "err" },
          { label: "ImagePullBackOff", count: 1, tone: "err" },
        ],
      },
      {
        kind: "Deployments",
        total: 42,
        segments: [
          { label: "Running", count: 39, tone: "ok" },
          { label: "Unavailable", count: 2, tone: "err" },
          { label: "Idle", count: 1, tone: "idle" },
        ],
      },
      {
        kind: "ReplicaSets",
        total: 67,
        segments: [
          { label: "Running", count: 42, tone: "ok" },
          { label: "Old", count: 23, tone: "idle" },
          { label: "Unavailable", count: 2, tone: "err" },
        ],
      },
      {
        kind: "CronJobs",
        total: 11,
        segments: [
          { label: "Scheduled", count: 9, tone: "ok" },
          { label: "Suspended", count: 2, tone: "idle" },
        ],
      },
      {
        kind: "Resource Quotas",
        total: 8,
        segments: [
          { label: "Ok", count: 6, tone: "ok" },
          { label: "Warning", count: 2, tone: "warn" },
        ],
      },
      {
        kind: "Disruption Budgets",
        total: 14,
        segments: [
          { label: "DisruptionAllowed", count: 12, tone: "ok" },
          { label: "Blocked", count: 2, tone: "warn" },
        ],
      },
    ],
    warnings: [
      warning(context, {
        reason: "FailedScheduling",
        count: 4,
        age: "2m",
        lastSeen: "2026-09-13T18:10:00Z",
        message: "0/12 nodes are available: 3 Insufficient cpu, 2 node(s) had untolerated taint",
        kind: "Pod",
        name: "checkout-web-7f8d9c4b-xk2n4",
        namespace: "checkout",
      }),
      warning(context, {
        reason: "BackOff",
        count: 12,
        age: "8m",
        lastSeen: "2026-09-13T18:04:00Z",
        message: "Back-off restarting failed container worker in pod payments-worker-0",
        kind: "Pod",
        name: "payments-worker-0",
        namespace: "payments",
      }),
      warning(context, {
        reason: "Unhealthy",
        count: 3,
        age: "14m",
        lastSeen: "2026-09-13T17:58:00Z",
        message: "Readiness probe failed: HTTP probe failed with statuscode: 503",
        kind: "Pod",
        name: "catalog-api-6b2f7d9c-m4q8p",
        namespace: "catalog",
      }),
      warning(context, {
        reason: "FailedMount",
        count: 2,
        age: "21m",
        lastSeen: "2026-09-13T17:51:00Z",
        message: 'MountVolume.SetUp failed for volume "loki-data": object is being deleted',
        kind: "Pod",
        name: "loki-0",
        namespace: "observability",
      }),
      warning(context, {
        reason: "FailedGetResourceMetric",
        count: 6,
        age: "37m",
        lastSeen: "2026-09-13T17:35:00Z",
        message: "unable to get metric cpu: no metrics returned from resource metrics API",
        kind: "HorizontalPodAutoscaler",
        name: "checkout-api",
        namespace: "checkout",
        apiVersion: "autoscaling/v2",
      }),
    ],
    restarts: [
      {
        context,
        namespace: "payments",
        pod: "payments-worker-0",
        container: "worker",
        reason: "Error",
        exitCode: 1,
        restartCount: 7,
        age: "3m",
      },
      {
        context,
        namespace: "checkout",
        pod: "checkout-web-7f8d9c4b-xk2n4",
        container: "app",
        reason: "CrashLoopBackOff",
        exitCode: 137,
        restartCount: 5,
        age: "6m",
      },
      {
        context,
        namespace: "observability",
        pod: "grafana-0",
        container: "grafana",
        reason: "OOMKilled",
        exitCode: 137,
        restartCount: 2,
        age: "18m",
      },
    ],
    usage: [
      {
        context,
        namespace: "checkout",
        pod: "checkout-api-5d8c7b9f-n2w1q",
        container: "app",
        cpu: "980m / 1",
        memory: "1.1Gi / 1Gi",
        cpuPercent: 98,
        memoryPercent: 110,
      },
      {
        context,
        namespace: "payments",
        pod: "payments-worker-0",
        container: "worker",
        cpu: "1900m / 2",
        memory: "3.8Gi / 4Gi",
        cpuPercent: 95,
        memoryPercent: 95,
      },
      {
        context,
        namespace: "catalog",
        pod: "catalog-index-0",
        container: "indexer",
        cpu: "480m / 500m",
        memory: "6.2Gi / 8Gi",
        cpuPercent: 96,
        memoryPercent: 78,
      },
      {
        context,
        namespace: "observability",
        pod: "prometheus-0",
        container: "prometheus",
        cpu: "3.8 / 4",
        memory: "14Gi / 16Gi",
        cpuPercent: 95,
        memoryPercent: 88,
      },
    ],
  };
}

function warning(
  context: string,
  w: {
    reason: string;
    count: number;
    age: string;
    lastSeen: string;
    message: string;
    kind: string;
    name: string;
    namespace: string;
    apiVersion?: string;
  },
) {
  return {
    reason: w.reason,
    count: w.count,
    lastSeen: w.lastSeen,
    age: w.age,
    message: w.message,
    involved: `${w.kind}/${w.name}`,
    involvedKind: w.kind,
    involvedName: w.name,
    involvedNamespace: w.namespace,
    involvedApiVersion: w.apiVersion ?? "v1",
    context,
  };
}
