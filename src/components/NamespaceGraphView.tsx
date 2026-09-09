import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { resourceIconUrl } from "../constants/resourceIcons";
import { GRAPH_VISIBLE_KINDS } from "../constants/resources";
import type { K8sObject } from "../types";
import {
  CLOUD_NODE_SOFT_LIMIT,
  type GraphLayoutMode,
  type GraphLayoutResult,
  graphTopologyKey,
  layoutGraph,
  NODE_H,
  NODE_W,
  patchLayoutStatuses,
} from "../utils/graphLayout";
import { buildNamespaceGraph, type GraphStatusColor } from "../utils/namespaceGraph";
import { ResourceIcon } from "./ResourceIcon";

export type GraphOpenTarget = {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
};

type Props = {
  namespace: string;
  objects: K8sObject[];
  loading?: boolean;
  onBack: () => void;
  onOpenResource: (target: GraphOpenTarget) => void;
};

type ViewRect = { minX: number; minY: number; maxX: number; maxY: number };

function statusClass(status: GraphStatusColor): string {
  if (status === "green") return "ok";
  if (status === "red") return "err";
  if (status === "grey") return "idle";
  return "";
}

function nodeIntersectsView(n: { x: number; y: number }, view: ViewRect): boolean {
  return (
    n.x + NODE_W >= view.minX && n.x <= view.maxX && n.y + NODE_H >= view.minY && n.y <= view.maxY
  );
}

function edgeIntersectsView(points: { x: number; y: number }[], view: ViewRect): boolean {
  if (!points.length) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return maxX >= view.minX && minX <= view.maxX && maxY >= view.minY && minY <= view.maxY;
}

