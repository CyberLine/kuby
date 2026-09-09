import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../api/tauri";
import {
  GRAPH_KINDS,
  GRAPH_KINDS_WAVE1,
  GRAPH_KINDS_WAVE2,
  type GraphKindSpec,
  kindIsClusterScoped,
  objectKey,
  resourceIsWatchable,
} from "../constants/resources";
import type {
  ClusterStatus,
  ContextInfo,
  DiscoveredResource,
  K8sObject,
  NamespaceAccess,
  NamespaceListResult,
  WatchErrorPayload,
  WatchEventPayload,
} from "../types";
import {
  isValidNamespaceName,
  loadExtraNamespaces,
  saveExtraNamespaces,
} from "../utils/namespaceName";
import { countedPodNodeName, nodeStatusText } from "../utils/nodeStatus";
import { matchesLabelSelector, matchesOwnerFilter } from "../utils/relations";

export type ResourceBucket = {
  byUid: Record<string, K8sObject>;
  order: string[];
};

function formatWatchError(payload: WatchErrorPayload): string {
  const err = payload.error || "unknown error";
  const forbidden = /forbidden|\b403\b/i.test(err);
  const methodNotAllowed =
    /methodnotallowed|\b405\b|does not allow this method/i.test(err) ||
    /cannot be listed or watched/i.test(err);
  const ns = payload.namespace && payload.namespace !== "*" ? payload.namespace : null;
  if (methodNotAllowed) {
    return `${payload.kind} cannot be listed or watched. Kubernetes only allows creating this resource (e.g. TokenReview).`;
  }
  if (forbidden) {
    return ns
      ? `No permission to watch ${payload.kind} in namespace "${ns}".`
      : `No permission to watch ${payload.kind} cluster-wide. Pick a namespace you can access.`;
  }
  const where = ns ? ` in ${ns}` : "";
  return `Watch ${payload.kind}${where} failed: ${err}`;
}

/** Match overview segment labels to live objects (mirrors Rust overview cards). */
function matchesStatusFilter(obj: K8sObject, kind: string, label: string): boolean {
  const status = (obj.status || {}) as Record<string, unknown>;
  const spec = (obj.spec || {}) as Record<string, unknown>;

  if (kind === "Pod") {
    const phase = typeof status.phase === "string" ? status.phase : "Unknown";
    const containerStatuses = (status.containerStatuses || []) as Record<string, unknown>[];
    let waiting: string | undefined;
    for (const cs of containerStatuses) {
      const st = cs.state as Record<string, unknown> | undefined;
      if (!st) continue;
      const w = st.waiting as { reason?: string } | undefined;
      const t = st.terminated as { reason?: string } | undefined;
      if (w?.reason) {
        waiting = w.reason;
        break;
      }
      if (t?.reason) {
        waiting = t.reason;
        break;
      }
    }
    let derived = phase;
    if (waiting === "ImagePullBackOff" || waiting === "ErrImagePull") {
      derived = "ImagePullBackOff";
    } else if (waiting === "CrashLoopBackOff") {
      derived = "CrashLoopBackOff";
    } else if (waiting === "CreateContainerConfigError") {
      derived = "ConfigError";
    } else if (waiting === "Error") {
      derived = "Error";
    } else if (phase === "Succeeded") {
      derived = "Completed";
    } else if (phase === "Failed") {
      derived = "Failed";
    } else if (phase === "Pending") {
      derived = "Pending";
    } else if (phase === "Running") {
      derived = "Running";
    }
    return derived === label;
  }

  if (kind === "ReplicaSet") {
    const desired = typeof spec.replicas === "number" ? spec.replicas : 0;
    const available =
      typeof status.readyReplicas === "number"
        ? status.readyReplicas
        : typeof status.availableReplicas === "number"
          ? status.availableReplicas
          : 0;
    const refs = (obj.metadata as { ownerReferences?: { kind?: string }[] } | undefined)
      ?.ownerReferences;
    const owned = Array.isArray(refs) && refs.some((r) => r.kind === "Deployment");
    if (desired === 0) return label === (owned ? "Old" : "Idle");
    if (available >= desired) return label === "Running";
    return label === "Unavailable";
  }

  if (kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet") {
    const desired =
      typeof spec.replicas === "number"
        ? spec.replicas
        : kind === "DaemonSet"
          ? Number(status.desiredNumberScheduled || 0)
          : 0;
    const available =
      typeof status.availableReplicas === "number"
        ? status.availableReplicas
        : typeof status.readyReplicas === "number"
          ? status.readyReplicas
          : typeof status.numberReady === "number"
            ? status.numberReady
            : 0;
    if (desired === 0) return label === "Idle";
    if (available >= desired) return label === "Running";
    return label === "Unavailable";
  }

  if (kind === "CronJob") {
    const suspended = Boolean(spec.suspend);
    return suspended ? label === "Suspended" : label === "Scheduled";
  }

  if (kind === "ResourceQuota") {
    // Overview uses Ok / Warning based on usage ratio; approximate via hard/used presence.
    const hard = status.hard as Record<string, string> | undefined;
    const used = status.used as Record<string, string> | undefined;
    if (!hard || !used) return label === "Ok";
    // Without quantity parsing, treat equal keys with any used as Ok unless filter is Warning
    // (full fidelity stays on overview). Soft match: pass Warning filter as non-Ok heuristically skipped.
    return label === "Ok" || label === "Warning";
  }

  if (kind === "PodDisruptionBudget") {
    const allowed = Number(status.disruptionsAllowed ?? 0);
    if (allowed > 0) return label === "DisruptionAllowed";
    return label === "Blocked";
  }

  if (kind === "Node") {
    const text = nodeStatusText(obj as unknown as Record<string, unknown>);
    return text.split(/\s+/).includes(label);
  }

  // Fallback: phase or ready/replicas string contains label
  if (typeof status.phase === "string") {
    return status.phase === label;
  }
  return true;
}

