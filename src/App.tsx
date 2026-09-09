import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "./api/tauri";
import { checkForUpdates } from "./api/updater";
import logo from "./assets/logo.png";
import { AboutDialog } from "./components/AboutDialog";
import { CodeEditor } from "./components/CodeEditor";
import { ContextPicker } from "./components/ContextPicker";
import { ExecTerminal } from "./components/ExecTerminal";
import { LogViewer } from "./components/LogViewer";
import { NamespaceGraphView } from "./components/NamespaceGraphView";
import { NamespacePicker } from "./components/NamespacePicker";
import { OverviewView } from "./components/OverviewView";
import { ResourceIcon } from "./components/ResourceIcon";
import { TelemetryDialog } from "./components/TelemetryDialog";
import { ThemeToggle } from "./components/ThemeToggle";
import { VirtualList } from "./components/VirtualList";
import {
  canDeleteKind,
  canNodeAction,
  canRestartKind,
  canRollbackDeployment,
  canScaleKind,
  isProtectedNamespace,
} from "./constants/actions";
import {
  ageFromTimestamp,
  CURATED_NAV,
  kindHasMetricsColumn,
  kindHasNamespaceColumn,
  kindHasPodsColumn,
  objectKey,
  objectName,
  objectNamespace,
  resourceIsWatchable,
} from "./constants/resources";
import { clusterStore } from "./stores/cluster";
import { telemetryStore } from "./stores/telemetry";
import type {
  DiffHunk,
  K8sObject,
  NodeMetrics,
  PanelTab,
  PodMetrics,
  PortForwardInfo,
} from "./types";
import {
  formatNodePodUsage,
  isNodeUnschedulable,
  nodeKubeletVersion,
  nodePodLimit,
  nodeStatusLabels,
  nodeStatusText,
} from "./utils/nodeStatus";
import { extractRelations, groupRelations, type RelationLink } from "./utils/relations";
import {
  canRollbackReplicaSet,
  currentReplicaSetKeys,
  replicaSetDeploymentOwner,
  replicaSetRevision,
  replicaSetStatusLabels,
  replicaSetStatusRank,
  replicaSetStatusText,
} from "./utils/replicaSetStatus";
import "./App.css";

const OVERVIEW_KIND_MAP: Record<string, { apiVersion: string; kind: string }> = {
  Pods: { apiVersion: "v1", kind: "Pod" },
  Deployments: { apiVersion: "apps/v1", kind: "Deployment" },
  ReplicaSets: { apiVersion: "apps/v1", kind: "ReplicaSet" },
  CronJobs: { apiVersion: "batch/v1", kind: "CronJob" },
  "Resource Quotas": { apiVersion: "v1", kind: "ResourceQuota" },
  "Disruption Budgets": {
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
  },
};

function overviewKindToResource(cardKind: string) {
  return OVERVIEW_KIND_MAP[cardKind] || null;
}

function resolveResourceApiVersion(
  kind: string,
  apiVersion: string | null | undefined,
  discovered: { kind: string; apiVersion: string }[],
): string | null {
  if (apiVersion) return apiVersion;
  const curated = CURATED_NAV.find((n) => n.kind === kind);
  if (curated) return curated.apiVersion;
  return discovered.find((r) => r.kind === kind)?.apiVersion || null;
}

const NAV_COLLAPSED_KEY = "kuby.navCollapsedGroups";
const DETAIL_WIDTH_KEY = "kuby.detailWidth";
const DETAIL_WIDTH_MIN = 280;
const LIST_PANE_MIN = 280;
const DETAIL_SPLITTER_PX = 6;

function readDetailWidth(): number | null {
  try {
    const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= DETAIL_WIDTH_MIN) return Math.round(n);
  } catch {
    /* private mode / quota */
  }
  return null;
}

function persistDetailWidth(px: number | null) {
  try {
    if (px == null) localStorage.removeItem(DETAIL_WIDTH_KEY);
    else localStorage.setItem(DETAIL_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* private mode / quota */
  }
}

function clampDetailWidth(px: number, containerWidth: number) {
  const max = Math.max(DETAIL_WIDTH_MIN, containerWidth - LIST_PANE_MIN - DETAIL_SPLITTER_PX);
  return Math.round(Math.min(Math.max(px, DETAIL_WIDTH_MIN), max));
}

function readCollapsedNavGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function persistCollapsedNavGroups(groups: Set<string>) {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...groups]));
  } catch {
    /* private mode / quota */
  }
}