export function NamespaceGraphView(props: Props) {
  const [search, setSearch] = createSignal("");
  const [hideEmptyRs, setHideEmptyRs] = createSignal(true);
  const [layoutMode, setLayoutMode] = createSignal<GraphLayoutMode>("tree");
  const [enabledKinds, setEnabledKinds] = createSignal<Set<string>>(new Set(GRAPH_VISIBLE_KINDS));
  const [expandedIsolatedKinds, setExpandedIsolatedKinds] = createSignal<Set<string>>(new Set());
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [zoom, setZoom] = createSignal(1);
  const [fitToken, setFitToken] = createSignal(0);
  const [hasFitted, setHasFitted] = createSignal(false);
  const [viewportSize, setViewportSize] = createSignal({ w: 800, h: 600 });
  const [layoutResult, setLayoutResult] = createSignal<GraphLayoutResult>({
    nodes: [],
    edges: [],
    width: 400,
    height: 300,
    offsetX: 0,
    offsetY: 0,
  });

  let viewportRef: HTMLDivElement | undefined;
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let panStart = { x: 0, y: 0 };
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTopologyKey = "";
  let cullRaf = 0;
  const [cullTick, setCullTick] = createSignal(0);

  const graph = createMemo(() =>
    buildNamespaceGraph(props.objects, {
      visibleKinds: enabledKinds(),
      hideEmptyReplicaSets: hideEmptyRs(),
      search: search(),
      expandedIsolatedKinds: expandedIsolatedKinds(),
    }),
  );

  const selectedNode = createMemo(() => {
    const id = selectedId();
    if (!id) return null;
    return layoutResult().nodes.find((n) => n.id === id) || null;
  });

  const viewRect = createMemo((): ViewRect => {
    void cullTick();
    const p = pan();
    const z = zoom();
    const { w, h } = viewportSize();
    const layout = layoutResult();
    const overscan = NODE_W * 2;
    // Screen → graph coords (before offset translate in SVG group).
    const minX = -p.x / z + layout.offsetX - overscan;
    const minY = -p.y / z + layout.offsetY - overscan;
    const maxX = (w - p.x) / z + layout.offsetX + overscan;
    const maxY = (h - p.y) / z + layout.offsetY + overscan;
    return { minX, minY, maxX, maxY };
  });

  const visibleNodes = createMemo(() => {
    const view = viewRect();
    return layoutResult().nodes.filter((n) => nodeIntersectsView(n, view));
  });

  const visibleEdges = createMemo(() => {
    const view = viewRect();
    return layoutResult().edges.filter((e) => edgeIntersectsView(e.points, view));
  });

  const cloudLarge = createMemo(
    () => layoutMode() === "cloud" && graph().nodes.length > CLOUD_NODE_SOFT_LIMIT,
  );

  function scheduleCull() {
    if (cullRaf) return;
    cullRaf = requestAnimationFrame(() => {
      cullRaf = 0;
      setCullTick((t) => t + 1);
    });
  }

  function measureViewport() {
    const el = viewportRef;
    if (!el) return;
    setViewportSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
  }

  function fitView() {
    const el = viewportRef;
    if (!el) return;
    const { width, height } = layoutResult();
    const pad = 32;
    const scale = Math.min(
      1.2,
      Math.max(
        0.25,
        Math.min(
          (el.clientWidth - pad) / Math.max(width, 1),
          (el.clientHeight - pad) / Math.max(height, 1),
        ),
      ),
    );
    setZoom(scale);
    setPan({
      x: (el.clientWidth - width * scale) / 2,
      y: (el.clientHeight - height * scale) / 2,
    });
    scheduleCull();
  }

  function setMode(mode: GraphLayoutMode) {
    if (layoutMode() === mode) return;
    if (layoutTimer) {
      clearTimeout(layoutTimer);
      layoutTimer = undefined;
    }
    setLayoutMode(mode);
    lastTopologyKey = "";
    setHasFitted(false);
    // Mode switches must not wait on the data debounce — otherwise fit races the old layout.
    runLayout(true);
    requestAnimationFrame(() => {
      fitView();
      setHasFitted(true);
    });
  }

  function runLayout(force = false) {
    const g = graph();
    const mode = layoutMode();
    const topo = `${mode}|${graphTopologyKey(g.nodes, g.edges)}`;
    const prev = layoutResult();

    if (!force && topo === lastTopologyKey && prev.nodes.length) {
      const patched = patchLayoutStatuses(prev, g.nodes, g.edges);
      if (patched) {
        setLayoutResult(patched);
        return;
      }
    }

    lastTopologyKey = topo;
    setLayoutResult(layoutGraph(mode, g.nodes, g.edges));
  }

  function scheduleLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      layoutTimer = undefined;
      runLayout();
    }, 150);
  }

  createEffect(() => {
    void props.namespace;
    setHasFitted(false);
    setExpandedIsolatedKinds(new Set<string>());
    lastTopologyKey = "";
  });

  // Debounced layout when graph data changes (not mode — mode applies immediately).
  createEffect(() => {
    void graph();
    scheduleLayout();
  });

  createEffect(() => {
    const token = fitToken();
    if (token === 0) return;
    requestAnimationFrame(() => fitView());
  });

  createEffect(() => {
    if (hasFitted() || props.loading) return;
    const layout = layoutResult();
    if (!layout.nodes.length) return;
    // Avoid fitting the previous mode's positions after a mode switch cleared hasFitted.
    const mode = layoutMode();
    if (!lastTopologyKey.startsWith(`${mode}|`)) return;
    requestAnimationFrame(() => {
      fitView();
      setHasFitted(true);
    });
  });

  function toggleKind(kind: string) {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function expandCluster(kind: string) {
    setExpandedIsolatedKinds((prev) => {
      const next = new Set(prev);
      next.add(kind);
      return next;
    });
    setSelectedId(null);
    if (layoutTimer) {
      clearTimeout(layoutTimer);
      layoutTimer = undefined;
    }
    lastTopologyKey = "";
    setHasFitted(false);
    // graph() updates synchronously from the signal above; lay out + fit immediately.
    runLayout(true);
    requestAnimationFrame(() => {
      fitView();
      setHasFitted(true);
    });
  }

  function collapseIsolatedKind(kind: string) {
    setExpandedIsolatedKinds((prev) => {
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
    setSelectedId(null);
    if (layoutTimer) {
      clearTimeout(layoutTimer);
      layoutTimer = undefined;
    }
    lastTopologyKey = "";
    setHasFitted(false);
    runLayout(true);
    requestAnimationFrame(() => {
      fitView();
      setHasFitted(true);
    });
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".graph-node")) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { ...pan() };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    setPan({
      x: panStart.x + (e.clientX - dragStart.x),
      y: panStart.y + (e.clientY - dragStart.y),
    });
    scheduleCull();
  }

  function onPointerUp() {
    dragging = false;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const el = viewportRef;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prev = zoom();
    const next = Math.min(2.5, Math.max(0.2, prev * (e.deltaY < 0 ? 1.1 : 0.9)));
    const p = pan();
    setPan({
      x: mx - ((mx - p.x) * next) / prev,
      y: my - ((my - p.y) * next) / prev,
    });
    setZoom(next);
    scheduleCull();
  }

  onMount(() => {
    const el = viewportRef;
    if (!el) return;
    measureViewport();
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measureViewport()) : null;
    ro?.observe(el);
    onCleanup(() => {
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
      if (layoutTimer) clearTimeout(layoutTimer);
      if (cullRaf) cancelAnimationFrame(cullRaf);
    });
  });

  function pathD(points: { x: number; y: number }[]): string {
    if (!points.length) return "";
    const [first, ...rest] = points;
    return `M ${first.x} ${first.y} ${rest.map((p) => `L ${p.x} ${p.y}`).join(" ")}`;
  }

  const layout = () => layoutResult();

  return (
    <section class="ns-graph">
      <header class="ns-graph-toolbar">
        <button type="button" class="btn" onClick={() => props.onBack()}>
          ← Back
        </button>
        <div class="ns-graph-title">
          <ResourceIcon kind="Namespace" />
          <span>
            Visualize <strong class="mono">{props.namespace}</strong>
          </span>
          <span class="muted">
            {layout().nodes.length} nodes · {layout().edges.length} links
            <Show when={visibleNodes().length < layout().nodes.length}>
              {" "}
              · {visibleNodes().length} in view
            </Show>
          </span>
        </div>
        <div class="ns-graph-layout-toggle" role="group" aria-label="Layout mode">
          <button
            type="button"
            class={`btn ghost ${layoutMode() === "tree" ? "active" : ""}`}
            title="Tree layout (hierarchical)"
            onClick={() => setMode("tree")}
          >
            Tree
          </button>
          <button
            type="button"
            class={`btn ghost ${layoutMode() === "cloud" ? "active" : ""}`}
            title={
              cloudLarge()
                ? `Cloud layout (capped for ${graph().nodes.length} nodes)`
                : "Cloud layout (force-directed)"
            }
            onClick={() => setMode("cloud")}
          >
            Cloud
          </button>
        </div>
        <input
          class="search"
          placeholder="Search resources…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <label class="ns-graph-check">
          <input
            type="checkbox"
            checked={hideEmptyRs()}
            onChange={(e) => setHideEmptyRs(e.currentTarget.checked)}
          />
          Hide empty ReplicaSets
        </label>
        <button
          type="button"
          class="btn ghost"
          onClick={() => setFitToken((n) => n + 1)}
          title="Fit graph to view"
        >
          Fit
        </button>
      </header>

      <Show when={cloudLarge()}>
        <div class="ns-graph-banner muted">
          Cloud layout is capped for graphs larger than {CLOUD_NODE_SOFT_LIMIT} nodes. Prefer Tree
          for clearer hierarchy.
        </div>
      </Show>

      <div class="ns-graph-filters">
        <For each={[...GRAPH_VISIBLE_KINDS]}>
          {(kind) => (
            <button
              type="button"
              class={`chip ${enabledKinds().has(kind) ? "active" : ""}`}
              onClick={() => toggleKind(kind)}
            >
              <ResourceIcon kind={kind} />
              {kind}
            </button>
          )}
        </For>
      </div>

      <div class="ns-graph-body">
        <div
          class="ns-graph-viewport"
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <Show when={props.loading}>
            <div class="ns-graph-loading">Loading namespace resources…</div>
          </Show>
          <Show when={!props.loading && !layout().nodes.length}>
            <div class="ns-graph-empty muted">
              No resources to display in this namespace (or all kinds filtered).
            </div>
          </Show>
          <svg
            class="ns-graph-svg"
            style={{
              transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`,
              "transform-origin": "0 0",
            }}
            width={layout().width}
            height={layout().height}
          >
            <defs>
              <marker
                id="ns-graph-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            <g transform={`translate(${-layout().offsetX}, ${-layout().offsetY})`}>
              <For each={visibleEdges()}>
                {(e) => (
                  <path
                    class="ns-graph-edge"
                    d={pathD(e.points)}
                    marker-end="url(#ns-graph-arrow)"
                  />
                )}
              </For>
              <For each={visibleNodes()}>
                {(n) => {
                  const iconUrl = resourceIconUrl(n.kind);
                  return (
                    <g
                      class={`graph-node ns-graph-node ${selectedId() === n.id ? "selected" : ""} ${
                        n.cluster ? "cluster" : ""
                      }`}
                      transform={`translate(${n.x}, ${n.y})`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (n.cluster) {
                          expandCluster(n.kind);
                          return;
                        }
                        setSelectedId(n.id);
                      }}
                      role="button"
                      tabindex="0"
                    >
                      <rect
                        class={`ns-graph-node-bg status-${statusClass(n.status) || "none"}`}
                        width={NODE_W}
                        height={NODE_H}
                        rx="8"
                        ry="8"
                      />
                      <Show
                        when={iconUrl}
                        fallback={
                          <text
                            class="ns-graph-node-icon-fallback"
                            x={19}
                            y={NODE_H / 2 + 4}
                            text-anchor="middle"
                          >
                            {(n.kind[0] || "?").toUpperCase()}
                          </text>
                        }
                      >
                        {(src) => (
                          <image
                            href={src()}
                            x={10}
                            y={(NODE_H - 18) / 2}
                            width={18}
                            height={18}
                            class="ns-graph-node-icon"
                          />
                        )}
                      </Show>
                      <text class="ns-graph-node-kind-svg" x={34} y={22}>
                        {n.kind}
                      </text>
                      <text class="ns-graph-node-name-svg" x={34} y={40}>
                        {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
                      </text>
                      <title>
                        {n.cluster ? `Click to expand ${n.memberCount} ${n.kind}` : n.name}
                      </title>
                    </g>
                  );
                }}
              </For>
            </g>
          </svg>
        </div>

        <Show when={selectedNode()}>
          {(n) => (
            <aside class="ns-graph-inspector">
              <div class="ns-graph-inspector-head">
                <ResourceIcon kind={n().kind} />
                <div>
                  <div class="mono">{n().name}</div>
                  <div class="muted">{n().kind}</div>
                </div>
              </div>
              <dl class="ns-graph-meta">
                <dt>Namespace</dt>
                <dd>{n().namespace || "—"}</dd>
                <dt>Status</dt>
                <dd>
                  <span
                    class={`status-label ${
                      n().status === "green" ? "ok" : n().status === "red" ? "err" : "idle"
                    }`}
                  >
                    {n().status || "n/a"}
                  </span>
                </dd>
                <dt>API</dt>
                <dd class="mono">{n().apiVersion || "—"}</dd>
              </dl>
              <Show when={Object.keys(n().obj.metadata?.labels || {}).length}>
                <div class="ns-graph-labels">
                  <div class="muted">Labels</div>
                  <For each={Object.entries(n().obj.metadata?.labels || {})}>
                    {([k, v]) => (
                      <div class="mono label-pill">
                        {k}={v}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={expandedIsolatedKinds().has(n().kind)}>
                <button
                  type="button"
                  class="btn ghost"
                  onClick={() => collapseIsolatedKind(n().kind)}
                >
                  Collapse isolated {n().kind}
                </button>
              </Show>
              <Show when={!n().cluster}>
                <button
                  type="button"
                  class="btn"
                  onClick={() =>
                    props.onOpenResource({
                      apiVersion: n().apiVersion,
                      kind: n().kind,
                      name: n().name,
                      namespace: n().namespace,
                    })
                  }
                >
                  Open resource
                </button>
              </Show>
            </aside>
          )}
        </Show>
      </div>
    </section>
  );
}