function createClusterStore() {
  const [contexts, setContexts] = createSignal<ContextInfo[]>([]);
  const [activeContexts, setActiveContexts] = createSignal<string[]>([]);
  const [selectedContext, setSelectedContext] = createSignal<string>("");
  const [statuses, setStatuses] = createStore<Record<string, ClusterStatus>>({});
  const [namespaces, setNamespaces] = createStore<Record<string, string[]>>({});
  const [selectedNamespaces, setSelectedNamespaces] = createStore<Record<string, string[]>>({});
  const [namespaceAccess, setNamespaceAccess] = createStore<Record<string, NamespaceAccess>>({});
  const [extraNamespaces, setExtraNamespaces] = createStore<Record<string, string[]>>({});
  const [apiResources, setApiResources] = createStore<Record<string, DiscoveredResource[]>>({});
  const [resources, setResources] = createStore<Record<string, ResourceBucket>>({});
  const [watchKeys, setWatchKeys] = createStore<Record<string, string>>({});
  const [searchQueries, setSearchQueries] = createStore<Record<string, string>>({});
  const [selectedKind, setSelectedKind] = createSignal<{
    apiVersion: string;
    kind: string;
  }>({ apiVersion: "kuby.io/overview", kind: "Overview" });
  const [selectedObjectKey, setSelectedObjectKey] = createSignal<string | null>(null);
  const [statusFilter, setStatusFilter] = createSignal<string | null>(null);
  const [labelFilter, setLabelFilter] = createSignal<Record<string, string> | null>(null);
  const [ownerFilter, setOwnerFilter] = createSignal<{
    kind: string;
    name: string;
    uid?: string;
  } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [listLoading, setListLoading] = createSignal(false);
  const [namespacesLoading, setNamespacesLoading] = createSignal(false);
  const [visualizeNamespace, setVisualizeNamespace] = createSignal<string | null>(null);
  const [graphWatchKeys, setGraphWatchKeys] = createStore<Record<string, string>>({});
  const [graphLoading, setGraphLoading] = createSignal(false);
  const [nodePodSidecarKeys, setNodePodSidecarKeys] = createStore<Record<string, string>>({});

  let watchUnlisten: UnlistenFn | null = null;
  let watchErrorUnlisten: UnlistenFn | null = null;
  let lastWatchErrorKey = "";
  let graphWatchGeneration = 0;
  let listWatchGeneration = 0;
  let listRefreshGeneration = 0;
  let pendingListBuckets = new Set<string>();

  function markListBucketReady(key: string) {
    if (!pendingListBuckets.has(key)) return;
    pendingListBuckets.delete(key);
    if (pendingListBuckets.size === 0) setListLoading(false);
  }

  function finishListLoading(generation: number) {
    if (generation !== listWatchGeneration) return;
    pendingListBuckets.clear();
    setListLoading(false);
  }

  function isClusterScopedKind(ctx: string, kind: string, apiVersion: string): boolean {
    const discovered = (apiResources[ctx] || []).find(
      (r) => r.kind === kind && r.apiVersion === apiVersion,
    );
    if (discovered && typeof discovered.namespaced === "boolean") {
      return !discovered.namespaced;
    }
    return kindIsClusterScoped(kind);
  }

  function namespacesToWatch(ctx: string, kind: string, apiVersion: string): string[] {
    if (isClusterScopedKind(ctx, kind, apiVersion)) return ["*"];
    return selectedNamespaces[ctx] || ["default"];
  }

  async function ensureWatchListener() {
    if (!watchUnlisten) {
      watchUnlisten = await listen<WatchEventPayload>("k8s://watch", (ev) => {
        applyWatchEvent(ev.payload);
      });
    }
    if (!watchErrorUnlisten) {
      watchErrorUnlisten = await listen<WatchErrorPayload>("k8s://watch-error", (ev) => {
        const payload = ev.payload;
        if (visualizeNamespace()) return;
        const ctx = selectedContext();
        const sel = selectedKind();
        if (
          !ctx ||
          payload.context !== ctx ||
          payload.kind !== sel.kind ||
          payload.apiVersion !== sel.apiVersion
        ) {
          return;
        }
        const nss = selectedNamespaces[ctx] || [];
        const ns = payload.namespace || "*";
        const clusterScoped = isClusterScopedKind(ctx, payload.kind, payload.apiVersion);
        if (!clusterScoped && nss.length && !nss.includes("*") && ns !== "*" && !nss.includes(ns)) {
          return;
        }
        const key = `${payload.context}|${payload.kind}|${ns}`;
        if (key === lastWatchErrorKey) return;
        lastWatchErrorKey = key;
        setError(formatWatchError(payload));
        markListBucketReady(
          bucketKey(payload.context, payload.apiVersion, payload.kind, payload.namespace),
        );
      });
    }
  }

  function bucketKey(context: string, apiVersion: string, kind: string, namespace?: string | null) {
    return `${context}|${apiVersion}|${kind}|${namespace || "*"}`;
  }

  function ingestListed(
    key: string,
    listed: Record<string, unknown>[],
    kind: string,
    apiVersion: string,
  ) {
    setResources(
      produce((draft) => {
        draft[key] = { byUid: {}, order: [] };
        const bucket = draft[key];
        for (const raw of listed) {
          const obj: K8sObject = {
            ...(raw as K8sObject),
            kind: (raw as K8sObject).kind || kind,
            apiVersion: (raw as K8sObject).apiVersion || apiVersion,
          };
          const uid = objectKey(obj);
          bucket.byUid[uid] = obj;
          bucket.order.push(uid);
        }
      }),
    );
  }

  function applyWatchEvent(payload: WatchEventPayload) {
    const key = bucketKey(payload.context, payload.apiVersion, payload.kind, payload.namespace);
    setResources(
      produce((draft) => {
        if (!draft[key]) draft[key] = { byUid: {}, order: [] };
        const bucket = draft[key];
        if (payload.event === "restarted" && payload.objects) {
          bucket.byUid = {};
          bucket.order = [];
          for (const obj of payload.objects) {
            const uid = objectKey(obj);
            bucket.byUid[uid] = obj;
            bucket.order.push(uid);
          }
        } else if (payload.event === "applied" && payload.object) {
          const uid = objectKey(payload.object);
          if (!bucket.byUid[uid]) bucket.order.push(uid);
          bucket.byUid[uid] = payload.object;
        } else if (payload.event === "deleted" && payload.object) {
          const uid = objectKey(payload.object);
          delete bucket.byUid[uid];
          bucket.order = bucket.order.filter((id) => id !== uid);
        }
      }),
    );
    if (payload.event === "restarted") {
      markListBucketReady(key);
    }
  }

  async function refreshContexts() {
    const list = await api.listContexts();
    setContexts(list);
  }

  async function connect(context: string) {
    setLoading(true);
    setError(null);
    try {
      await ensureWatchListener();
      const status = await api.connectCluster(context);
      setStatuses(context, status);
      if (!status.connected && status.error) {
        setError(status.error);
      }
      const active = await api.listActiveClusters();
      setActiveContexts(active);
      setSelectedContext(context);
      setNamespacesLoading(true);
      try {
        applyNamespaceResult(context, await api.listNamespaces(context));
      } catch (nsErr) {
        console.error("listNamespaces failed", nsErr);
        setError(`Namespaces: ${String(nsErr)}`);
        applyNamespaceResult(context, {
          namespaces: [],
          restricted: true,
          defaultNamespace: "default",
        });
      } finally {
        setNamespacesLoading(false);
      }
      const apis = await api.listApiResources(context, true);
      setApiResources(context, apis);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshNamespaces(context?: string) {
    const ctx = context || selectedContext();
    if (!ctx) return;
    setNamespacesLoading(true);
    try {
      applyNamespaceResult(ctx, await api.listNamespaces(ctx));
    } catch (e) {
      setError(`Namespaces: ${String(e)}`);
    } finally {
      setNamespacesLoading(false);
    }
  }

  function uniqueSorted(names: string[]): string[] {
    return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function applyNamespaceResult(context: string, result: NamespaceListResult) {
    const extras = loadExtraNamespaces(context);
    setExtraNamespaces(context, extras);
    setNamespaces(context, uniqueSorted([...result.namespaces, ...extras]));
    setNamespaceAccess(context, {
      restricted: result.restricted,
      defaultNamespace: result.defaultNamespace || "default",
    });
    selectNamespaces(context, selectedNamespaces[context] || []);
  }

  function selectNamespaces(context: string, opts: string[]) {
    const access = namespaceAccess[context];
    let next = opts.filter((n) => Boolean(n?.trim()));
    if (access?.restricted) {
      next = next.filter((n) => n !== "*");
    }
    if (!next.length) {
      next = access?.restricted ? [access.defaultNamespace || "default"] : ["*"];
    }
    const unknown = next.filter(
      (n) => n !== "*" && isValidNamespaceName(n) && !(namespaces[context] || []).includes(n),
    );
    if (unknown.length) {
      if (access?.restricted) {
        const extras = uniqueSorted([...loadExtraNamespaces(context), ...unknown]);
        saveExtraNamespaces(context, extras);
        setExtraNamespaces(context, extras);
      }
      setNamespaces(context, uniqueSorted([...(namespaces[context] || []), ...unknown]));
    }
    lastWatchErrorKey = "";
    setSelectedNamespaces(context, next);
  }

  function addNamespace(context: string, raw: string): boolean {
    const name = raw.trim();
    if (!isValidNamespaceName(name)) {
      setError(
        name
          ? `Invalid namespace "${name}". Use a DNS label (lowercase, digits, hyphens).`
          : "Enter a namespace name.",
      );
      return false;
    }
    const listed = namespaces[context] || [];
    if (!listed.includes(name)) {
      const extras = uniqueSorted([...loadExtraNamespaces(context), name]);
      saveExtraNamespaces(context, extras);
      setExtraNamespaces(context, extras);
      setNamespaces(context, uniqueSorted([...listed, name]));
    }
    const selected = (selectedNamespaces[context] || []).filter((n) => n !== "*");
    selectNamespaces(context, selected.includes(name) ? selected : [...selected, name]);
    return true;
  }

  function removeExtraNamespaces(context: string, names: string[]) {
    const drop = new Set(names);
    const extras = loadExtraNamespaces(context).filter((n) => !drop.has(n));
    saveExtraNamespaces(context, extras);
    setExtraNamespaces(context, extras);
    const access = namespaceAccess[context];
    let listed = (namespaces[context] || []).filter((n) => !drop.has(n));
    if (!listed.length && access?.defaultNamespace) {
      listed = [access.defaultNamespace];
    }
    setNamespaces(context, listed);
    selectNamespaces(
      context,
      (selectedNamespaces[context] || []).filter((n) => !drop.has(n)),
    );
  }

  function isExtraNamespace(context: string, name: string): boolean {
    return (extraNamespaces[context] || []).includes(name);
  }

  async function disconnect(context: string) {
    if (selectedContext() === context && visualizeNamespace()) {
      await stopGraphWatches();
    }
    await stopNodePodSidecars(context);
    await api.disconnectCluster(context);
    const active = await api.listActiveClusters();
    setActiveContexts(active);
    setSearchQueries(
      produce((draft) => {
        delete draft[context];
      }),
    );
    if (selectedContext() === context) {
      setSelectedContext(active[0] || "");
    }
  }

  async function stopGraphWatches() {
    graphWatchGeneration += 1;
    const ctx = selectedContext();
    const keys = { ...graphWatchKeys };
    for (const [bucket, watchKey] of Object.entries(keys)) {
      if (!watchKey) continue;
      const context = bucket.split("|")[0] || ctx;
      if (!context) continue;
      try {
        await api.stopResourceWatch(context, watchKey);
      } catch (e) {
        console.warn("stopGraphWatch failed", bucket, e);
      }
    }
    setGraphWatchKeys({});
    setVisualizeNamespace(null);
    setGraphLoading(false);
  }

  async function listAndWatchGraphKind(
    ctx: string,
    namespace: string,
    { apiVersion, kind }: GraphKindSpec,
    started: Record<string, string>,
    generation: number,
  ) {
    if (generation !== graphWatchGeneration) return;
    const key = bucketKey(ctx, apiVersion, kind, namespace);
    try {
      // Prefer a one-shot list for faster first paint, then watch for live updates.
      try {
        const listed = await api.listResourcesOnce(ctx, apiVersion, kind, namespace);
        if (generation !== graphWatchGeneration) return;
        ingestListed(key, listed, kind, apiVersion);
      } catch {
        if (generation !== graphWatchGeneration) return;
        setResources(key, { byUid: {}, order: [] });
      }

      if (generation !== graphWatchGeneration) return;
      const watchKey = await api.startResourceWatch(ctx, apiVersion, kind, namespace);
      if (generation !== graphWatchGeneration) {
        try {
          await api.stopResourceWatch(ctx, watchKey);
        } catch {
          /* ignore */
        }
        return;
      }
      started[key] = watchKey;
    } catch (e) {
      // Missing RBAC for a kind should not break the whole graph.
      console.warn(`graph watch skipped ${kind}:`, e);
      if (generation === graphWatchGeneration) {
        setResources(key, { byUid: {}, order: [] });
      }
    }
  }

  async function startGraphWatches(namespace: string) {
    const ctx = selectedContext();
    if (!ctx || !namespace || namespace === "*") return;
    await ensureWatchListener();
    await stopGraphWatches();
    const generation = graphWatchGeneration;
    setVisualizeNamespace(namespace);
    setGraphLoading(true);

    const started: Record<string, string> = {};

    // Wave 1: workloads + networking — paint as soon as these are listed.
    await Promise.all(
      GRAPH_KINDS_WAVE1.map((spec) =>
        listAndWatchGraphKind(ctx, namespace, spec, started, generation),
      ),
    );
    if (generation !== graphWatchGeneration) return;
    setGraphWatchKeys({ ...started });
    setGraphLoading(false);

    // Wave 2: bulky ConfigMaps/Secrets + link-only Endpoints (does not block UI).
    await Promise.all(
      GRAPH_KINDS_WAVE2.map((spec) =>
        listAndWatchGraphKind(ctx, namespace, spec, started, generation),
      ),
    );
    if (generation !== graphWatchGeneration) return;
    setGraphWatchKeys({ ...started });
  }

  function graphObjects(): K8sObject[] {
    const ctx = selectedContext();
    const ns = visualizeNamespace();
    if (!ctx || !ns) return [];
    const all: K8sObject[] = [];
    for (const { apiVersion, kind } of GRAPH_KINDS) {
      const bucket = resources[bucketKey(ctx, apiVersion, kind, ns)];
      if (!bucket) continue;
      for (const uid of bucket.order) {
        const obj = bucket.byUid[uid];
        if (!obj) continue;
        all.push({
          ...obj,
          kind: obj.kind || kind,
          apiVersion: obj.apiVersion || apiVersion,
        });
      }
    }
    return all;
  }

  async function stopNodePodSidecars(context?: string) {
    const keys = { ...nodePodSidecarKeys };
    for (const [bucket, watchKey] of Object.entries(keys)) {
      if (context && !bucket.startsWith(`${context}|`)) continue;
      if (!watchKey) continue;
      const ctx = bucket.split("|")[0] || context;
      if (ctx) {
        try {
          await api.stopResourceWatch(ctx, watchKey);
        } catch (e) {
          console.warn("stopNodePodWatch failed", bucket, e);
        }
      }
      setNodePodSidecarKeys(
        produce((draft) => {
          delete draft[bucket];
        }),
      );
    }
  }

  async function startNodePodWatch(ctx: string, namespace: string | null): Promise<boolean> {
    const key = bucketKey(ctx, "v1", "Pod", namespace);
    if (nodePodSidecarKeys[key]) return true;
    if (!resources[key]) {
      setResources(key, { byUid: {}, order: [] });
    }
    try {
      const watchKey = await api.startResourceWatch(ctx, "v1", "Pod", namespace);
      setNodePodSidecarKeys(key, watchKey);
      return true;
    } catch (e) {
      console.warn("node pod watch failed", namespace || "*", e);
      return false;
    }
  }

  async function syncNodePodSidecars(ctx: string) {
    const access = namespaceAccess[ctx];
    const selected = (selectedNamespaces[ctx] || []).filter((n) => n && n !== "*");
    const desired = new Set<string>();

    if (!access?.restricted) {
      const ok = await startNodePodWatch(ctx, null);
      if (ok) desired.add(bucketKey(ctx, "v1", "Pod", "*"));
      else {
        for (const ns of selected) {
          if (await startNodePodWatch(ctx, ns)) desired.add(bucketKey(ctx, "v1", "Pod", ns));
        }
      }
    } else {
      for (const ns of selected) {
        if (await startNodePodWatch(ctx, ns)) desired.add(bucketKey(ctx, "v1", "Pod", ns));
      }
    }

    for (const [bucket, watchKey] of Object.entries({ ...nodePodSidecarKeys })) {
      if (!bucket.startsWith(`${ctx}|`) || desired.has(bucket)) continue;
      if (watchKey) {
        try {
          await api.stopResourceWatch(ctx, watchKey);
        } catch (e) {
          console.warn("stopNodePodWatch failed", bucket, e);
        }
      }
      setNodePodSidecarKeys(
        produce((draft) => {
          delete draft[bucket];
        }),
      );
    }
  }

  async function stopListWatches(context?: string) {
    const keys = { ...watchKeys };
    for (const [bucket, watchKey] of Object.entries(keys)) {
      if (!watchKey) continue;
      if (context && !bucket.startsWith(`${context}|`)) continue;
      const ctx = bucket.split("|")[0] || context;
      if (!ctx) continue;
      try {
        await api.stopResourceWatch(ctx, watchKey);
      } catch (e) {
        console.warn("stopListWatch failed", bucket, e);
      }
      setWatchKeys(
        produce((draft) => {
          delete draft[bucket];
        }),
      );
    }
  }

  async function watchCurrent() {
    const generation = ++listWatchGeneration;
    pendingListBuckets = new Set();
    setListLoading(true);
    const ctx = selectedContext();
    if (!ctx) {
      finishListLoading(generation);
      return;
    }
    const { apiVersion, kind } = selectedKind();
    lastWatchErrorKey = "";
    setError(null);
    if (kind !== "Node") {
      await stopNodePodSidecars(ctx);
    }
    await stopListWatches(ctx);
    if (generation !== listWatchGeneration) return;
    if (kind === "Overview") {
      finishListLoading(generation);
      return;
    }
    const nss = namespacesToWatch(ctx, kind, apiVersion);
    await ensureWatchListener();
    if (generation !== listWatchGeneration) return;

    if (kind === "Namespace" && namespaceAccess[ctx]?.restricted) {
      finishListLoading(generation);
      return;
    }

    const discovered = (apiResources[ctx] || []).find(
      (r) => r.kind === kind && r.apiVersion === apiVersion,
    );
    if (discovered && !resourceIsWatchable(discovered)) {
      setError(
        `${kind} cannot be listed or watched. Kubernetes only allows creating this resource.`,
      );
      finishListLoading(generation);
      return;
    }

    pendingListBuckets = new Set(nss.map((ns) => bucketKey(ctx, apiVersion, kind, ns)));

    await Promise.all(
      nss.map(async (ns) => {
        if (generation !== listWatchGeneration) return;
        const key = bucketKey(ctx, apiVersion, kind, ns);
        const namespace = ns === "*" ? null : ns;
        try {
          try {
            const listed = await api.listResourcesOnce(ctx, apiVersion, kind, namespace);
            if (generation !== listWatchGeneration) return;
            ingestListed(key, listed, kind, apiVersion);
            markListBucketReady(key);
          } catch (listErr) {
            if (generation !== listWatchGeneration) return;
            setResources(key, { byUid: {}, order: [] });
            console.warn("listResourcesOnce failed, waiting for watch", key, listErr);
          }

          if (generation !== listWatchGeneration) return;
          const watchKey = await api.startResourceWatch(ctx, apiVersion, kind, namespace);
          if (generation !== listWatchGeneration) {
            try {
              await api.stopResourceWatch(ctx, watchKey);
            } catch {
              /* superseded */
            }
            return;
          }
          setWatchKeys(key, watchKey);
        } catch (e) {
          if (generation !== listWatchGeneration) return;
          markListBucketReady(key);
          setError(
            formatWatchError({
              context: ctx,
              apiVersion,
              kind,
              namespace,
              error: String(e),
            }),
          );
        }
      }),
    );

    if (generation === listWatchGeneration && pendingListBuckets.size === 0) {
      setListLoading(false);
    }

    // Pod counts for the Node column must not block first paint.
    if (kind === "Node" && generation === listWatchGeneration) {
      void syncNodePodSidecars(ctx);
    }
  }

  async function refreshCurrent() {
    const ctx = selectedContext();
    if (!ctx) return;
    const { apiVersion, kind } = selectedKind();
    if (kind === "Overview") return;
    if (kind === "Namespace" && namespaceAccess[ctx]?.restricted) return;
    const nss = namespacesToWatch(ctx, kind, apiVersion);
    const generation = ++listRefreshGeneration;

    const targets: { apiVersion: string; kind: string; namespace: string | null }[] = nss.map(
      (ns) => ({
        apiVersion,
        kind,
        namespace: ns === "*" ? null : ns,
      }),
    );
    if (kind === "Node") {
      for (const bucket of Object.keys(nodePodSidecarKeys)) {
        if (!nodePodSidecarKeys[bucket] || !bucket.startsWith(`${ctx}|`)) continue;
        const parts = bucket.split("|");
        const podNs = parts[3] === "*" ? null : parts[3] || null;
        targets.push({ apiVersion: "v1", kind: "Pod", namespace: podNs });
      }
    }

    await Promise.all(
      targets.map(async ({ apiVersion: av, kind: k, namespace }) => {
        const key = bucketKey(ctx, av, k, namespace);
        try {
          const listed = await api.listResourcesOnce(ctx, av, k, namespace);
          if (generation !== listRefreshGeneration) return;
          if (selectedContext() !== ctx) return;
          ingestListed(key, listed, k, av);
        } catch (e) {
          console.warn("refreshCurrent failed", key, e);
        }
      }),
    );
  }

  function podCountByNodeName(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of Object.keys(nodePodSidecarKeys)) {
      if (!nodePodSidecarKeys[key]) continue;
      const bucket = resources[key];
      if (!bucket) continue;
      for (const uid of bucket.order) {
        const obj = bucket.byUid[uid];
        if (!obj) continue;
        const nodeName = countedPodNodeName(obj as unknown as Record<string, unknown>);
        if (!nodeName) continue;
        counts[nodeName] = (counts[nodeName] || 0) + 1;
      }
    }
    return counts;
  }

  function nodePodCountsReady(): boolean {
    return Object.values(nodePodSidecarKeys).some(Boolean);
  }

  function restrictedNamespaceObjects(ctx: string): K8sObject[] {
    return (namespaces[ctx] || []).map((name) => ({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, uid: `restricted-ns:${ctx}:${name}` },
      name,
      uid: `restricted-ns:${ctx}:${name}`,
    }));
  }

  function currentObjects(): K8sObject[] {
    const ctx = selectedContext();
    if (!ctx) return [];
    const { apiVersion, kind } = selectedKind();
    const q = (searchQueries[ctx] || "").trim().toLowerCase();
    const status = statusFilter();
    const labels = labelFilter();
    const owner = ownerFilter();
    if (kind === "Namespace" && namespaceAccess[ctx]?.restricted) {
      return restrictedNamespaceObjects(ctx).filter((obj) => {
        if (!q) return true;
        const name = (obj.metadata?.name || obj.name || "").toLowerCase();
        return name.includes(q);
      });
    }
    const nss = namespacesToWatch(ctx, kind, apiVersion);
    const all: K8sObject[] = [];
    for (const ns of nss) {
      const key = bucketKey(ctx, apiVersion, kind, ns);
      const bucket = resources[key];
      if (!bucket) continue;
      for (const uid of bucket.order) {
        const obj = bucket.byUid[uid];
        if (!obj) continue;
        if (q) {
          const name = (obj.metadata?.name || obj.name || "").toLowerCase();
          const labelJson = JSON.stringify(obj.metadata?.labels || {}).toLowerCase();
          if (!name.includes(q) && !labelJson.includes(q)) continue;
        }
        if (status && !matchesStatusFilter(obj, kind, status)) continue;
        if (labels && !matchesLabelSelector(obj, labels)) continue;
        if (owner && !matchesOwnerFilter(obj, owner)) continue;
        all.push(obj);
      }
    }
    return all;
  }

  function selectedObject(): K8sObject | null {
    const key = selectedObjectKey();
    if (!key) return null;
    // Resolve from raw buckets so detail stays open even when list filters exclude it
    const ctx = selectedContext();
    if (!ctx) return null;
    const { apiVersion, kind } = selectedKind();
    if (kind === "Namespace" && namespaceAccess[ctx]?.restricted) {
      return restrictedNamespaceObjects(ctx).find((o) => objectKey(o) === key) || null;
    }
    const nss = namespacesToWatch(ctx, kind, apiVersion);
    for (const ns of nss) {
      const bucket = resources[bucketKey(ctx, apiVersion, kind, ns)];
      if (!bucket) continue;
      const obj = bucket.byUid[key];
      if (obj) return obj;
      const found = Object.values(bucket.byUid).find((o) => objectKey(o) === key);
      if (found) return found;
    }
    return null;
  }

  const searchQuery = createMemo(() => {
    const ctx = selectedContext();
    return (ctx && searchQueries[ctx]) || "";
  });

  function setSearchQuery(value: string) {
    const ctx = selectedContext();
    if (!ctx) return;
    setSearchQueries(ctx, value);
  }

  function clearListFilters() {
    setStatusFilter(null);
    setLabelFilter(null);
    setOwnerFilter(null);
    setSearchQuery("");
  }

  function isSyntheticNamespace(obj: K8sObject | null | undefined): boolean {
    if (!obj) return false;
    return String(obj.uid || obj.metadata?.uid || "").startsWith("restricted-ns:");
  }

  return {
    contexts,
    activeContexts,
    selectedContext,
    setSelectedContext,
    statuses,
    namespaces,
    selectedNamespaces,
    setSelectedNamespaces: selectNamespaces,
    namespaceAccess,
    extraNamespaces,
    addNamespace,
    removeExtraNamespaces,
    isExtraNamespace,
    isSyntheticNamespace,
    apiResources,
    resources,
    searchQuery,
    setSearchQuery,
    selectedKind,
    setSelectedKind,
    selectedObjectKey,
    setSelectedObjectKey,
    statusFilter,
    setStatusFilter,
    labelFilter,
    setLabelFilter,
    ownerFilter,
    setOwnerFilter,
    clearListFilters,
    error,
    clearError: () => setError(null),
    loading,
    listLoading,
    namespacesLoading,
    refreshContexts,
    refreshNamespaces,
    connect,
    disconnect,
    watchCurrent,
    refreshCurrent,
    currentObjects,
    podCountByNodeName,
    nodePodCountsReady,
    selectedObject,
    bucketKey,
    visualizeNamespace,
    graphLoading,
    startGraphWatches,
    stopGraphWatches,
    graphObjects,
  };
}

export const clusterStore = createRoot(createClusterStore);
