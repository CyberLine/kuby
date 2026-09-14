import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { api } from "../api/tauri";
import type { LonghornOverview, OverviewOpenTarget } from "../types";
import { formatBytes } from "../utils/quantity";
import { LoadingSpinner } from "./LoadingSpinner";

type Props = {
  context: string;
  onOpenResource?: (target: OverviewOpenTarget) => void;
  onOpenSegment?: (cardKind: "Volume" | "Node", statusLabel: string) => void;
};

type DashRow = {
  label: string;
  tone: string;
  value: number;
  display: string;
  clickable?: boolean;
};

const VOLUME_ROWS: { label: string; tone: string }[] = [
  { label: "Healthy", tone: "ok" },
  { label: "Degraded", tone: "warn" },
  { label: "In Progress", tone: "info" },
  { label: "Fault", tone: "err" },
  { label: "Detached", tone: "idle" },
];

const NODE_ROWS: { label: string; tone: string }[] = [
  { label: "Schedulable", tone: "ok" },
  { label: "Unschedulable", tone: "warn" },
  { label: "Down", tone: "err" },
  { label: "Disabled", tone: "idle" },
];

export function LonghornOverviewView(props: Props) {
  const [data, setData] = createSignal<LonghornOverview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function load(context: string) {
    if (!context) return;
    setLoading(true);
    setError(null);
    try {
      const overview = await api.getLonghornOverview(context);
      setData(overview);
    } catch (e) {
      setData(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    void load(props.context);
  });

  const volumeRows = createMemo((): DashRow[] => {
    const card = data()?.volume;
    const byLabel = new Map((card?.segments || []).map((s) => [s.label, s.count]));
    return VOLUME_ROWS.map((r) => {
      const value = byLabel.get(r.label) || 0;
      return { ...r, value, display: String(value), clickable: true };
    });
  });

  const nodeRows = createMemo((): DashRow[] => {
    const card = data()?.node;
    const byLabel = new Map((card?.segments || []).map((s) => [s.label, s.count]));
    return NODE_ROWS.map((r) => {
      const value = byLabel.get(r.label) || 0;
      return { ...r, value, display: String(value), clickable: true };
    });
  });

  const storageRows = createMemo((): DashRow[] => {
    const s = data()?.storage;
    if (!s) {
      return [
        { label: "Schedulable", tone: "ok", value: 0, display: formatBytes(0) },
        { label: "Reserved", tone: "warn", value: 0, display: formatBytes(0) },
        { label: "Used", tone: "info", value: 0, display: formatBytes(0) },
        { label: "Disabled", tone: "idle", value: 0, display: formatBytes(0) },
      ];
    }
    const schedulable = Math.max(0, s.available - s.reserved);
    const reserved = Math.max(0, s.reserved);
    const used = Math.max(0, s.scheduled);
    const disabled = Math.max(0, s.disabled);
    return [
      { label: "Schedulable", tone: "ok", value: schedulable, display: formatBytes(schedulable) },
      { label: "Reserved", tone: "warn", value: reserved, display: formatBytes(reserved) },
      { label: "Used", tone: "info", value: used, display: formatBytes(used) },
      { label: "Disabled", tone: "idle", value: disabled, display: formatBytes(disabled) },
    ];
  });

  const storageSchedulable = () => storageRows()[0]?.value || 0;
  const storageTotal = () => storageRows().reduce((sum, r) => sum + r.value, 0);

  return (
    <div class="overview longhorn-overview">
      <header class="overview-header">
        <div>
          <h1>Dashboard</h1>
          <p class="muted">{props.context || "—"} · Longhorn</p>
        </div>
        <div class="overview-header-actions">
          <button
            class="btn"
            disabled={loading() || !props.context}
            onClick={() => load(props.context)}
          >
            {loading() ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <Show when={error()}>
        <div class="banner err">{error()}</div>
      </Show>

      <Show when={loading() && !data()}>
        <div class="empty">
          <LoadingSpinner label="Loading Longhorn overview…" />
        </div>
      </Show>

      <Show when={data()}>
        {(ov) => (
          <>
            <Show when={ov().volume.total === 0 && ov().node.total === 0}>
              <div class="banner">
                No Longhorn volumes or nodes found. Confirm Longhorn is installed and your account
                can list <code>longhorn.io</code> resources.
              </div>
            </Show>

            <section class="lh-dash">
              <DashColumn
                rows={volumeRows()}
                totalLabel={`${ov().volume.total} Volumes`}
                totalValue={ov().volume.total}
                onRowClick={(label) => props.onOpenSegment?.("Volume", label)}
                onTotalClick={() => props.onOpenSegment?.("Volume", "")}
              />
              <DashColumn
                rows={storageRows()}
                totalLabel={`${formatBytes(storageSchedulable())} Storage Schedulable`}
                totalValue={storageTotal()}
                footerLabel="Total"
                footerValue={formatBytes(storageTotal())}
              />
              <DashColumn
                rows={nodeRows()}
                totalLabel={`${ov().node.total} Nodes`}
                totalValue={ov().node.total}
                onRowClick={(label) => props.onOpenSegment?.("Node", label)}
                onTotalClick={() => props.onOpenSegment?.("Node", "")}
              />
            </section>

            <section class="overview-panel">
              <h2>Recent Events</h2>
              <Show
                when={ov().events.length}
                fallback={<div class="empty">No Longhorn warnings</div>}
              >
                <ul class="overview-list">
                  <For each={ov().events}>
                    {(ev) => (
                      <li>
                        <div class="overview-list-main">
                          <span class="tone-badge tone-warn">
                            {ev.reason}
                            {ev.count > 1 ? ` (${ev.count}x)` : ""}
                          </span>
                          <Show when={ev.involvedName && ev.involvedName !== "?"}>
                            <button
                              class="linkish"
                              onClick={() =>
                                props.onOpenResource?.({
                                  kind: ev.involvedKind,
                                  apiVersion: ev.involvedApiVersion,
                                  namespace: ev.involvedNamespace,
                                  name: ev.involvedName,
                                })
                              }
                            >
                              {ev.involved}
                            </button>
                          </Show>
                        </div>
                        <div class="overview-list-meta">
                          <span class="muted" title={ev.message}>
                            {ev.message}
                          </span>
                          <span class="muted">{ev.age}</span>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}

function DashColumn(props: {
  rows: DashRow[];
  totalLabel: string;
  totalValue: number;
  footerLabel?: string;
  footerValue?: string;
  onRowClick?: (label: string) => void;
  onTotalClick?: () => void;
}) {
  const gaugeSegments = () =>
    props.rows.map((r) => ({ value: r.value, tone: r.tone, label: r.label }));

  return (
    <article class="lh-col">
      <Show
        when={props.onTotalClick}
        fallback={
          <div class="lh-gauge-wrap">
            <SemiGauge segments={gaugeSegments()} label={props.totalLabel} />
          </div>
        }
      >
        <button
          type="button"
          class="lh-gauge-wrap is-clickable"
          onClick={() => props.onTotalClick?.()}
          title={props.totalLabel}
        >
          <SemiGauge segments={gaugeSegments()} label={props.totalLabel} />
        </button>
      </Show>

      <table class="lh-table">
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <td>
                  <Show
                    when={row.clickable && props.onRowClick}
                    fallback={
                      <span class="lh-row-label">
                        <span class={`dot tone-${row.tone}`} />
                        {row.label}
                      </span>
                    }
                  >
                    <button
                      type="button"
                      class="linkish lh-row-label"
                      onClick={() => props.onRowClick?.(row.label)}
                    >
                      <span class={`dot tone-${row.tone}`} />
                      {row.label}
                    </button>
                  </Show>
                </td>
                <td class="lh-row-value mono">{row.display}</td>
              </tr>
            )}
          </For>
        </tbody>
        <tfoot>
          <tr>
            <td>{props.footerLabel || "Total"}</td>
            <td class="lh-row-value mono">
              {props.footerValue ?? String(Math.round(props.totalValue))}
            </td>
          </tr>
        </tfoot>
      </table>
    </article>
  );
}

/** Semi-circular status gauge matching Longhorn dashboard style. */
function SemiGauge(props: {
  segments: { value: number; tone: string; label: string }[];
  label: string;
}) {
  const R = 78;
  const CX = 100;
  const CY = 96;
  const STROKE = 14;
  const TRACK = Math.PI * R;

  const total = () =>
    Math.max(
      props.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
      0,
    );

  const arcs = () => {
    const sum = total();
    if (sum <= 0)
      return [] as { tone: string; offset: number; length: number; label: string; value: number }[];
    let offset = 0;
    const out: { tone: string; offset: number; length: number; label: string; value: number }[] =
      [];
    for (const seg of props.segments) {
      if (seg.value <= 0) continue;
      const length = (seg.value / sum) * TRACK;
      out.push({ tone: seg.tone, offset, length, label: seg.label, value: seg.value });
      offset += length;
    }
    return out;
  };

  // Split center label: first line = value+unit-ish, rest = caption
  const labelParts = () => {
    const raw = props.label.trim();
    const m = raw.match(/^(\S+)\s+(.+)$/);
    if (m) return { primary: m[1], secondary: m[2] };
    return { primary: raw, secondary: "" };
  };

  return (
    <svg class="lh-gauge" viewBox="0 0 200 118" aria-hidden="true">
      <path
        class="lh-gauge-track"
        d={semiPath(CX, CY, R)}
        fill="none"
        stroke-width={STROKE}
        stroke-linecap="butt"
      />
      <For each={arcs()}>
        {(arc) => (
          <path
            class={`lh-gauge-arc tone-${arc.tone}`}
            d={semiPath(CX, CY, R)}
            fill="none"
            stroke-width={STROKE}
            stroke-linecap="butt"
            stroke-dasharray={`${arc.length} ${TRACK}`}
            stroke-dashoffset={-arc.offset}
          >
            <title>
              {arc.label}: {arc.value}
            </title>
          </path>
        )}
      </For>
      <text class="lh-gauge-primary" x={CX} y={CY - 18} text-anchor="middle">
        {labelParts().primary}
      </text>
      <Show when={labelParts().secondary}>
        <text class="lh-gauge-secondary" x={CX} y={CY + 2} text-anchor="middle">
          {labelParts().secondary}
        </text>
      </Show>
    </svg>
  );
}

function semiPath(cx: number, cy: number, r: number): string {
  // Top semicircle from left (-180°) to right (0°)
  const x1 = cx - r;
  const x2 = cx + r;
  return `M ${x1} ${cy} A ${r} ${r} 0 0 1 ${x2} ${cy}`;
}
