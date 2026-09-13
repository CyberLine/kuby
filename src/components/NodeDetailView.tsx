import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../api/tauri";
import type { K8sObject, NodeMetrics, NodeStats, PodMetrics } from "../types";
import { getSamples, historyKey, pushSample } from "../utils/metricHistory";
import {
  conditionTone,
  nodeAddressByType,
  nodeAllocatable,
  nodeCapacity,
  nodeConditions,
  nodeLabels,
  nodeResourceLimit,
  nodeSystemInfo,
  nodeTaints,
  podPhaseLabel,
  podRestartCount,
} from "../utils/nodeDetail";
import { isNodeUnschedulable, nodePodLimit, nodeStatusLabels } from "../utils/nodeStatus";
import {
  formatBytes,
  formatCpu,
  parseCpuMillis,
  parseMemoryBytes,
  percentTone,
  usagePercent,
} from "../utils/quantity";
import { MetricChart, type MetricSample } from "./MetricChart";
import { ResourceIcon } from "./ResourceIcon";

const POLL_MS = 5000;

export type NodeDetailAction = "cordon" | "uncordon" | "drain";

type Props = {
  context: string;
  node: Accessor<K8sObject>;
  pods: Accessor<K8sObject[]>;
  podsReady: boolean;
  onBack: () => void;
  onNodeAction: (action: NodeDetailAction) => void;
  onOpenPod: (namespace: string, name: string) => void;
};

type MetricPanel = {
  title: string;
  usedLabel: string;
  limitLabel: string;
  percent: number | null;
  tone: "ok" | "warn" | "err" | "muted";
  samples: MetricSample[];
  emptyHint: string;
};

