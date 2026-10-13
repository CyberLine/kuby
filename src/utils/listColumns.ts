/** Configurable resource-list columns (visibility + widths). */

import type { PrinterColumn } from "../types";

export type ListColumnId =
  | "name"
  | "namespace"
  | "node"
  | "version"
  | "status"
  | "summary"
  | "pods"
  | "cpu"
  | "memory"
  | "expires"
  | "age";

/** Fixed column id or dynamic `printer:<slug>` from CRD/Table printer columns. */
export type ColumnId = ListColumnId | (string & {});

export type ListColumnMeta = {
  id: ColumnId;
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
  summary: { id: "summary", label: "Summary", defaultFr: 1.4, minPx: 90, hideable: true },
  pods: { id: "pods", label: "Pods", defaultFr: 0.6, minPx: 50, hideable: true },
  cpu: { id: "cpu", label: "CPU", defaultFr: 0.7, minPx: 72, hideable: true },
  memory: { id: "memory", label: "Mem", defaultFr: 0.7, minPx: 72, hideable: true },
  expires: { id: "expires", label: "Expires", defaultFr: 0.7, minPx: 64, hideable: true },
  age: { id: "age", label: "Age", defaultFr: 0.5, minPx: 40, hideable: true },
};

export type KindColumnCaps = {
  namespace: boolean;
  node: boolean;
  version: boolean;
  status: boolean;
  summary: boolean;
  pods: boolean;
  metrics: boolean;
  expires: boolean;
};

export type ColumnPrefs = {
  /** Per-kind hidden column ids once the user has customized that kind. */
  hiddenByKind?: Record<string, ColumnId[]>;
  /**
   * Globally enabled printer column ids (`printer:…`), shared across clusters and kinds.
   * Dynamic columns stay hidden until listed here.
   */
  enabledPrinterColumns?: ColumnId[];
  widths?: Partial<Record<string, number>>;
};

const STORAGE_KEY = "kuby.listColumns";
const CHECK_COL = "28px";
const ALL_FIXED_IDS = Object.keys(LIST_COLUMN_META) as ListColumnId[];
const PRINTER_PREFIX = "printer:";

/** Built-in Kuby columns that kubectl Table also emits — skip duplicates. */
const DEDUPE_LABELS = new Set(["name", "namespace", "age"]);

export function isFixedColumnId(id: string): id is ListColumnId {
  return (ALL_FIXED_IDS as string[]).includes(id);
}

export function isPrinterColumnId(id: string): boolean {
  return id.startsWith(PRINTER_PREFIX);
}