function App() {
  const store = clusterStore;
  const [panel, setPanel] = createSignal<PanelTab>("detail");
  const [yaml, setYaml] = createSignal("");
  const [statusMsg, setStatusMsg] = createSignal("");
  const [statusIsError, setStatusIsError] = createSignal(false);
  const [diffHunks, setDiffHunks] = createSignal<DiffHunk[]>([]);
  const [diffBase, setDiffBase] = createSignal("");
  const [metrics, setMetrics] = createSignal<PodMetrics[]>([]);
  const [nodeMetrics, setNodeMetrics] = createSignal<NodeMetrics[]>([]);
  const [pf, setPf] = createSignal<PortForwardInfo | null>(null);
  const [localPort, setLocalPort] = createSignal(8080);
  const [remotePort, setRemotePort] = createSignal(0);
  const [scaleReplicas, setScaleReplicas] = createSignal(1);
  const [showAllApis, setShowAllApis] = createSignal(false);
  const [collapsedNavGroups, setCollapsedNavGroups] = createSignal(readCollapsedNavGroups());
  const [aggMode, setAggMode] = createSignal(false);
  const [showWelcome, setShowWelcome] = createSignal(true);
  const [showAbout, setShowAbout] = createSignal(false);
  const [connectingContext, setConnectingContext] = createSignal<string | null>(null);
  const [bootError, setBootError] = createSignal<string | null>(null);
  const [pendingSelectName, setPendingSelectName] = createSignal<string | null>(null);
  const [checkedKeys, setCheckedKeys] = createSignal<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = createSignal<number | null>(null);
  const [ctxMenu, setCtxMenu] = createSignal<{
    x: number;
    y: number;
    keys: string[];
  } | null>(null);
  const [sortKey, setSortKey] = createSignal<
    "name" | "namespace" | "status" | "metrics" | "age" | "version" | "pods"
  >("name");
  const [sortDir, setSortDir] = createSignal<"asc" | "desc">("asc");
  const [detailWidth, setDetailWidth] = createSignal<number | null>(readDetailWidth());
  let statusTimer: number | undefined;
  let contentEl!: HTMLDivElement;
  let detailPaneEl: HTMLElement | undefined;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function showStatus(msg: string, isError = false, autoHideMs = 4000) {
    setStatusIsError(isError);
    setStatusMsg(msg);
    if (statusTimer) window.clearTimeout(statusTimer);
    if (autoHideMs > 0) {
      statusTimer = window.setTimeout(() => setStatusMsg(""), autoHideMs);
    }
  }

  function dismissStatus() {
    if (statusTimer) window.clearTimeout(statusTimer);
    setStatusMsg("");
  }

  function applyDetailWidth(px: number) {
    const next = contentEl
      ? clampDetailWidth(px, contentEl.clientWidth)
      : Math.max(DETAIL_WIDTH_MIN, Math.round(px));
    setDetailWidth(next);
    return next;
  }

  function endDetailResize() {
    document.body.classList.remove("is-col-resizing");
    const w = detailWidth();
    if (w != null) persistDetailWidth(w);
  }

  function onSplitterPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const pane = detailPaneEl;
    if (!pane) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeStartX = e.clientX;
    resizeStartWidth = pane.getBoundingClientRect().width;
    document.body.classList.add("is-col-resizing");
  }

  function onSplitterPointerMove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    applyDetailWidth(resizeStartWidth + (resizeStartX - e.clientX));
  }

  function onSplitterPointerUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    endDetailResize();
  }

  function onSplitterDblClick() {
    setDetailWidth(null);
    persistDetailWidth(null);
  }

  function onSplitterKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const pane = detailPaneEl;
    if (!pane) return;
    const current = detailWidth() ?? pane.getBoundingClientRect().width;
    const step = e.shiftKey ? 48 : 16;
    persistDetailWidth(applyDetailWidth(current + (e.key === "ArrowLeft" ? step : -step)));
  }

  function podContainerNames(obj: K8sObject | null | undefined): string[] {
    if (!obj) return [];
    const spec = (obj.spec || {}) as {
      containers?: { name?: string }[];
      initContainers?: { name?: string }[];
      ephemeralContainers?: { name?: string }[];
    };
    const names = [
      ...(spec.containers || []),
      ...(spec.initContainers || []),
      ...(spec.ephemeralContainers || []),
    ]
      .map((c) => c.name || "")
      .filter(Boolean);
    return [...new Set(names)];
  }

  function podContainerPorts(obj: K8sObject | null | undefined): { port: number; name: string }[] {
    if (!obj) return [];
    const spec = (obj.spec || {}) as {
      containers?: {
        ports?: {
          name?: string;
          containerPort?: number;
          protocol?: string;
        }[];
      }[];
    };
    const seen = new Set<number>();
    const ports: { port: number; name: string }[] = [];
    for (const container of spec.containers || []) {
      for (const p of container.ports || []) {
        const port = Number(p.containerPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const protocol = (p.protocol || "TCP").toUpperCase();
        if (protocol !== "TCP") continue;
        if (seen.has(port)) continue;
        seen.add(port);
        ports.push({ port, name: p.name || "" });
      }
    }
    return ports;
  }

  function formatPodPort(p: { port: number; name: string }): string {
    return p.name ? `${p.name} (${p.port})` : String(p.port);
  }

  onMount(async () => {
    try {
      await store.refreshContexts();
    } catch (e) {
      setBootError(String(e));
      console.error(e);
    }
  });

  onMount(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    function keep(fn: UnlistenFn) {
      if (cancelled) fn();
      else unlisteners.push(fn);
    }
    void listen("open-about", () => setShowAbout(true))
      .then(keep)
      .catch(() => {});
    void listen("check-updates", () => {
      void checkForUpdates().then((msg) => showStatus(msg));
    })
      .then(keep)
      .catch(() => {});
    onCleanup(() => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    });
  });

  async function connectContext(name: string) {
    if (store.activeContexts().includes(name)) {
      store.setSelectedContext(name);
      setShowWelcome(false);
      await goToOverview();
      return;
    }
    setConnectingContext(name);
    setBootError(null);
    try {
      await store.connect(name);
      if (store.activeContexts().includes(name)) {
        setShowWelcome(false);
        await goToOverview();
      }
    } finally {
      setConnectingContext(null);
    }
  }

  async function connectMany(names: string[]) {
    setBootError(null);
    const toConnect = names.filter((n) => !store.activeContexts().includes(n));
    for (const name of toConnect) {
      setConnectingContext(name);
      await store.connect(name);
    }
    setConnectingContext(null);
    if (store.activeContexts().length) {
      setShowWelcome(false);
      await goToOverview();
    }
  }

  async function disconnectContext(name: string) {
    await store.disconnect(name);
    if (!store.activeContexts().length) {
      setShowWelcome(true);
      return;
    }
    await goToOverview();
  }

  async function selectCluster(name: string) {
    if (!name || name === store.selectedContext()) return;
    store.setSelectedContext(name);
    void store.refreshNamespaces(name);
    await goToOverview();
  }

  /** Always land on Overview after connect / cluster switch. */
  async function goToOverview() {
    if (store.visualizeNamespace()) {
      await store.stopGraphWatches();
    }
    store.clearListFilters();
    store.setSelectedObjectKey(null);
    store.setSelectedKind({ apiVersion: "kuby.io/overview", kind: "Overview" });
    setPanel("detail");
    setPendingSelectName(null);
    setCtxMenu(null);
  }

  createEffect(() => {
    const ctx = store.selectedContext();
    const kind = store.selectedKind();
    const nss = store.selectedNamespaces[ctx];
    if (!showWelcome() && ctx && kind && nss) {
      void store.watchCurrent();
    }
  });

  createEffect(() => {
    const obj = store.selectedObject();
    if (!obj) return;
    if (store.isSyntheticNamespace(obj)) {
      setYaml("");
      setDiffBase("");
      return;
    }
    const ctx = store.selectedContext();
    void api
      .getResourceYaml({
        context: ctx,
        apiVersion: (obj.apiVersion as string) || store.selectedKind().apiVersion,
        kind: (obj.kind as string) || store.selectedKind().kind,
        namespace: objectNamespace(obj) || null,
        name: objectName(obj),
      })
      .then((y) => {
        setYaml(y);
        setDiffBase(y);
      })
      .catch(console.error);
  });

  const objects = createMemo(() => store.currentObjects());

  const replicaSetCurrent = createMemo(() => {
    if (store.selectedKind().kind !== "ReplicaSet") return new Set<string>();
    return currentReplicaSetKeys(objects());
  });

  const nodePodCounts = createMemo(() => {
    if (store.selectedKind().kind !== "Node") return {} as Record<string, number>;
    return store.podCountByNodeName();
  });

  const selectedPodPorts = createMemo(() => {
    if (store.selectedKind().kind !== "Pod") return [];
    return podContainerPorts(store.selectedObject());
  });

  const detailTabs = createMemo((): PanelTab[] => {
    const kind = store.selectedKind().kind;
    const tabs: PanelTab[] = ["detail", "yaml", "diff"];
    if (kind === "Pod") {
      tabs.splice(2, 0, "logs", "exec");
      if (selectedPodPorts().length > 0) {
        tabs.splice(4, 0, "portforward");
      }
    }
    return tabs;
  });

  createEffect(() => {
    const tabs = detailTabs();
    if (!tabs.includes(panel())) {
      setPanel("detail");
    }
  });

  createEffect(() => {
    const ports = selectedPodPorts();
    if (!ports.length) return;
    if (!ports.some((p) => p.port === remotePort())) {
      setRemotePort(ports[0].port);
    }
  });

  createEffect(() => {
    const pending = pendingSelectName();
    if (!pending) return;
    const match = objects().find((o) => objectName(o) === pending);
    if (match) {
      store.setSelectedObjectKey(objectKey(match));
      setPanel("detail");
      setPendingSelectName(null);
    }
  });

  function openRelation(link: RelationLink) {
    store.clearListFilters();
    store.setSelectedObjectKey(null);
    store.setSelectedKind({ apiVersion: link.apiVersion, kind: link.kind });
    if (link.namespace) {
      store.setSelectedNamespaces(store.selectedContext(), [link.namespace]);
    }
    if (link.labelSelector) {
      store.setLabelFilter({ ...link.labelSelector });
    }
    if (link.owner) {
      store.setOwnerFilter({ ...link.owner });
    }
    if (link.name && !link.labelSelector && !link.owner) {
      store.setSearchQuery(link.name);
      setPendingSelectName(link.name);
    } else {
      setPendingSelectName(null);
    }
    setPanel("detail");
  }

  async function openVisualize(namespace: string) {
    if (!namespace || namespace === "*") return;
    setCtxMenu(null);
    store.setSelectedObjectKey(null);
    store.setSelectedNamespaces(store.selectedContext(), [namespace]);
    await store.startGraphWatches(namespace);
  }

  async function closeVisualize() {
    await store.stopGraphWatches();
  }

  function relationChipLabel(): string | null {
    const labels = store.labelFilter();
    const owner = store.ownerFilter();
    if (owner) return `owner=${owner.kind}/${owner.name}`;
    if (labels) {
      return `labels=${Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}`;
    }
    return null;
  }

  const navItems = createMemo(() => {
    if (!showAllApis()) return [...CURATED_NAV];
    const ctx = store.selectedContext();
    const discovered = store.apiResources[ctx] || [];
    return discovered.filter(resourceIsWatchable).map((r) => ({
      kind: r.kind,
      apiVersion: r.apiVersion,
      group: r.curated ? "Curated" : r.group || "core",
    }));
  });

  const navGroups = createMemo(() => {
    const acc: Record<string, { kind: string; apiVersion: string; group: string }[]> = {};
    for (const item of navItems()) {
      const group = acc[item.group] ?? [];
      group.push(item);
      acc[item.group] = group;
    }
    return Object.entries(acc);
  });

  function toggleNavGroup(group: string) {
    setCollapsedNavGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      persistCollapsedNavGroups(next);
      return next;
    });
  }

  createEffect(() => {
    const ctx = store.selectedContext();
    const kind = store.selectedKind().kind;
    const nss = store.selectedNamespaces[ctx];
    if (!ctx || !nss) return;
    if (kind === "Pod" || kind === "Node") {
      void loadMetrics(false);
    }
  });

  async function loadMetrics(manual = true) {
    const ctx = store.selectedContext();
    if (!ctx) return;
    const kind = store.selectedKind().kind;
    try {
      if (kind === "Node") {
        const m = await api.getNodeMetrics(ctx);
        setNodeMetrics(m);
        setMetrics([]);
        if (manual) showStatus(`Loaded metrics for ${m.length} nodes`);
      } else {
        const selected = store.selectedNamespaces[ctx] || ["default"];
        const fetchAll = selected.includes("*") || selected.length === 0;
        let all: PodMetrics[] = [];
        if (fetchAll) {
          all = await api.getPodMetrics(ctx, null);
        } else {
          const batches = await Promise.all(selected.map((ns) => api.getPodMetrics(ctx, ns)));
          all = batches.flat();
        }
        setMetrics(all);
        setNodeMetrics([]);
        if (manual) showStatus(`Loaded metrics for ${all.length} pods`);
      }
    } catch (e) {
      setMetrics([]);
      setNodeMetrics([]);
      if (manual) {
        showStatus("CPU/Mem metrics unavailable", true);
      } else {
        console.debug("metrics unavailable", e);
      }
    }
  }

  async function reloadCurrentList() {
    try {
      await store.refreshCurrent();
    } catch (e) {
      console.warn("list refresh failed", e);
    }
  }

  async function applyYaml() {
    try {
      await api.applyYaml(store.selectedContext(), yaml());
      showStatus("Applied successfully");
      await reloadCurrentList();
    } catch (e) {
      showStatus(String(e), true);
    }
  }

  async function runDiff() {
    try {
      const result = await api.diffResources(diffBase(), yaml());
      setDiffHunks(result.hunks);
      setPanel("diff");
    } catch (e) {
      showStatus(String(e), true);
    }
  }

  async function doAction(action: string) {
    const obj = store.selectedObject();
    if (!obj) return;
    const kind = (obj.kind as string) || store.selectedKind().kind;
    const name = objectName(obj);
    const ns = objectNamespace(obj);
    const where = ns ? ` in namespace "${ns}"` : "";

    if (action === "restart") {
      const ok = window.confirm(
        `Restart ${kind} "${name}"${where}?\n\nThis triggers a rolling restart of its pods.`,
      );
      if (!ok) return;
    } else if (action === "scale" && scaleReplicas() === 0) {
      const ok = window.confirm(
        `Scale ${kind} "${name}"${where} to 0 replicas?\n\nAll pods of this workload will be terminated.`,
      );
      if (!ok) return;
    }

    const ident = {
      context: store.selectedContext(),
      apiVersion: (obj.apiVersion as string) || store.selectedKind().apiVersion,
      kind,
      namespace: ns || null,
      name,
    };
    try {
      await api.resourceAction(action, ident, action === "scale" ? scaleReplicas() : undefined);
      showStatus(`${action} ok`);
      await reloadCurrentList();
    } catch (e) {
      showStatus(String(e), true);
    }
  }

  async function doRollback(obj?: K8sObject) {
    const target = obj || store.selectedObject();
    if (!target) return;
    const kind = (target.kind as string) || store.selectedKind().kind;
    const ns = objectNamespace(target);
    if (!ns) {
      showStatus("Rollback needs a namespace", true);
      return;
    }

    let deployName = objectName(target);
    let fromReplicaSet: string | null = null;
    let confirmMsg = "";

    if (kind === "ReplicaSet") {
      const owner = replicaSetDeploymentOwner(target);
      if (!owner) {
        showStatus("This ReplicaSet is not owned by a Deployment", true);
        return;
      }
      const rev = replicaSetRevision(target);
      deployName = owner.name;
      fromReplicaSet = objectName(target);
      confirmMsg = `Roll back Deployment "${deployName}" to revision ${rev ?? "?"} (ReplicaSet "${fromReplicaSet}") in namespace "${ns}"?`;
    } else if (kind === "Deployment") {
      confirmMsg = `Roll back Deployment "${deployName}" in namespace "${ns}" to the previous revision?`;
    } else {
      return;
    }

    if (!window.confirm(confirmMsg)) return;

    try {
      const result = await api.rollbackDeployment({
        context: store.selectedContext(),
        namespace: ns,
        name: deployName,
        fromReplicaSet,
      });
      if (result.skipped) {
        showStatus(`Deployment "${result.deployment}" already matches revision ${result.revision}`);
      } else {
        showStatus(
          `Rolled back "${result.deployment}" to revision ${result.revision} (${result.replicaset})`,
        );
      }
      await reloadCurrentList();
    } catch (e) {
      showStatus(String(e), true);
    }
  }

  function objectsByKeys(keys: string[]): K8sObject[] {
    const keySet = new Set(keys);
    return sortedObjects().filter((o) => keySet.has(objectKey(o)));
  }

  function clearChecked() {
    setCheckedKeys(new Set<string>());
    setLastClickedIndex(null);
  }

  function setChecked(next: Set<string>) {
    setCheckedKeys(next);
  }

  function toggleChecked(key: string) {
    const next = new Set(checkedKeys());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  }

  function selectRange(from: number, to: number) {
    const items = sortedObjects();
    const [a, b] = from <= to ? [from, to] : [to, from];
    const next = new Set(checkedKeys());
    for (let i = a; i <= b; i++) {
      const obj = items[i];
      if (obj) next.add(objectKey(obj));
    }
    setChecked(next);
  }

  function onRowClick(obj: K8sObject, index: number, e: MouseEvent) {
    const key = objectKey(obj);
    setCtxMenu(null);
    if (e.shiftKey && lastClickedIndex() != null) {
      selectRange(lastClickedIndex()!, index);
      setLastClickedIndex(index);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleChecked(key);
      setLastClickedIndex(index);
      store.setSelectedObjectKey(key);
      setPanel("detail");
      return;
    }
    setChecked(new Set([key]));
    setLastClickedIndex(index);
    store.setSelectedObjectKey(key);
    setPanel("detail");
  }

  function onRowContextMenu(obj: K8sObject, index: number, e: MouseEvent) {
    e.preventDefault();
    const key = objectKey(obj);
    let keys = [...checkedKeys()];
    if (!keys.includes(key)) {
      keys = [key];
      setChecked(new Set([key]));
      store.setSelectedObjectKey(key);
    }
    setLastClickedIndex(index);
    setCtxMenu({ x: e.clientX, y: e.clientY, keys });
  }

  async function deleteKeys(keys: string[]) {
    setCtxMenu(null);
    const kind = store.selectedKind().kind;
    if (!canDeleteKind(kind) || !keys.length) return;
    const objs = objectsByKeys(keys);
    if (!objs.length) return;

    const protectedNs =
      kind === "Namespace" && objs.some((o) => isProtectedNamespace(objectName(o)));

    const sample = objs
      .slice(0, 8)
      .map((o) => {
        const ns = objectNamespace(o);
        return ns ? `${ns}/${objectName(o)}` : objectName(o);
      })
      .join("\n");
    const more = objs.length > 8 ? `\n… and ${objs.length - 8} more` : "";

    const ok = window.confirm(
      `Delete ${objs.length} ${kind}${objs.length === 1 ? "" : "s"}?\n\n${sample}${more}\n\nThis cannot be undone.` +
        (protectedNs ? "\n\nWarning: selection includes a system namespace." : ""),
    );
    if (!ok) return;

    const ctx = store.selectedContext();
    const apiVersion = store.selectedKind().apiVersion;
    let okCount = 0;
    const errors: string[] = [];
    for (const obj of objs) {
      const name = objectName(obj);
      const ns = objectNamespace(obj);
      try {
        await api.resourceAction("delete", {
          context: ctx,
          apiVersion: (obj.apiVersion as string) || apiVersion,
          kind: (obj.kind as string) || kind,
          // Cluster-scoped resources (Namespace, PV, …) must omit namespace
          namespace: ns || null,
          name,
        });
        okCount += 1;
      } catch (e) {
        errors.push(`${name}: ${String(e)}`);
      }
    }

    const still = new Set(checkedKeys());
    for (const obj of objs) still.delete(objectKey(obj));
    setChecked(still);
    if (store.selectedObjectKey() && keys.includes(store.selectedObjectKey()!)) {
      store.setSelectedObjectKey(null);
    }

    if (errors.length) {
      showStatus(
        `Deleted ${okCount}/${objs.length}. ${errors.slice(0, 3).join(" · ")}`,
        true,
        10000,
      );
    } else {
      showStatus(`Deleted ${okCount} ${kind}${okCount === 1 ? "" : "s"}`);
    }
    await reloadCurrentList();
  }

  type NodeAction = "cordon" | "uncordon" | "drain";

  function selectionHasSchedulableNode(keys: string[]): boolean {
    return objectsByKeys(keys).some((o) => !isNodeUnschedulable(o));
  }

  function selectionHasCordonedNode(keys: string[]): boolean {
    return objectsByKeys(keys).some((o) => isNodeUnschedulable(o));
  }

  async function runNodeAction(action: NodeAction, keys: string[]) {
    setCtxMenu(null);
    if (!canNodeAction(store.selectedKind().kind) || !keys.length) return;
    const objs = objectsByKeys(keys);
    if (!objs.length) return;

    const targets =
      action === "cordon"
        ? objs.filter((o) => !isNodeUnschedulable(o))
        : action === "uncordon"
          ? objs.filter((o) => isNodeUnschedulable(o))
          : objs;
    if (!targets.length) {
      showStatus(
        action === "cordon"
          ? "All selected nodes are already cordoned"
          : action === "uncordon"
            ? "No selected nodes are cordoned"
            : "No nodes selected",
        true,
      );
      return;
    }

    const sample = targets
      .slice(0, 8)
      .map((o) => objectName(o))
      .join("\n");
    const more = targets.length > 8 ? `\n… and ${targets.length - 8} more` : "";

    if (action === "drain") {
      const ok = window.confirm(
        `Drain ${targets.length} node${targets.length === 1 ? "" : "s"}?\n\n${sample}${more}\n\n` +
          "Nodes will be cordoned and pods evicted (DaemonSet and mirror pods are skipped). " +
          "Pods using emptyDir will lose local data. This may take a while if PDBs block eviction.",
      );
      if (!ok) return;
    } else if (action === "cordon") {
      const ok = window.confirm(
        `Cordon ${targets.length} node${targets.length === 1 ? "" : "s"}?\n\n${sample}${more}\n\n` +
          "No new pods will be scheduled on these nodes.",
      );
      if (!ok) return;
    }

    const ctx = store.selectedContext();
    let okCount = 0;
    const errors: string[] = [];
    const verb =
      action === "cordon" ? "Cordoned" : action === "uncordon" ? "Uncordoned" : "Drained";
    const progress =
      action === "cordon" ? "Cordoning" : action === "uncordon" ? "Uncordoning" : "Draining";

    showStatus(`${progress} ${targets.length} node${targets.length === 1 ? "" : "s"}…`);

    for (const obj of targets) {
      const name = objectName(obj);
      try {
        if (action === "cordon") await api.cordonNode(ctx, name);
        else if (action === "uncordon") await api.uncordonNode(ctx, name);
        else await api.drainNode(ctx, name);
        okCount += 1;
      } catch (e) {
        errors.push(`${name}: ${String(e)}`);
      }
    }

    if (errors.length) {
      showStatus(
        `${verb} ${okCount}/${targets.length}. ${errors.slice(0, 3).join(" · ")}`,
        true,
        12000,
      );
    } else {
      showStatus(`${verb} ${okCount} node${okCount === 1 ? "" : "s"}`);
    }
    await reloadCurrentList();
  }

  function currentReplicas(obj: {
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  }): number {
    const specReplicas = obj.spec?.replicas;
    if (typeof specReplicas === "number") return specReplicas;
    const statusReplicas = obj.status?.replicas;
    if (typeof statusReplicas === "number") return statusReplicas;
    return 1;
  }

  let lastScaleKey: string | null = null;
  createEffect(() => {
    const key = store.selectedObjectKey();
    const obj = store.selectedObject();
    if (!key || !obj) {
      lastScaleKey = null;
      return;
    }
    if (!["Deployment", "StatefulSet", "ReplicaSet"].includes(store.selectedKind().kind)) {
      return;
    }
    if (key === lastScaleKey) return;
    lastScaleKey = key;
    setScaleReplicas(currentReplicas(obj));
  });

  async function startPf() {
    const obj = store.selectedObject();
    if (!obj || store.selectedKind().kind !== "Pod") {
      showStatus("Select a Pod for port-forward", true);
      return;
    }
    const ports = selectedPodPorts();
    if (!ports.length) {
      showStatus("This Pod has no container ports to forward", true);
      return;
    }
    const chosen = ports.find((p) => p.port === remotePort())?.port ?? ports[0].port;
    try {
      const info = await api.startPortForward({
        context: store.selectedContext(),
        namespace: objectNamespace(obj),
        pod: objectName(obj),
        localPort: localPort(),
        remotePort: chosen,
      });
      setPf(info);
      setPanel("portforward");
      showStatus(`Port-forward ready on localhost:${info.localPort}`);
    } catch (e) {
      showStatus(String(e), true);
    }
  }

  function statusPhase(obj: Record<string, unknown>): string {
    const deletionTimestamp = (obj.metadata as { deletionTimestamp?: string } | undefined)
      ?.deletionTimestamp;
    if (deletionTimestamp) return "Terminating";
    if (store.selectedKind().kind === "Node") {
      return nodeStatusText(obj);
    }
    if (store.selectedKind().kind === "ReplicaSet") {
      return replicaSetStatusText(obj, replicaSetCurrent());
    }
    const status = obj.status as Record<string, unknown> | undefined;
    if (!status) return "-";
    if (typeof status.phase === "string") return status.phase;
    if (typeof status.readyReplicas === "number" && typeof status.replicas === "number") {
      return `${status.readyReplicas}/${status.replicas}`;
    }
    return "-";
  }

  function statusLabelsFor(obj: Record<string, unknown>) {
    const deletionTimestamp = (obj.metadata as { deletionTimestamp?: string } | undefined)
      ?.deletionTimestamp;
    if (deletionTimestamp) {
      return [{ text: "Terminating", tone: "warn" as const }];
    }
    if (store.selectedKind().kind === "Node") {
      return nodeStatusLabels(obj);
    }
    if (store.selectedKind().kind === "ReplicaSet") {
      return replicaSetStatusLabels(obj, replicaSetCurrent());
    }
    const text = statusPhase(obj);
    if (text === "-") return [{ text: "-", tone: "muted" as const }];
    const lower = text.toLowerCase();
    let tone: "ok" | "warn" | "err" | "muted" = "muted";
    if (
      lower === "running" ||
      lower === "active" ||
      lower === "bound" ||
      lower === "succeeded" ||
      lower === "completed"
    ) {
      tone = "ok";
    } else if (lower === "pending" || lower === "unknown" || lower.includes("backoff")) {
      tone = "warn";
    } else if (
      lower === "failed" ||
      lower === "error" ||
      lower === "crashloopbackoff" ||
      lower === "imagepullbackoff"
    ) {
      tone = "err";
    }
    return [{ text, tone }];
  }

  function metricFor(obj: Record<string, unknown>): string {
    const name = objectName(obj as never);
    if (store.selectedKind().kind === "Node") {
      const m = nodeMetrics().find((x) => x.name === name);
      return m ? `${m.cpu} / ${m.memory}` : "-";
    }
    const ns = objectNamespace(obj as never);
    const m = metrics().find((x) => x.name === name && x.namespace === ns);
    return m ? `${m.cpu} / ${m.memory}` : "-";
  }

  function podsForNode(obj: Record<string, unknown>): string {
    const limit = nodePodLimit(obj);
    const used = store.nodePodCountsReady()
      ? (nodePodCounts()[objectName(obj as never)] ?? 0)
      : null;
    return formatNodePodUsage(used, limit);
  }

  function ageTimestamp(obj: Record<string, unknown>): number {
    const ts = (obj.metadata as { creationTimestamp?: string } | undefined)?.creationTimestamp;
    const n = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  function toggleSort(key: typeof sortKey extends () => infer K ? K : never) {
    if (sortKey() === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "age" ? "desc" : "asc");
    }
  }

  function sortIndicator(key: typeof sortKey extends () => infer K ? K : never) {
    if (sortKey() !== key) return "";
    return sortDir() === "asc" ? " ▲" : " ▼";
  }

  const sortedObjects = createMemo(() => {
    const items = [...objects()];
    const key = sortKey();
    const dir = sortDir() === "asc" ? 1 : -1;
    items.sort((a, b) => {
      let cmp = 0;
      switch (key) {
        case "name":
          cmp = objectName(a).localeCompare(objectName(b), undefined, {
            sensitivity: "base",
            numeric: true,
          });
          break;
        case "namespace":
          cmp = objectNamespace(a).localeCompare(objectNamespace(b), undefined, {
            sensitivity: "base",
            numeric: true,
          });
          break;
        case "status":
          if (store.selectedKind().kind === "ReplicaSet") {
            cmp =
              replicaSetStatusRank(a, replicaSetCurrent()) -
              replicaSetStatusRank(b, replicaSetCurrent());
            if (cmp === 0) {
              cmp = replicaSetStatusText(a, replicaSetCurrent()).localeCompare(
                replicaSetStatusText(b, replicaSetCurrent()),
                undefined,
                { sensitivity: "base", numeric: true },
              );
            }
          } else {
            cmp = statusPhase(a).localeCompare(statusPhase(b), undefined, {
              sensitivity: "base",
              numeric: true,
            });
          }
          break;
        case "metrics":
          cmp = metricFor(a).localeCompare(metricFor(b), undefined, {
            sensitivity: "base",
            numeric: true,
          });
          break;
        case "version":
          cmp = nodeKubeletVersion(a).localeCompare(nodeKubeletVersion(b), undefined, {
            sensitivity: "base",
            numeric: true,
          });
          break;
        case "pods": {
          const usedA = store.nodePodCountsReady() ? (nodePodCounts()[objectName(a)] ?? 0) : -1;
          const usedB = store.nodePodCountsReady() ? (nodePodCounts()[objectName(b)] ?? 0) : -1;
          cmp = usedA - usedB;
          if (cmp === 0) {
            cmp = (nodePodLimit(a) ?? -1) - (nodePodLimit(b) ?? -1);
          }
          break;
        }
        case "age":
          cmp = ageTimestamp(a) - ageTimestamp(b);
          break;
      }
      return cmp * dir;
    });
    return items;
  });

  function emptyListMessage(): string {
    const kind = store.selectedKind().kind;
    const access = store.namespaceAccess[store.selectedContext()];
    if (access?.restricted && kind === "Namespace") {
      return "This user cannot list cluster namespaces. Names you add in the sidebar appear here.";
    }
    const discovered = (store.apiResources[store.selectedContext()] || []).find(
      (r) => r.kind === kind && r.apiVersion === store.selectedKind().apiVersion,
    );
    if (discovered && !resourceIsWatchable(discovered)) {
      return `${kind} cannot be listed — this API only supports create, not list/watch.`;
    }
    if (store.error()) {
      return "Nothing to show. If this is a permissions error, pick a namespace you can access — or add it by name.";
    }
    return "No resources in the selected namespaces.";
  }

  const listColumns = createMemo(() => {
    const kind = store.selectedKind();
    const discovered = (store.apiResources[store.selectedContext()] || []).find(
      (r) => r.kind === kind.kind && r.apiVersion === kind.apiVersion,
    );
    const showNamespace = discovered ? discovered.namespaced : kindHasNamespaceColumn(kind.kind);
    const showMetrics = kindHasMetricsColumn(kind.kind);
    const showVersion = kind.kind === "Node";
    const showPods = kindHasPodsColumn(kind.kind);
    const colsClass = showVersion
      ? "cols-node"
      : !showNamespace && !showMetrics
        ? "cols-no-ns-metrics"
        : !showNamespace
          ? "cols-no-ns"
          : !showMetrics
            ? "cols-no-metrics"
            : "";
    return { showNamespace, showMetrics, showVersion, showPods, colsClass };
  });

  createEffect(() => {
    const kind = store.selectedKind().kind;
    setSortKey(kind === "ReplicaSet" ? "status" : "name");
    setSortDir("asc");
    setAggMode(false);
    clearChecked();
    setCtxMenu(null);
  });

  createEffect(() => {
    store.selectedContext();
    clearChecked();
    setCtxMenu(null);
  });

  onMount(() => {
    const close = () => setCtxMenu(null);
    const onWinResize = () => {
      const w = detailWidth();
      if (w == null || !contentEl) return;
      const next = clampDetailWidth(w, contentEl.clientWidth);
      if (next !== w) {
        setDetailWidth(next);
        persistDetailWidth(next);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", onWinResize);
    onCleanup(() => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", onWinResize);
      document.body.classList.remove("is-col-resizing");
    });
  });

  return (
    <>
      <Show
        when={!showWelcome()}
        fallback={
          <ContextPicker
            contexts={store.contexts()}
            activeContexts={store.activeContexts()}
            loading={store.loading() || !!connectingContext()}
            error={bootError() || store.error()}
            connecting={connectingContext()}
            onConnect={connectContext}
            onConnectMany={connectMany}
            onBack={() => setShowWelcome(false)}
            onRefresh={async () => {
              try {
                setBootError(null);
                await store.refreshContexts();
              } catch (e) {
                setBootError(String(e));
              }
            }}
          />
        }
      >
        <div class="app">
          <aside class="sidebar">
            <button
              class="brand brand-btn"
              onClick={() => setShowWelcome(true)}
              title="Back to clusters"
            >
              <img src={logo} class="brand-mark" alt="Kuby" />
              <div>
                <div class="brand-name">Kuby</div>
                <div class="brand-sub">Clusters</div>
              </div>
            </button>

            <div class="cluster-block">
              <label>Cluster</label>
              <select
                value={store.selectedContext()}
                onChange={(e) => void selectCluster(e.currentTarget.value)}
              >
                <For each={store.activeContexts()}>{(c) => <option value={c}>{c}</option>}</For>
              </select>
              <div class="cluster-actions">
                <button class="btn" onClick={() => setShowWelcome(true)}>
                  Add cluster
                </button>
                <button
                  class="btn ghost"
                  disabled={!store.selectedContext()}
                  onClick={() => disconnectContext(store.selectedContext())}
                >
                  Disconnect
                </button>
              </div>
              <Show when={store.activeContexts().length > 1}>
                <div class="active-clusters">
                  <For each={store.activeContexts()}>
                    {(c) => (
                      <button
                        class={`chip ${c === store.selectedContext() ? "active" : ""}`}
                        onClick={() => void selectCluster(c)}
                      >
                        {c}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={store.statuses[store.selectedContext()]}>
                {(s) => (
                  <div class={`status ${s().connected ? "ok" : "err"}`}>
                    {s().connected
                      ? `Connected · v${s().version || "?"}`
                      : s().error || "Disconnected"}
                  </div>
                )}
              </Show>
              <Show when={store.contexts().find((c) => c.name === store.selectedContext())}>
                {(c) => (
                  <div class="auth-pill" title={c().auth.detail}>
                    Auth: {c().auth.method}
                  </div>
                )}
              </Show>
            </div>

            <NamespacePicker />

            <div class="nav-toggle">
              <button class="btn ghost" onClick={() => setShowAllApis((v) => !v)}>
                {showAllApis() ? "Curated views" : "All API resources"}
              </button>
            </div>

            <nav class="nav">
              <For each={navGroups()}>
                {([group, items]) => {
                  const collapsed = () => collapsedNavGroups().has(group);
                  const hasActive = () => {
                    const sel = store.selectedKind();
                    return items.some(
                      (item) => item.kind === sel.kind && item.apiVersion === sel.apiVersion,
                    );
                  };
                  return (
                    <div class={`nav-group ${collapsed() ? "collapsed" : ""}`}>
                      <button
                        type="button"
                        class={`nav-group-title ${collapsed() && hasActive() ? "has-active" : ""}`}
                        aria-expanded={!collapsed()}
                        onClick={() => toggleNavGroup(group)}
                      >
                        <svg class="nav-group-chevron" viewBox="0 0 12 12" aria-hidden="true">
                          <path
                            d="M3 4.5 L6 8 L9 4.5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        <span class="nav-group-label">{group}</span>
                      </button>
                      <Show when={!collapsed()}>
                        <div class="nav-group-items">
                          <For each={items}>
                            {(item) => (
                              <button
                                class={`nav-item ${
                                  store.selectedKind().kind === item.kind &&
                                  store.selectedKind().apiVersion === item.apiVersion
                                    ? "active"
                                    : ""
                                }`}
                                onClick={() => {
                                  store.setSelectedKind({
                                    apiVersion: item.apiVersion,
                                    kind: item.kind,
                                  });
                                  store.setSelectedObjectKey(null);
                                  store.clearListFilters();
                                  setPendingSelectName(null);
                                  clearChecked();
                                  setCtxMenu(null);
                                }}
                              >
                                <ResourceIcon kind={item.kind} />
                                <span class="nav-item-label">{item.kind}</span>
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </nav>
          </aside>

          <main class="main">
            <header class="topbar">
              <div class="topbar-left">
                <h1 class="topbar-title">
                  <Show
                    when={store.visualizeNamespace()}
                    fallback={
                      <>
                        <ResourceIcon kind={store.selectedKind().kind} />
                        {store.selectedKind().kind}
                      </>
                    }
                  >
                    {(ns) => (
                      <>
                        <ResourceIcon kind="Namespace" />
                        Visualize · {ns()}
                      </>
                    )}
                  </Show>
                </h1>
                <Show
                  when={!store.visualizeNamespace() && store.selectedKind().kind !== "Overview"}
                >
                  <span class="muted">{objects().length} items</span>
                </Show>
                <Show when={store.statusFilter()}>
                  {(f) => (
                    <button
                      type="button"
                      class="filter-chip"
                      onClick={() => store.setStatusFilter(null)}
                      title="Clear status filter"
                    >
                      status={f()} ×
                    </button>
                  )}
                </Show>
                <Show when={relationChipLabel()}>
                  {(f) => (
                    <button
                      type="button"
                      class="filter-chip"
                      onClick={() => {
                        store.setLabelFilter(null);
                        store.setOwnerFilter(null);
                      }}
                      title="Clear relation filter"
                    >
                      {f()} ×
                    </button>
                  )}
                </Show>
              </div>
              <div class="topbar-right">
                <Show
                  when={!store.visualizeNamespace() && store.selectedKind().kind !== "Overview"}
                >
                  <input
                    class="search"
                    placeholder="Search name / labels…"
                    value={store.searchQuery()}
                    onInput={(e) => store.setSearchQuery(e.currentTarget.value)}
                  />
                  <Show when={listColumns().showMetrics}>
                    <button class="btn" onClick={() => loadMetrics(true)}>
                      Metrics
                    </button>
                  </Show>
                  <Show when={store.selectedKind().kind === "Pod"}>
                    <button
                      class={`btn ${aggMode() ? "active" : ""}`}
                      onClick={() => setAggMode((v) => !v)}
                    >
                      Aggregated logs
                    </button>
                  </Show>
                </Show>
                <ThemeToggle />
              </div>
            </header>

            <Show when={store.error()}>
              <div class="banner err">
                <span>{store.error()}</span>
                <button class="banner-close" onClick={() => store.clearError()} title="Dismiss">
                  ×
                </button>
              </div>
            </Show>

            <div
              class={`content ${
                !store.visualizeNamespace() &&
                store.selectedKind().kind !== "Overview" &&
                store.selectedObject()
                  ? "with-detail"
                  : ""
              }`}
              style={detailWidth() == null ? undefined : { "--detail-width": `${detailWidth()}px` }}
              ref={contentEl}
            >
              <Show
                when={store.visualizeNamespace()}
                fallback={
                  <Show
                    when={store.selectedKind().kind === "Overview"}
                    fallback={
                      <div class="resource-layout">
                        <section class="list-pane">
                          <Show when={checkedKeys().size > 0}>
                            <div class="selection-bar">
                              <span>{checkedKeys().size} selected</span>
                              <div class="selection-bar-actions">
                                <Show when={canDeleteKind(store.selectedKind().kind)}>
                                  <button
                                    class="btn danger"
                                    onClick={() => void deleteKeys([...checkedKeys()])}
                                  >
                                    Delete
                                  </button>
                                </Show>
                                <Show when={canNodeAction(store.selectedKind().kind)}>
                                  <Show when={selectionHasSchedulableNode([...checkedKeys()])}>
                                    <button
                                      class="btn"
                                      onClick={() =>
                                        void runNodeAction("cordon", [...checkedKeys()])
                                      }
                                    >
                                      Cordon
                                    </button>
                                  </Show>
                                  <Show when={selectionHasCordonedNode([...checkedKeys()])}>
                                    <button
                                      class="btn"
                                      onClick={() =>
                                        void runNodeAction("uncordon", [...checkedKeys()])
                                      }
                                    >
                                      Uncordon
                                    </button>
                                  </Show>
                                  <button
                                    class="btn"
                                    onClick={() => void runNodeAction("drain", [...checkedKeys()])}
                                  >
                                    Drain
                                  </button>
                                </Show>
                                <button class="btn ghost" onClick={() => clearChecked()}>
                                  Clear
                                </button>
                              </div>
                            </div>
                          </Show>
                          <VirtualList
                            items={sortedObjects()}
                            itemHeight={36}
                            class="resource-list"
                            header={
                              <div class={`row head ${listColumns().colsClass}`}>
                                <label class="row-check" title="Select all">
                                  <input
                                    type="checkbox"
                                    checked={
                                      sortedObjects().length > 0 &&
                                      sortedObjects().every((o) => checkedKeys().has(objectKey(o)))
                                    }
                                    onChange={(e) => {
                                      if (e.currentTarget.checked) {
                                        setChecked(
                                          new Set(sortedObjects().map((o) => objectKey(o))),
                                        );
                                      } else {
                                        clearChecked();
                                      }
                                    }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  class={`sort-btn ${sortKey() === "name" ? "active" : ""}`}
                                  onClick={() => toggleSort("name")}
                                >
                                  Name{sortIndicator("name")}
                                </button>
                                <Show when={listColumns().showNamespace}>
                                  <button
                                    type="button"
                                    class={`sort-btn ${sortKey() === "namespace" ? "active" : ""}`}
                                    onClick={() => toggleSort("namespace")}
                                  >
                                    Namespace{sortIndicator("namespace")}
                                  </button>
                                </Show>
                                <Show when={listColumns().showVersion}>
                                  <button
                                    type="button"
                                    class={`sort-btn ${sortKey() === "version" ? "active" : ""}`}
                                    onClick={() => toggleSort("version")}
                                  >
                                    Version{sortIndicator("version")}
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class={`sort-btn ${sortKey() === "status" ? "active" : ""}`}
                                  onClick={() => toggleSort("status")}
                                >
                                  Status{sortIndicator("status")}
                                </button>
                                <Show when={listColumns().showPods}>
                                  <button
                                    type="button"
                                    class={`sort-btn ${sortKey() === "pods" ? "active" : ""}`}
                                    onClick={() => toggleSort("pods")}
                                  >
                                    Pods{sortIndicator("pods")}
                                  </button>
                                </Show>
                                <Show when={listColumns().showMetrics}>
                                  <button
                                    type="button"
                                    class={`sort-btn ${sortKey() === "metrics" ? "active" : ""}`}
                                    onClick={() => toggleSort("metrics")}
                                  >
                                    CPU / Mem{sortIndicator("metrics")}
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class={`sort-btn ${sortKey() === "age" ? "active" : ""}`}
                                  onClick={() => toggleSort("age")}
                                >
                                  Age{sortIndicator("age")}
                                </button>
                              </div>
                            }
                            renderItem={(obj, index) => {
                              const key = objectKey(obj);
                              const name = objectName(obj);
                              const ns = objectNamespace(obj) || "—";
                              const labels = statusLabelsFor(obj);
                              const phaseTitle = labels.map((l) => l.text).join(", ");
                              return (
                                <div
                                  class={`row ${listColumns().colsClass} ${store.selectedObjectKey() === key ? "selected" : ""} ${
                                    checkedKeys().has(key) ? "checked" : ""
                                  }`}
                                  onClick={(e) => onRowClick(obj, index, e)}
                                  onContextMenu={(e) => onRowContextMenu(obj, index, e)}
                                  role="button"
                                  tabIndex={0}
                                >
                                  <label
                                    class="row-check"
                                    onClick={(e) => e.stopPropagation()}
                                    onDblClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checkedKeys().has(key)}
                                      onChange={() => {
                                        toggleChecked(key);
                                        setLastClickedIndex(index);
                                      }}
                                    />
                                  </label>
                                  <span class="mono name-with-action" title={name}>
                                    <span class="name-text">{name}</span>
                                    <Show when={store.selectedKind().kind === "Namespace"}>
                                      <button
                                        type="button"
                                        class="btn ghost row-visualize"
                                        title={`Visualize ${name}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void openVisualize(name);
                                        }}
                                      >
                                        Visualize
                                      </button>
                                    </Show>
                                  </span>
                                  <Show when={listColumns().showNamespace}>
                                    <span title={ns}>{ns}</span>
                                  </Show>
                                  <Show when={listColumns().showVersion}>
                                    <span class="status-labels">
                                      <Show
                                        when={nodeKubeletVersion(obj)}
                                        fallback={<span class="muted">—</span>}
                                      >
                                        {(v) => <span class="status-label muted">{v()}</span>}
                                      </Show>
                                    </span>
                                  </Show>
                                  <span class="status-labels" title={phaseTitle}>
                                    <For each={labels}>
                                      {(label) => (
                                        <span class={`status-label ${label.tone}`}>
                                          {label.text}
                                        </span>
                                      )}
                                    </For>
                                  </span>
                                  <Show when={listColumns().showPods}>
                                    <span
                                      class="muted"
                                      title="Running pods / allocatable pod limit"
                                    >
                                      {podsForNode(obj)}
                                    </span>
                                  </Show>
                                  <Show when={listColumns().showMetrics}>
                                    <span class="muted">{metricFor(obj)}</span>
                                  </Show>
                                  <span class="muted">
                                    {ageFromTimestamp(obj.metadata?.creationTimestamp as string)}
                                  </span>
                                </div>
                              );
                            }}
                          />
                          <Show when={!sortedObjects().length}>
                            <div class="empty">{emptyListMessage()}</div>
                          </Show>
                        </section>

                        <Show when={store.selectedObjectKey()}>
                          <Show when={store.selectedObject()}>
                            {(obj) => (
                              <>
                                <div
                                  class="pane-splitter"
                                  role="separator"
                                  aria-orientation="vertical"
                                  aria-label="Resize detail panel"
                                  title="Drag to resize"
                                  tabIndex={0}
                                  onPointerDown={onSplitterPointerDown}
                                  onPointerMove={onSplitterPointerMove}
                                  onPointerUp={onSplitterPointerUp}
                                  onPointerCancel={endDetailResize}
                                  onLostPointerCapture={endDetailResize}
                                  onDblClick={onSplitterDblClick}
                                  onKeyDown={onSplitterKeyDown}
                                />
                                <section class="detail-pane" ref={detailPaneEl}>
                                  <div class="detail-tabs">
                                    <For each={detailTabs()}>
                                      {(tab) => (
                                        <button
                                          class={`tab ${panel() === tab ? "active" : ""}`}
                                          onClick={() => setPanel(tab)}
                                        >
                                          {tab}
                                        </button>
                                      )}
                                    </For>
                                  </div>

                                  <div class="detail-actions">
                                    <Show when={canScaleKind(store.selectedKind().kind)}>
                                      <input
                                        type="number"
                                        min="0"
                                        class="scale-input"
                                        value={scaleReplicas()}
                                        onInput={(e) =>
                                          setScaleReplicas(Number(e.currentTarget.value))
                                        }
                                      />
                                      <button class="btn" onClick={() => doAction("scale")}>
                                        Scale
                                      </button>
                                    </Show>
                                    <Show when={canRestartKind(store.selectedKind().kind)}>
                                      <button class="btn" onClick={() => doAction("restart")}>
                                        Restart
                                      </button>
                                    </Show>
                                    <Show when={canRollbackDeployment(store.selectedKind().kind)}>
                                      <button class="btn" onClick={() => void doRollback()}>
                                        Rollback
                                      </button>
                                    </Show>
                                    <Show
                                      when={
                                        store.selectedKind().kind === "ReplicaSet" &&
                                        canRollbackReplicaSet(obj(), replicaSetCurrent())
                                      }
                                    >
                                      <button
                                        class="btn"
                                        title="Roll the parent Deployment back to this ReplicaSet revision"
                                        onClick={() => void doRollback(obj())}
                                      >
                                        Rollback to this revision
                                      </button>
                                    </Show>
                                    <Show when={canNodeAction(store.selectedKind().kind)}>
                                      <Show when={!isNodeUnschedulable(obj())}>
                                        <button
                                          class="btn"
                                          onClick={() =>
                                            void runNodeAction("cordon", [objectKey(obj())])
                                          }
                                        >
                                          Cordon
                                        </button>
                                      </Show>
                                      <Show when={isNodeUnschedulable(obj())}>
                                        <button
                                          class="btn"
                                          onClick={() =>
                                            void runNodeAction("uncordon", [objectKey(obj())])
                                          }
                                        >
                                          Uncordon
                                        </button>
                                      </Show>
                                      <button
                                        class="btn"
                                        onClick={() =>
                                          void runNodeAction("drain", [objectKey(obj())])
                                        }
                                      >
                                        Drain
                                      </button>
                                    </Show>
                                    <Show when={selectedPodPorts().length > 0}>
                                      <button class="btn" onClick={() => startPf()}>
                                        Port-forward
                                      </button>
                                    </Show>
                                  </div>

                                  <Show when={panel() === "detail"}>
                                    <div class="detail-body">
                                      <h2>{objectName(obj())}</h2>
                                      <Show
                                        when={
                                          groupRelations(
                                            extractRelations(obj(), store.selectedKind().kind),
                                          ).length
                                        }
                                      >
                                        <section class="relations">
                                          <h3>Related</h3>
                                          <For
                                            each={groupRelations(
                                              extractRelations(obj(), store.selectedKind().kind),
                                            )}
                                          >
                                            {(group) => (
                                              <div class="relation-group">
                                                <div class="relation-group-title">
                                                  {group.group}
                                                </div>
                                                <div class="relation-links">
                                                  <For each={group.links}>
                                                    {(link) => (
                                                      <button
                                                        type="button"
                                                        class="relation-link"
                                                        title={[
                                                          link.kind,
                                                          link.name,
                                                          link.labelSelector &&
                                                            Object.entries(link.labelSelector)
                                                              .map(([k, v]) => `${k}=${v}`)
                                                              .join(","),
                                                          link.owner &&
                                                            `owner ${link.owner.kind}/${link.owner.name}`,
                                                        ]
                                                          .filter(Boolean)
                                                          .join(" · ")}
                                                        onClick={() => openRelation(link)}
                                                      >
                                                        {link.title}
                                                      </button>
                                                    )}
                                                  </For>
                                                </div>
                                              </div>
                                            )}
                                          </For>
                                        </section>
                                      </Show>
                                      <dl class="kv">
                                        <dt>Kind</dt>
                                        <dd>{String(obj().kind || store.selectedKind().kind)}</dd>
                                        <Show when={listColumns().showNamespace}>
                                          <dt>Namespace</dt>
                                          <dd>{objectNamespace(obj()) || "—"}</dd>
                                        </Show>
                                        <dt>UID</dt>
                                        <dd class="mono">{objectKey(obj())}</dd>
                                        <dt>Labels</dt>
                                        <dd>
                                          <Show
                                            when={Object.keys(obj().metadata?.labels || {}).length}
                                            fallback={<span class="muted">—</span>}
                                          >
                                            <table class="meta-table">
                                              <thead>
                                                <tr>
                                                  <th>Key</th>
                                                  <th>Value</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                <For
                                                  each={Object.entries(
                                                    obj().metadata?.labels || {},
                                                  )}
                                                >
                                                  {([key, value]) => (
                                                    <tr>
                                                      <td class="mono">{key}</td>
                                                      <td class="mono">{String(value)}</td>
                                                    </tr>
                                                  )}
                                                </For>
                                              </tbody>
                                            </table>
                                          </Show>
                                        </dd>
                                        <dt>Status</dt>
                                        <dd class="kv-json">
                                          <CodeEditor
                                            language="json"
                                            readOnly
                                            compact
                                            value={JSON.stringify(obj().status || {}, null, 2)}
                                          />
                                        </dd>
                                      </dl>
                                    </div>
                                  </Show>

                                  <Show when={panel() === "yaml"}>
                                    <div class="yaml-wrap">
                                      <div class="yaml-toolbar">
                                        <button class="btn" onClick={() => applyYaml()}>
                                          Apply
                                        </button>
                                        <button class="btn ghost" onClick={() => runDiff()}>
                                          Diff vs loaded
                                        </button>
                                      </div>
                                      <CodeEditor
                                        language="yaml"
                                        value={yaml()}
                                        onChange={setYaml}
                                      />
                                    </div>
                                  </Show>

                                  <Show when={panel() === "logs"}>
                                    <LogViewer
                                      context={store.selectedContext()}
                                      namespace={objectNamespace(obj())}
                                      pod={
                                        store.selectedKind().kind === "Pod" ? objectName(obj()) : ""
                                      }
                                      containers={
                                        store.selectedKind().kind === "Pod"
                                          ? podContainerNames(obj())
                                          : []
                                      }
                                      aggregated={aggMode()}
                                      pods={
                                        aggMode()
                                          ? objects()
                                              .filter(() => store.selectedKind().kind === "Pod")
                                              .slice(0, 20)
                                              .map((p) => ({
                                                context: store.selectedContext(),
                                                namespace: objectNamespace(p),
                                                pod: objectName(p),
                                              }))
                                          : []
                                      }
                                    />
                                  </Show>

                                  <Show when={panel() === "exec"}>
                                    <ExecTerminal
                                      context={store.selectedContext()}
                                      namespace={objectNamespace(obj())}
                                      pod={objectName(obj())}
                                      containers={podContainerNames(obj())}
                                    />
                                  </Show>

                                  <Show when={panel() === "diff"}>
                                    <div class="diff-view">
                                      <For each={diffHunks()}>
                                        {(h) => <div class={`diff-line ${h.tag}`}>{h.value}</div>}
                                      </For>
                                    </div>
                                  </Show>

                                  <Show when={panel() === "portforward"}>
                                    <div class="pf-panel">
                                      <div class="pf-form">
                                        <label>
                                          Local
                                          <input
                                            type="number"
                                            value={localPort()}
                                            onInput={(e) =>
                                              setLocalPort(Number(e.currentTarget.value))
                                            }
                                          />
                                        </label>
                                        <label>
                                          Remote
                                          <select
                                            value={String(remotePort())}
                                            onChange={(e) =>
                                              setRemotePort(Number(e.currentTarget.value))
                                            }
                                          >
                                            <For each={selectedPodPorts()}>
                                              {(p) => (
                                                <option value={String(p.port)}>
                                                  {formatPodPort(p)}
                                                </option>
                                              )}
                                            </For>
                                          </select>
                                        </label>
                                        <button class="btn" onClick={() => startPf()}>
                                          Start
                                        </button>
                                        <Show when={pf()}>
                                          {(info) => (
                                            <button
                                              class="btn danger"
                                              onClick={async () => {
                                                await api.stopPortForward(
                                                  info().context,
                                                  info().id,
                                                );
                                                setPf(null);
                                              }}
                                            >
                                              Stop :{info().localPort}
                                            </button>
                                          )}
                                        </Show>
                                      </div>
                                      <Show when={pf()}>
                                        {(info) => (
                                          <p>
                                            Forwarding{" "}
                                            <code>
                                              localhost:{info().localPort} → {info().pod}:
                                              {info().remotePort}
                                            </code>
                                          </p>
                                        )}
                                      </Show>
                                    </div>
                                  </Show>
                                </section>
                              </>
                            )}
                          </Show>
                        </Show>
                      </div>
                    }
                  >
                    <OverviewView
                      context={store.selectedContext()}
                      namespaces={store.selectedNamespaces[store.selectedContext()] || ["default"]}
                      onOpenResource={(target) => {
                        const apiVersion = resolveResourceApiVersion(
                          target.kind,
                          target.apiVersion,
                          store.apiResources[store.selectedContext()] || [],
                        );
                        if (!apiVersion || !target.kind || !target.name) return;
                        store.clearListFilters();
                        store.setSelectedObjectKey(null);
                        store.setSelectedKind({
                          apiVersion,
                          kind: target.kind,
                        });
                        if (target.namespace) {
                          store.setSelectedNamespaces(store.selectedContext(), [target.namespace]);
                        }
                        store.setSearchQuery(target.name);
                        setPendingSelectName(target.name);
                        setPanel("detail");
                      }}
                      onOpenSegment={(cardKind, statusLabel) => {
                        const target = overviewKindToResource(cardKind);
                        if (!target) return;
                        store.setSelectedKind(target);
                        store.setSelectedObjectKey(null);
                        store.clearListFilters();
                        store.setStatusFilter(statusLabel || null);
                      }}
                    />
                  </Show>
                }
              >
                {(ns) => (
                  <NamespaceGraphView
                    namespace={ns()}
                    objects={store.graphObjects()}
                    loading={store.graphLoading()}
                    onBack={() => void closeVisualize()}
                    onOpenResource={(target) => {
                      void (async () => {
                        await closeVisualize();
                        const apiVersion = resolveResourceApiVersion(
                          target.kind,
                          target.apiVersion,
                          store.apiResources[store.selectedContext()] || [],
                        );
                        if (!apiVersion || !target.kind || !target.name) return;
                        store.clearListFilters();
                        store.setSelectedObjectKey(null);
                        store.setSelectedKind({
                          apiVersion,
                          kind: target.kind,
                        });
                        if (target.namespace) {
                          store.setSelectedNamespaces(store.selectedContext(), [target.namespace]);
                        }
                        store.setSearchQuery(target.name);
                        setPendingSelectName(target.name);
                        setPanel("detail");
                      })();
                    }}
                  />
                )}
              </Show>
            </div>
          </main>

          <Show when={ctxMenu()}>
            {(menu) => (
              <div
                class="ctx-menu"
                style={{
                  left: `${menu().x}px`,
                  top: `${menu().y}px`,
                }}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div class="ctx-menu-label">{menu().keys.length} selected</div>
                <Show when={store.selectedKind().kind === "Namespace" && menu().keys.length === 1}>
                  <button
                    class="ctx-item"
                    onClick={() => {
                      const key = menu().keys[0];
                      const obj = objects().find((o) => objectKey(o) === key);
                      const name = obj ? objectName(obj) : "";
                      if (name) void openVisualize(name);
                      else setCtxMenu(null);
                    }}
                  >
                    Visualize
                  </button>
                </Show>
                <Show when={canNodeAction(store.selectedKind().kind)}>
                  <Show when={selectionHasSchedulableNode(menu().keys)}>
                    <button
                      class="ctx-item"
                      onClick={() => void runNodeAction("cordon", menu().keys)}
                    >
                      Cordon
                    </button>
                  </Show>
                  <Show when={selectionHasCordonedNode(menu().keys)}>
                    <button
                      class="ctx-item"
                      onClick={() => void runNodeAction("uncordon", menu().keys)}
                    >
                      Uncordon
                    </button>
                  </Show>
                  <button class="ctx-item" onClick={() => void runNodeAction("drain", menu().keys)}>
                    Drain
                  </button>
                </Show>
                <Show when={canDeleteKind(store.selectedKind().kind)}>
                  <button class="ctx-item danger" onClick={() => void deleteKeys(menu().keys)}>
                    Delete
                  </button>
                </Show>
                <Show when={menu().keys.length === 1 && canScaleKind(store.selectedKind().kind)}>
                  <button
                    class="ctx-item"
                    onClick={() => {
                      const key = menu().keys[0];
                      store.setSelectedObjectKey(key);
                      setPanel("detail");
                      setCtxMenu(null);
                    }}
                  >
                    Open to scale…
                  </button>
                </Show>
                <Show
                  when={
                    menu().keys.length === 1 && canRollbackDeployment(store.selectedKind().kind)
                  }
                >
                  <button
                    class="ctx-item"
                    onClick={() => {
                      const key = menu().keys[0];
                      const selected = objects().find((o) => objectKey(o) === key);
                      setCtxMenu(null);
                      if (selected) void doRollback(selected);
                    }}
                  >
                    Rollback to previous revision
                  </button>
                </Show>
                <Show
                  when={
                    menu().keys.length === 1 &&
                    store.selectedKind().kind === "ReplicaSet" &&
                    (() => {
                      const key = menu().keys[0];
                      const selected = objects().find((o) => objectKey(o) === key);
                      return selected
                        ? canRollbackReplicaSet(selected, replicaSetCurrent())
                        : false;
                    })()
                  }
                >
                  <button
                    class="ctx-item"
                    onClick={() => {
                      const key = menu().keys[0];
                      const selected = objects().find((o) => objectKey(o) === key);
                      setCtxMenu(null);
                      if (selected) void doRollback(selected);
                    }}
                  >
                    Rollback to this revision
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={statusMsg()}>
        <div class={`banner status-toast ${statusIsError() ? "err" : ""}`}>
          <span>{statusMsg()}</span>
          <button class="banner-close" onClick={() => dismissStatus()} title="Dismiss">
            ×
          </button>
        </div>
      </Show>
      <AboutDialog open={showAbout()} onClose={() => setShowAbout(false)} />
      <TelemetryDialog
        open={telemetryStore.consent() === null}
        onAllow={() => telemetryStore.setConsent(true)}
        onDecline={() => telemetryStore.setConsent(false)}
      />
    </>
  );
}

export default App;