export function NodeDetailView(props: Props) {
  const [nodeMetrics, setNodeMetrics] = createSignal<NodeMetrics | null>(null);
  const [nodeStats, setNodeStats] = createSignal<NodeStats | null>(null);
  const [podMetrics, setPodMetrics] = createSignal<PodMetrics[]>([]);
  const [metricsUnavailable, setMetricsUnavailable] = createSignal(false);
  const [cpuSamples, setCpuSamples] = createSignal<MetricSample[]>([]);
  const [memSamples, setMemSamples] = createSignal<MetricSample[]>([]);
  const [storageSamples, setStorageSamples] = createSignal<MetricSample[]>([]);
  const [podSamples, setPodSamples] = createSignal<MetricSample[]>([]);

  const name = createMemo(() => props.node().metadata?.name || props.node().name || "");
  const unschedulable = createMemo(() =>
    isNodeUnschedulable(props.node() as unknown as Record<string, unknown>),
  );
  const statusLabels = createMemo(() =>
    nodeStatusLabels(props.node() as unknown as Record<string, unknown>),
  );
  const info = createMemo(() => nodeSystemInfo(props.node() as unknown as Record<string, unknown>));
  const internalIp = createMemo(() =>
    nodeAddressByType(props.node() as unknown as Record<string, unknown>, "InternalIP"),
  );
  const externalIp = createMemo(() =>
    nodeAddressByType(props.node() as unknown as Record<string, unknown>, "ExternalIP"),
  );
  const conditions = createMemo(() =>
    nodeConditions(props.node() as unknown as Record<string, unknown>),
  );
  const taints = createMemo(() => nodeTaints(props.node() as unknown as Record<string, unknown>));
  const labels = createMemo(() => nodeLabels(props.node() as unknown as Record<string, unknown>));
  const capacity = createMemo(() =>
    nodeCapacity(props.node() as unknown as Record<string, unknown>),
  );
  const allocatable = createMemo(() =>
    nodeAllocatable(props.node() as unknown as Record<string, unknown>),
  );

  const cpuLimitMillis = createMemo(() =>
    parseCpuMillis(nodeResourceLimit(props.node() as unknown as Record<string, unknown>, "cpu")),
  );
  const memLimitBytes = createMemo(() =>
    parseMemoryBytes(
      nodeResourceLimit(props.node() as unknown as Record<string, unknown>, "memory"),
    ),
  );
  const storageLimitBytes = createMemo(() =>
    parseMemoryBytes(
      nodeResourceLimit(props.node() as unknown as Record<string, unknown>, "ephemeral-storage"),
    ),
  );
  const podLimit = createMemo(() =>
    nodePodLimit(props.node() as unknown as Record<string, unknown>),
  );

  const cpuUsedMillis = createMemo(() => parseCpuMillis(nodeMetrics()?.cpu));
  const memUsedBytes = createMemo(() => parseMemoryBytes(nodeMetrics()?.memory));
  const storageUsedBytes = createMemo(() => {
    const s = nodeStats();
    return s?.fsUsedBytes != null && Number.isFinite(s.fsUsedBytes) ? s.fsUsedBytes : null;
  });
  const storageCapBytes = createMemo(() => {
    const s = nodeStats();
    if (s?.fsCapacityBytes != null && Number.isFinite(s.fsCapacityBytes) && s.fsCapacityBytes > 0) {
      return s.fsCapacityBytes;
    }
    return storageLimitBytes();
  });

  const cpuPct = createMemo(() => usagePercent(cpuUsedMillis(), cpuLimitMillis()));
  const memPct = createMemo(() => usagePercent(memUsedBytes(), memLimitBytes()));
  const storagePct = createMemo(() => usagePercent(storageUsedBytes(), storageCapBytes()));
  const podsUsed = createMemo(() => props.pods().length);
  const podsPct = createMemo(() => usagePercent(podsUsed(), podLimit()));

  const panels = createMemo((): MetricPanel[] => {
    const noMetrics = metricsUnavailable() ? "No metrics-server data" : "Collecting samples…";
    return [
      {
        title: "CPU",
        usedLabel: formatCpu(cpuUsedMillis()),
        limitLabel: formatCpu(cpuLimitMillis()),
        percent: cpuPct(),
        tone: percentTone(cpuPct()),
        samples: cpuSamples(),
        emptyHint: noMetrics,
      },
      {
        title: "Memory",
        usedLabel: formatBytes(memUsedBytes()),
        limitLabel: formatBytes(memLimitBytes()),
        percent: memPct(),
        tone: percentTone(memPct()),
        samples: memSamples(),
        emptyHint: noMetrics,
      },
      {
        title: "Storage",
        usedLabel: formatBytes(storageUsedBytes()),
        limitLabel: formatBytes(storageCapBytes()),
        percent: storagePct(),
        tone: percentTone(storagePct()),
        samples: storageSamples(),
        emptyHint: storageUsedBytes() == null ? "No kubelet storage stats" : "Collecting samples…",
      },
      {
        title: "Pods",
        usedLabel: props.podsReady ? String(podsUsed()) : "—",
        limitLabel: podLimit() == null ? "—" : String(podLimit()),
        percent: props.podsReady ? podsPct() : null,
        tone: props.podsReady ? percentTone(podsPct()) : "muted",
        samples: podSamples(),
        emptyHint: props.podsReady ? "Collecting samples…" : "Loading pods…",
      },
    ];
  });

  const podMetricMap = createMemo(() => {
    const map = new Map<string, PodMetrics>();
    for (const m of podMetrics()) {
      map.set(`${m.namespace}/${m.name}`, m);
    }
    return map;
  });

  const resourceRows = createMemo(() => {
    const keys = new Set([...Object.keys(capacity()), ...Object.keys(allocatable())]);
    const preferred = [
      "cpu",
      "memory",
      "ephemeral-storage",
      "pods",
      "hugepages-2Mi",
      "hugepages-1Gi",
    ];
    const ordered = [
      ...preferred.filter((k) => keys.has(k)),
      ...[...keys].filter((k) => !preferred.includes(k)).sort(),
    ];
    return ordered.map((key) => ({
      key,
      capacity: capacity()[key] || "—",
      allocatable: allocatable()[key] || "—",
    }));
  });

  async function pollOnce(ctx: string, nodeName: string) {
    try {
      const [allNodeMetrics, stats, allPodMetrics] = await Promise.all([
        api.getNodeMetrics(ctx).catch(() => [] as NodeMetrics[]),
        api.getNodeStats(ctx, nodeName).catch(() => null),
        api.getPodMetrics(ctx, null).catch(() => [] as PodMetrics[]),
      ]);
      const mine = allNodeMetrics.find((m) => m.name === nodeName) || null;
      setNodeMetrics(mine);
      setMetricsUnavailable(allNodeMetrics.length === 0);
      if (stats) setNodeStats(stats);
      setPodMetrics(allPodMetrics);

      const cpuLim = parseCpuMillis(
        nodeResourceLimit(props.node() as unknown as Record<string, unknown>, "cpu"),
      );
      const memLim = parseMemoryBytes(
        nodeResourceLimit(props.node() as unknown as Record<string, unknown>, "memory"),
      );
      const cpuUsed = parseCpuMillis(mine?.cpu);
      const memUsed = parseMemoryBytes(mine?.memory);
      const cpuP = usagePercent(cpuUsed, cpuLim);
      const memP = usagePercent(memUsed, memLim);

      if (cpuP != null) {
        setCpuSamples(pushSample(historyKey(ctx, nodeName, "cpu"), cpuP));
      } else {
        setCpuSamples(getSamples(historyKey(ctx, nodeName, "cpu")));
      }
      if (memP != null) {
        setMemSamples(pushSample(historyKey(ctx, nodeName, "memory"), memP));
      } else {
        setMemSamples(getSamples(historyKey(ctx, nodeName, "memory")));
      }

      const fsUsed = stats?.fsUsedBytes;
      const fsCap =
        stats?.fsCapacityBytes != null && stats.fsCapacityBytes > 0
          ? stats.fsCapacityBytes
          : parseMemoryBytes(
              nodeResourceLimit(
                props.node() as unknown as Record<string, unknown>,
                "ephemeral-storage",
              ),
            );
      const storageP = usagePercent(
        fsUsed != null && Number.isFinite(fsUsed) ? fsUsed : null,
        fsCap,
      );
      if (storageP != null) {
        setStorageSamples(pushSample(historyKey(ctx, nodeName, "storage"), storageP));
      } else {
        setStorageSamples(getSamples(historyKey(ctx, nodeName, "storage")));
      }

      const podLim = nodePodLimit(props.node() as unknown as Record<string, unknown>);
      const podUsed = props.pods().length;
      const podP = props.podsReady ? usagePercent(podUsed, podLim) : null;
      if (podP != null) {
        setPodSamples(pushSample(historyKey(ctx, nodeName, "pods"), podP));
      } else {
        setPodSamples(getSamples(historyKey(ctx, nodeName, "pods")));
      }
    } catch (e) {
      console.warn("node detail poll failed", e);
      setMetricsUnavailable(true);
    }
  }

  createEffect(() => {
    const ctx = props.context;
    const nodeName = name();
    if (!ctx || !nodeName) return;

    setCpuSamples(getSamples(historyKey(ctx, nodeName, "cpu")));
    setMemSamples(getSamples(historyKey(ctx, nodeName, "memory")));
    setStorageSamples(getSamples(historyKey(ctx, nodeName, "storage")));
    setPodSamples(getSamples(historyKey(ctx, nodeName, "pods")));

    let cancelled = false;
    void pollOnce(ctx, nodeName);
    const id = window.setInterval(() => {
      if (!cancelled) void pollOnce(ctx, nodeName);
    }, POLL_MS);

    onCleanup(() => {
      cancelled = true;
      window.clearInterval(id);
    });
  });

  function onOpenPodSafe(namespace: string, podName: string) {
    if (!namespace || !podName) return;
    props.onOpenPod(namespace, podName);
  }

  return (
    <section class="node-detail-overlay">
      <header class="node-detail-toolbar">
        <button type="button" class="btn" onClick={() => props.onBack()}>
          ← Back
        </button>
        <div class="node-detail-toolbar-title">
          <ResourceIcon kind="Node" />
          <span class="mono">{name()}</span>
          <div class="status-labels">
            <For each={statusLabels()}>
              {(label) => <span class={`status-label ${label.tone}`}>{label.text}</span>}
            </For>
          </div>
        </div>
        <div class="node-detail-toolbar-actions">
          <Show when={!unschedulable()}>
            <button type="button" class="btn" onClick={() => props.onNodeAction("cordon")}>
              Cordon
            </button>
          </Show>
          <Show when={unschedulable()}>
            <button type="button" class="btn" onClick={() => props.onNodeAction("uncordon")}>
              Uncordon
            </button>
          </Show>
          <button type="button" class="btn" onClick={() => props.onNodeAction("drain")}>
            Drain
          </button>
        </div>
      </header>

      <div class="node-detail-scroll">
        <header class="node-detail-header">
          <p class="node-detail-meta muted">
            <Show when={info().kubeletVersion}>
              <span class="mono">{info().kubeletVersion}</span>
              <span>·</span>
            </Show>
            <Show when={info().operatingSystem || info().architecture}>
              <span>{[info().operatingSystem, info().architecture].filter(Boolean).join("/")}</span>
              <span>·</span>
            </Show>
            <Show when={internalIp()}>
              <span>
                Internal <span class="mono">{internalIp()}</span>
              </span>
            </Show>
            <Show when={externalIp()}>
              <span>·</span>
              <span>
                External <span class="mono">{externalIp()}</span>
              </span>
            </Show>
          </p>
          <Show when={info().osImage}>
            <p class="node-detail-os muted">{info().osImage}</p>
          </Show>
        </header>

        <Show when={metricsUnavailable()}>
          <div class="banner warn node-metrics-banner">
            metrics-server unavailable — showing capacity only; live usage graphs need
            metrics.k8s.io
          </div>
        </Show>

        <section class="node-metrics">
          <For each={panels()}>
            {(panel) => (
              <MetricChart
                title={panel.title}
                usedLabel={panel.usedLabel}
                limitLabel={panel.limitLabel}
                percent={panel.percent}
                tone={panel.tone}
                samples={panel.samples}
                emptyHint={panel.emptyHint}
              />
            )}
          </For>
        </section>

        <section class="node-pods">
          <div class="node-section-head">
            <h3>Pods on this node</h3>
            <span class="muted">
              {props.podsReady ? `${props.pods().length}` : "…"}
              {podLimit() != null ? ` / ${podLimit()}` : ""}
            </span>
          </div>
          <Show
            when={props.pods().length > 0}
            fallback={
              <div class="node-pods-table-wrap node-pods-empty">
                <p class="muted node-empty">
                  {props.podsReady ? "No running pods on this node" : "Loading pods…"}
                </p>
              </div>
            }
          >
            <div class="node-pods-table-wrap">
              <table class="meta-table node-pods-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>Mem</th>
                    <th>Restarts</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={props.pods()}>
                    {(pod) => {
                      const ns = () => pod.metadata?.namespace || "";
                      const pname = () => pod.metadata?.name || "";
                      const key = () => `${ns()}/${pname()}`;
                      const m = () => podMetricMap().get(key());
                      const phase = () => podPhaseLabel(pod as unknown as Record<string, unknown>);
                      return (
                        <tr>
                          <td>
                            <button
                              type="button"
                              class="relation-link node-pod-link"
                              onClick={() => onOpenPodSafe(ns(), pname())}
                            >
                              {pname()}
                            </button>
                          </td>
                          <td class="mono muted">{ns()}</td>
                          <td>
                            <span class={`status-label ${phase().tone}`}>{phase().text}</span>
                          </td>
                          <td class="mono">{m()?.cpu || "—"}</td>
                          <td class="mono">{m()?.memory || "—"}</td>
                          <td class="mono">
                            {podRestartCount(pod as unknown as Record<string, unknown>)}
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>

        <section class="node-info-grid">
          <div class="node-info-block">
            <h3>Conditions</h3>
            <Show when={conditions().length} fallback={<p class="muted node-empty">—</p>}>
              <table class="meta-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={conditions()}>
                    {(c) => (
                      <tr>
                        <td>
                          <span class={`status-label ${conditionTone(c)}`}>{c.type}</span>
                        </td>
                        <td class="mono">{c.status}</td>
                        <td class="muted" title={c.message}>
                          {c.reason || "—"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>

          <div class="node-info-block">
            <h3>Capacity / Allocatable</h3>
            <table class="meta-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Capacity</th>
                  <th>Allocatable</th>
                </tr>
              </thead>
              <tbody>
                <For each={resourceRows()}>
                  {(row) => (
                    <tr>
                      <td class="mono">{row.key}</td>
                      <td class="mono">{row.capacity}</td>
                      <td class="mono">{row.allocatable}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <div class="node-info-block">
            <h3>Taints</h3>
            <Show when={taints().length} fallback={<p class="muted node-empty">None</p>}>
              <table class="meta-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th>Effect</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={taints()}>
                    {(t) => (
                      <tr>
                        <td class="mono">{t.key}</td>
                        <td class="mono">{t.value || "—"}</td>
                        <td class="mono">{t.effect}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>

          <div class="node-info-block">
            <h3>Labels</h3>
            <Show when={labels().length} fallback={<p class="muted node-empty">—</p>}>
              <table class="meta-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={labels()}>
                    {(row) => (
                      <tr>
                        <td class="mono">{row[0]}</td>
                        <td class="mono">{row[1]}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </section>
      </div>
    </section>
  );
}