/** Stable id from a printer column display name. */
export function printerColumnId(name: string): ColumnId {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PRINTER_PREFIX}${slug || "col"}`;
}

export function shouldSkipPrinterColumn(name: string): boolean {
  return DEDUPE_LABELS.has(name.trim().toLowerCase());
}

export function metaForColumn(
  id: ColumnId,
  printerById?: Map<string, PrinterColumn>,
): ListColumnMeta {
  if (isFixedColumnId(id)) return LIST_COLUMN_META[id];
  const col = printerById?.get(id);
  return {
    id,
    label: col?.name ?? id.replace(PRINTER_PREFIX, ""),
    defaultFr: 1,
    minPx: 64,
    hideable: true,
  };
}

function isColumnId(v: unknown): v is ColumnId {
  return typeof v === "string" && (isFixedColumnId(v) || isPrinterColumnId(v));
}

/** Older prefs stored one combined "metrics" column. */
function expandStoredId(v: unknown): ColumnId[] {
  if (v === "metrics") return ["cpu", "memory"];
  return isColumnId(v) ? [v] : [];
}

export function availableColumns(
  caps: KindColumnCaps,
  printerColumns: PrinterColumn[] = [],
): ColumnId[] {
  const cols: ColumnId[] = ["name"];
  if (caps.namespace) cols.push("namespace");
  if (caps.node) cols.push("node");
  if (caps.version) cols.push("version");
  if (caps.status) cols.push("status");
  if (caps.summary) cols.push("summary");
  if (caps.pods) cols.push("pods");
  if (caps.metrics) {
    cols.push("cpu");
    cols.push("memory");
  }
  if (caps.expires) cols.push("expires");

  const seen = new Set(cols);
  for (const col of printerColumns) {
    if (shouldSkipPrinterColumn(col.name)) continue;
    const id = printerColumnId(col.name);
    if (seen.has(id)) continue;
    seen.add(id);
    cols.push(id);
  }

  cols.push("age");
  return cols;
}

export function defaultHiddenFor(
  available: ColumnId[],
  printerById?: Map<string, PrinterColumn>,
): ColumnId[] {
  return available.filter((id) => {
    if (isFixedColumnId(id)) return Boolean(LIST_COLUMN_META[id].defaultHidden);
    // Dynamic printer columns stay off until the user enables them in Columns.
    void printerById;
    return isPrinterColumnId(id);
  });
}

function enabledPrinterSet(prefs: ColumnPrefs): Set<ColumnId> {
  return new Set((prefs.enabledPrinterColumns || []).filter(isPrinterColumnId));
}

export function hiddenColumns(
  prefs: ColumnPrefs,
  kind: string,
  available: ColumnId[],
  printerById?: Map<string, PrinterColumn>,
): Set<ColumnId> {
  const enabledPrinter = enabledPrinterSet(prefs);
  const stored = prefs.hiddenByKind?.[kind];
  const hidden = new Set<ColumnId>(
    stored
      ? stored.filter((id) => available.includes(id) && !isPrinterColumnId(id))
      : defaultHiddenFor(available, printerById).filter((id) => !isPrinterColumnId(id)),
  );
  // Printer columns: hidden unless globally enabled (survives cluster switches).
  for (const id of available) {
    if (isPrinterColumnId(id) && !enabledPrinter.has(id)) hidden.add(id);
  }
  return hidden;
}

export function visibleColumns(
  prefs: ColumnPrefs,
  kind: string,
  available: ColumnId[],
  printerById?: Map<string, PrinterColumn>,
): ColumnId[] {
  const hidden = hiddenColumns(prefs, kind, available, printerById);
  return available.filter((id) => !hidden.has(id));
}

export function toggleColumnHidden(
  prefs: ColumnPrefs,
  kind: string,
  available: ColumnId[],
  id: ColumnId,
  printerById?: Map<string, PrinterColumn>,
): ColumnPrefs {
  const meta = metaForColumn(id, printerById);
  if (!meta.hideable || !available.includes(id)) return prefs;

  if (isPrinterColumnId(id)) {
    const enabled = enabledPrinterSet(prefs);
    if (enabled.has(id)) enabled.delete(id);
    else enabled.add(id);
    return {
      ...prefs,
      enabledPrinterColumns: [...enabled].sort(),
    };
  }

  const hidden = hiddenColumns(prefs, kind, available, printerById);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  // Keep at least the non-hideable columns visible (name).
  const stillVisible = available.some((c) => !hidden.has(c));
  if (!stillVisible) return prefs;
  return {
    ...prefs,
    hiddenByKind: {
      ...prefs.hiddenByKind,
      [kind]: available.filter((c) => !isPrinterColumnId(c) && hidden.has(c)),
    },
  };
}

export function setColumnWidth(
  prefs: ColumnPrefs,
  id: ColumnId,
  px: number,
  printerById?: Map<string, PrinterColumn>,
): ColumnPrefs {
  const meta = metaForColumn(id, printerById);
  const next = Math.max(meta.minPx, Math.round(px));
  return {
    ...prefs,
    widths: { ...prefs.widths, [id]: next },
  };
}

function columnTrack(
  id: ColumnId,
  widths?: Partial<Record<string, number>>,
  printerById?: Map<string, PrinterColumn>,
): string {
  const meta = metaForColumn(id, printerById);
  const w = widths?.[id];
  if (typeof w === "number" && Number.isFinite(w)) {
    return `${Math.max(meta.minPx, Math.round(w))}px`;
  }
  return `minmax(${meta.minPx}px, ${meta.defaultFr}fr)`;
}

export function buildGridTemplate(
  visible: ColumnId[],
  widths?: Partial<Record<string, number>>,
  printerById?: Map<string, PrinterColumn>,
): string {
  return [CHECK_COL, ...visible.map((id) => columnTrack(id, widths, printerById))].join(" ");
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
      const hiddenByKind: Record<string, ColumnId[]> = {};
      for (const [kind, ids] of Object.entries(obj.hiddenByKind as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        hiddenByKind[kind] = ids.flatMap(expandStoredId);
      }
      prefs.hiddenByKind = hiddenByKind;
    }

    const enabled = new Set<ColumnId>();
    if (Array.isArray(obj.enabledPrinterColumns)) {
      for (const id of obj.enabledPrinterColumns.flatMap(expandStoredId)) {
        if (isPrinterColumnId(id)) enabled.add(id);
      }
    }
    // Migrate older per-kind map → global list.
    if (obj.enabledPrinterByKind && typeof obj.enabledPrinterByKind === "object") {
      for (const ids of Object.values(obj.enabledPrinterByKind as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids.flatMap(expandStoredId)) {
          if (isPrinterColumnId(id)) enabled.add(id);
        }
      }
    }
    if (enabled.size) prefs.enabledPrinterColumns = [...enabled].sort();

    if (obj.widths && typeof obj.widths === "object") {
      const widths: Partial<Record<string, number>> = {};
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

/** Index printer columns by their ColumnId (first wins on slug collision). */
export function printerColumnsById(columns: PrinterColumn[]): Map<string, PrinterColumn> {
  const map = new Map<string, PrinterColumn>();
  for (const col of columns) {
    if (shouldSkipPrinterColumn(col.name)) continue;
    const id = printerColumnId(col.name);
    if (!map.has(id)) map.set(id, col);
  }
  return map;
}

/** Whether any printer column lacks jsonPath (needs Table cell overlay). */
export function printerColumnsNeedTable(columns: PrinterColumn[]): boolean {
  return columns.some((c) => !shouldSkipPrinterColumn(c.name) && !c.jsonPath);
}
