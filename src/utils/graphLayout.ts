import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import type { GraphEdge, GraphNode } from "./namespaceGraph";

export type GraphLayoutMode = "tree" | "cloud";

export type LaidOutNode = GraphNode & { x: number; y: number };
export type LaidOutEdge = { id: string; points: { x: number; y: number }[] };

export type GraphLayoutResult = {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

const NODE_W = 140;
const NODE_H = 56;

/** Prefer tree layout above this node count — cloud force sim becomes too expensive. */
export const CLOUD_NODE_SOFT_LIMIT = 400;

export { NODE_H, NODE_W };

function boundsOf(nodes: LaidOutNode[]): GraphLayoutResult {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  if (!nodes.length) {
    minX = 0;
    minY = 0;
    maxX = 400;
    maxY = 300;
  }
  return {
    nodes,
    edges: [],
    width: Math.max(400, maxX - minX + 80),
    height: Math.max(300, maxY - minY + 80),
    offsetX: minX - 40,
    offsetY: minY - 40,
  };
}

function withEdges(base: GraphLayoutResult, edges: LaidOutEdge[]): GraphLayoutResult {
  return { ...base, edges };
}

/** Stable topology key: node/edge IDs only (ignore status/label churn). */
export function graphTopologyKey(nodes: GraphNode[], edges: GraphEdge[]): string {
  const n = nodes
    .map((x) => x.id)
    .sort()
    .join(",");
  const e = edges
    .map((x) => x.id)
    .sort()
    .join(",");
  return `${n}|${e}`;
}

/**
 * Reuse previous positions when topology is unchanged; only patch status/label/obj.
 * Returns null when a full re-layout is required.
 */
export function patchLayoutStatuses(
  prev: GraphLayoutResult,
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphLayoutResult | null {
  if (prev.nodes.length !== nodes.length || prev.edges.length !== edges.length) {
    return null;
  }
  const byId = new Map(prev.nodes.map((n) => [n.id, n]));
  const patched: LaidOutNode[] = [];
  for (const n of nodes) {
    const old = byId.get(n.id);
    if (!old) return null;
    patched.push({
      ...n,
      x: old.x,
      y: old.y,
    });
  }
  // Edges: keep geometry if IDs match (order-independent check already via topology key).
  const edgeIds = new Set(edges.map((e) => e.id));
  if (prev.edges.some((e) => !edgeIds.has(e.id))) return null;
  return {
    ...prev,
    nodes: patched,
    edges: prev.edges,
  };
}

/** Hierarchical top-down layout (KubeView dagre mode). */
export function layoutTree(nodes: GraphNode[], edges: GraphEdge[]): GraphLayoutResult {
  const dg = new dagre.graphlib.Graph({ multigraph: false, compound: false });
  dg.setGraph({
    rankdir: "TB",
    nodesep: 36,
    ranksep: 56,
    marginx: 24,
    marginy: 24,
  });
  dg.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    dg.setNode(n.id, { width: NODE_W, height: NODE_H, label: n.label });
  }
  for (const e of edges) {
    dg.setEdge(e.source, e.target);
  }
  if (nodes.length) dagre.layout(dg);

  const laid: LaidOutNode[] = nodes.map((n) => {
    const pos = dg.node(n.id) || { x: 0, y: 0 };
    return {
      ...n,
      x: Number(pos.x) - NODE_W / 2,
      y: Number(pos.y) - NODE_H / 2,
    };
  });

  const laidEdges: LaidOutEdge[] = edges.map((e) => {
    const edge = dg.edge(e.source, e.target) as { points?: { x: number; y: number }[] } | undefined;
    const points = edge?.points?.length
      ? edge.points
      : (() => {
          const s = dg.node(e.source);
          const t = dg.node(e.target);
          return [
            { x: Number(s?.x || 0), y: Number(s?.y || 0) },
            { x: Number(t?.x || 0), y: Number(t?.y || 0) },
          ];
        })();
    return { id: e.id, points };
  });

  return withEdges(boundsOf(laid), laidEdges);
}

type SimNode = { id: string; x: number; y: number; index?: number };
type SimLink = { source: string | SimNode; target: string | SimNode };

/**
 * Force-directed "cloud" layout (KubeView force-atlas2 mode).
 * Isolated nodes cluster instead of stretching into a long dagre rank.
 * Tick count is capped so large graphs stay interactive.
 */
export function layoutCloud(nodes: GraphNode[], edges: GraphEdge[]): GraphLayoutResult {
  if (!nodes.length) {
    return { nodes: [], edges: [], width: 400, height: 300, offsetX: 0, offsetY: 0 };
  }

  // Seed by kind so similar resources start near each other (cloud pockets).
  const kinds = [...new Set(nodes.map((n) => n.kind))];
  const kindIndex = new Map(kinds.map((k, i) => [k, i]));
  const ring = Math.max(220, Math.sqrt(nodes.length) * 48);

  const simNodes: SimNode[] = nodes.map((n, i) => {
    const ki = kindIndex.get(n.kind) ?? 0;
    const angle =
      (ki / Math.max(kinds.length, 1)) * Math.PI * 2 + (i / Math.max(nodes.length, 1)) * 0.35;
    const r = ring * (0.35 + (ki % 3) * 0.2);
    return {
      id: n.id,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    };
  });

  const simLinks: SimLink[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(110)
        .strength(0.55),
    )
    .force("charge", forceManyBody().strength(-520).distanceMax(640).theta(0.9))
    .force("collide", forceCollide(Math.hypot(NODE_W, NODE_H) / 2 + 14).strength(0.9))
    .force("center", forceCenter(0, 0))
    .force("x", forceX(0).strength(0.04))
    .force("y", forceY(0).strength(0.04))
    .stop();

  // Hard cap: previously min(400, 120 + n*2) froze on ~1000 nodes.
  const ticks = Math.min(80, Math.floor(40 + Math.sqrt(nodes.length) * 8));
  for (let i = 0; i < ticks; i++) simulation.tick();

  const byId = new Map(simNodes.map((n) => [n.id, n]));
  const laid: LaidOutNode[] = nodes.map((n) => {
    const pos = byId.get(n.id);
    return {
      ...n,
      x: (pos?.x ?? 0) - NODE_W / 2,
      y: (pos?.y ?? 0) - NODE_H / 2,
    };
  });

  const laidEdges: LaidOutEdge[] = edges.map((e) => {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    return {
      id: e.id,
      points: [
        { x: s?.x ?? 0, y: s?.y ?? 0 },
        { x: t?.x ?? 0, y: t?.y ?? 0 },
      ],
    };
  });

  return withEdges(boundsOf(laid), laidEdges);
}

export function layoutGraph(
  mode: GraphLayoutMode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphLayoutResult {
  return mode === "cloud" ? layoutCloud(nodes, edges) : layoutTree(nodes, edges);
}
