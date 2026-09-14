/** Configurable resource-list columns (visibility + widths). */

export type ListColumnId =
  | "name"
  | "namespace"
  | "node"
  | "version"
  | "status"
  | "pods"
  | "metrics"
  | "age";

export type ListColumnMeta = {
  id: ListColumnId;
  label: string;
  defaultFr: number;
  minPx: number;
  hideable: boolean;
  /** When available for the kind and no prefs stored yet. */
  defaultHidden?: boolean;
};

export const LIST_COLUMN_META: Record<ListColumnId, ListColumnMeta> = {
  name: { id: "name", label: "Name", defaultFr: 2, minPx: 80, hideable: false },
  namespace: { id: "namespace", label: "Namespace", defaultFr: 1, minPx: 70, hideable: true },
  node: {
    id: "node",
    label: "Node",
    defaultFr: 1,
    minPx: 70,
    hideable: true,
    defaultHidden: true,
  },
  version: { id: "version", label: "Version", defaultFr: 0.7, minPx: 60, hideable: true },
  status: { id: "status", label: "Status", defaultFr: 0.8, minPx: 70, hideable: true },
  pods: { id: "pods", label: "Pods", defaultFr: 0.6, minPx: 50, hideable: true },
  metrics: { id: "metrics", label: "CPU / Mem", defaultFr: 1, minPx: 70, hideable: true },
  age: { id: "age", label: "Age", defaultFr: 0.5, minPx: 40, hideable: true },
};

export type KindColumnCaps = {
  namespace: boolean;
  node: boolean;
  version: boolean;
  pods: boolean;
  metrics: boolean;
};

export type ColumnPrefs = {
  /** Per-kind hidden column ids once the user has customized that kind. */
  hiddenByKind?: Record<string, ListColumnId[]>;
  widths?: Partial<Record<ListColumnId, number>>;
};

const STORAGE_KEY = "kuby.listColumns";
const CHECK_COL = "28px";
const ALL_IDS = Object.keys(LIST_COLUMN_META) as ListColumnId[];

function isColumnId(v: unknown): v is ListColumnId {
  return typeof v === "string" && (ALL_IDS as string[]).includes(v);
}

export function availableColumns(caps: KindColumnCaps): ListColumnId[] {
  const cols: ListColumnId[] = ["name"];
  if (caps.namespace) cols.push("namespace");
  if (caps.node) cols.push("node");
  if (caps.version) cols.push("version");
  cols.push("status");
  if (caps.pods) cols.push("pods");
  if (caps.metrics) cols.push("metrics");
  cols.push("age");
  return cols;
}

export function defaultHiddenFor(available: ListColumnId[]): ListColumnId[] {
  return available.filter((id) => LIST_COLUMN_META[id].defaultHidden);
}

export function hiddenColumns(
  prefs: ColumnPrefs,
  kind: string,
  available: ListColumnId[],
): Set<ListColumnId> {
  const stored = prefs.hiddenByKind?.[kind];
  if (stored) {
    return new Set(stored.filter((id) => available.includes(id)));
  }
  return new Set(defaultHiddenFor(available));
}

export function visibleColumns(
  prefs: ColumnPrefs,
  kind: string,
  available: ListColumnId[],
): ListColumnId[] {
  const hidden = hiddenColumns(prefs, kind, available);
  return available.filter((id) => !hidden.has(id));
}

export function toggleColumnHidden(
  prefs: ColumnPrefs,
  kind: string,
  available: ListColumnId[],
  id: ListColumnId,
): ColumnPrefs {
  if (!LIST_COLUMN_META[id].hideable || !available.includes(id)) return prefs;
  const hidden = hiddenColumns(prefs, kind, available);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  // Keep at least the non-hideable columns visible (name).
  const stillVisible = available.some((c) => !hidden.has(c));
  if (!stillVisible) return prefs;
  return {
    ...prefs,
    hiddenByKind: {
      ...prefs.hiddenByKind,
      [kind]: available.filter((c) => hidden.has(c)),
    },
  };
}

export function setColumnWidth(prefs: ColumnPrefs, id: ListColumnId, px: number): ColumnPrefs {
  const meta = LIST_COLUMN_META[id];
  const next = Math.max(meta.minPx, Math.round(px));
  return {
    ...prefs,
    widths: { ...prefs.widths, [id]: next },
  };
}

function columnTrack(id: ListColumnId, widths?: Partial<Record<ListColumnId, number>>): string {
  const meta = LIST_COLUMN_META[id];
  const w = widths?.[id];
  if (typeof w === "number" && Number.isFinite(w)) {
    return `${Math.max(meta.minPx, Math.round(w))}px`;
  }
  return `minmax(${meta.minPx}px, ${meta.defaultFr}fr)`;
}

export function buildGridTemplate(
  visible: ListColumnId[],
  widths?: Partial<Record<ListColumnId, number>>,
): string {
  return [CHECK_COL, ...visible.map((id) => columnTrack(id, widths))].join(" ");
}

export function readColumnPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const prefs: ColumnPrefs = {};

    if (obj.hiddenByKind && typeof obj.hiddenByKind === "object") {
      const hiddenByKind: Record<string, ListColumnId[]> = {};
      for (const [kind, ids] of Object.entries(obj.hiddenByKind as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        hiddenByKind[kind] = ids.filter(isColumnId);
      }
      prefs.hiddenByKind = hiddenByKind;
    }

    if (obj.widths && typeof obj.widths === "object") {
      const widths: Partial<Record<ListColumnId, number>> = {};
      for (const [id, px] of Object.entries(obj.widths as Record<string, unknown>)) {
        if (!isColumnId(id)) continue;
        if (typeof px !== "number" || !Number.isFinite(px)) continue;
        widths[id] = Math.round(px);
      }
      prefs.widths = widths;
    }

    return prefs;
  } catch {
    return {};
  }
}

export function persistColumnPrefs(prefs: ColumnPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota */
  }
}

/** Bound node name from pod spec (any phase). */
export function podNodeName(obj: Record<string, unknown>): string {
  const spec = obj.spec as Record<string, unknown> | undefined;
  const nodeName = spec?.nodeName;
  return typeof nodeName === "string" && nodeName ? nodeName : "";
}
