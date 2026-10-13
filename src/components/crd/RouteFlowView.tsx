import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../../api/tauri";
import type { RouteFlowEdge, RouteFlowGraph, RouteFlowNode } from "../../types";
import { type GraphLayoutResult, layoutTree, NODE_H, NODE_W } from "../../utils/graphLayout";
import type { GraphEdge, GraphNode } from "../../utils/namespaceGraph";
import type { RelationLink } from "../../utils/relations";
import { LoadingSpinner } from "../LoadingSpinner";
import { ResourceIcon } from "../ResourceIcon";

type Props = {
  context: string;
  apiVersion: string;
  kind: string;
  namespace?: string | null;
  name: string;
  onOpenResource: (link: RelationLink) => void;
};

function toGraphNodes(nodes: RouteFlowNode[]): GraphNode[] {
  return nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    apiVersion: n.apiVersion,
    name: n.name,
    namespace: n.namespace || "",
    label: n.label || n.name,
    status:
      n.status === "ok" ? "green" : n.status === "err" ? "red" : n.status === "idle" ? "grey" : "",
    obj: {
      kind: n.kind,
      apiVersion: n.apiVersion,
      metadata: { name: n.name, namespace: n.namespace || undefined },
    },
  }));
}

function toGraphEdges(edges: RouteFlowEdge[]): GraphEdge[] {
  return edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
}

export function RouteFlowView(props: Props) {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [graph, setGraph] = createSignal<RouteFlowGraph | null>(null);
  const [layout, setLayout] = createSignal<GraphLayoutResult>({
    nodes: [],
    edges: [],
    width: 400,
    height: 220,
    offsetX: 0,
    offsetY: 0,
  });

  createEffect(() => {
    const ctx = props.context;
    const apiVersion = props.apiVersion;
    const kind = props.kind;
    const name = props.name;
    const namespace = props.namespace ?? null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getRouteFlow({ context: ctx, apiVersion, kind, namespace, name })
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        const laid = layoutTree(toGraphNodes(g.nodes), toGraphEdges(g.edges));
        setLayout(laid);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  function openNode(n: RouteFlowNode) {
    props.onOpenResource({
      id: n.id,
      group: "Flow",
      title: `${n.kind}/${n.name}`,
      apiVersion: n.apiVersion,
      kind: n.kind,
      namespace: n.namespace,
      name: n.name,
    });
  }

  return (
    <section class="detail-block route-flow">
      <h3>Traffic flow</h3>
      <Show when={loading()}>
        <LoadingSpinner label="Resolving route…" />
      </Show>
      <Show when={error()}>
        <div class="muted">{error()}</div>
      </Show>
      <Show when={!loading() && !error() && graph()}>
        {(g) => (
          <Show
            when={g().nodes.length}
            fallback={<div class="muted">No backends resolved for this route.</div>}
          >
            <div class="route-flow-viewport">
              <svg
                class="route-flow-svg"
                width={layout().width}
                height={Math.max(180, layout().height)}
                viewBox={`${layout().offsetX} ${layout().offsetY} ${layout().width} ${layout().height}`}
              >
                <For each={layout().edges}>
                  {(edge) => (
                    <polyline
                      class="route-flow-edge"
                      fill="none"
                      points={edge.points.map((p) => `${p.x},${p.y}`).join(" ")}
                    />
                  )}
                </For>
                <For each={g().nodes}>
                  {(node) => {
                    const laid = () => layout().nodes.find((n) => n.id === node.id);
                    return (
                      <Show when={laid()}>
                        {(ln) => {
                          const clipId = `rf-clip-${node.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                          return (
                            <g
                              class={`route-flow-node status-${node.status || "idle"}`}
                              transform={`translate(${ln().x}, ${ln().y})`}
                              onClick={() => openNode(node)}
                              style={{ cursor: "pointer" }}
                            >
                              <title>
                                {node.kind}/{node.name}
                                {node.detail ? ` — ${node.detail}` : ""}
                              </title>
                              <clipPath id={clipId}>
                                <rect width={NODE_W} height={NODE_H} rx="8" />
                              </clipPath>
                              <g clip-path={`url(#${clipId})`}>
                                <rect
                                  class="route-flow-node-bg"
                                  width={NODE_W}
                                  height={NODE_H}
                                  rx="8"
                                />
                                <foreignObject x="0" y="0" width={NODE_W} height={NODE_H}>
                                  <div class="route-flow-node-inner">
                                    <div class="route-flow-icon">
                                      <ResourceIcon kind={node.kind} />
                                    </div>
                                    <div class="route-flow-text">
                                      <div class="route-flow-kind">{node.kind}</div>
                                      <div class="route-flow-name">{node.label || node.name}</div>
                                    </div>
                                  </div>
                                </foreignObject>
                              </g>
                            </g>
                          );
                        }}
                      </Show>
                    );
                  }}
                </For>
              </svg>
            </div>
            <Show when={g().notes?.length}>
              <ul class="route-flow-notes">
                <For each={g().notes || []}>{(note) => <li class="muted">{note}</li>}</For>
              </ul>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
