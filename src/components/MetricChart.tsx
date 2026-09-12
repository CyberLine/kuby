import { createMemo, Show } from "solid-js";

export type MetricSample = {
  t: number;
  value: number;
};

type Props = {
  title: string;
  usedLabel: string;
  limitLabel: string;
  percent: number | null;
  tone: "ok" | "warn" | "err" | "muted";
  samples: MetricSample[];
  emptyHint?: string;
  height?: number;
};

function buildPath(samples: MetricSample[], width: number, height: number, padY: number) {
  if (samples.length < 2) return { line: "", area: "" };
  const values = samples.map((s) => s.value);
  let min = Math.min(...values, 0);
  let max = Math.max(...values, 1);
  // Keep charts readable as %-series: soft floor near 0–100 when values are small.
  if (max - min < 5) {
    min = Math.max(0, min - 2);
    max = Math.min(100, Math.max(min + 5, max + 2));
  }
  const span = max - min || 1;
  const usableH = height - padY * 2;
  const n = samples.length;
  const pts = samples.map((s, i) => {
    const x = (i / (n - 1)) * width;
    const y = padY + usableH - ((s.value - min) / span) * usableH;
    return { x, y };
  });
  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  return { line, area };
}

export function MetricChart(props: Props) {
  const height = () => props.height ?? 72;
  const width = 320;
  const padY = 6;

  const path = createMemo(() => buildPath(props.samples, width, height(), padY));
  const pct = createMemo(() =>
    props.percent == null ? null : Math.min(100, Math.max(0, props.percent)),
  );

  return (
    <article class={`metric-chart tone-${props.tone}`}>
      <div class="metric-chart-header">
        <span class="metric-chart-title">{props.title}</span>
        <Show when={pct() != null} fallback={<span class="muted mono">—</span>}>
          <span class={`mono tone-text-${props.tone}`}>{pct()!.toFixed(0)}%</span>
        </Show>
      </div>
      <div class="usage-track">
        <div class={`usage-fill tone-${props.tone}`} style={{ width: `${pct() ?? 0}%` }} />
      </div>
      <div class="metric-chart-values mono">
        <span>{props.usedLabel}</span>
        <span class="muted">/</span>
        <span>{props.limitLabel}</span>
      </div>
      <Show
        when={props.samples.length >= 2}
        fallback={
          <div class="metric-chart-empty muted" style={{ height: `${height()}px` }}>
            {props.emptyHint ?? "Collecting samples…"}
          </div>
        }
      >
        <svg
          class="metric-chart-svg"
          viewBox={`0 0 ${width} ${height()}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={props.title}
        >
          <path class="metric-chart-area" d={path().area} />
          <path class="metric-chart-line" d={path().line} fill="none" />
        </svg>
      </Show>
    </article>
  );
}
