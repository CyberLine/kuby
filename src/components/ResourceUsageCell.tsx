import { Show } from "solid-js";
import { formatBytes, formatCpu, percentTone } from "../utils/quantity";
import {
  type ResourceBudget,
  type ResourceQuantity,
  resourceTooltip,
  uncappedUsagePercent,
} from "../utils/resourceBudget";

function requestMarker(side: ResourceQuantity): number | null {
  if (side.request == null || side.limit == null || side.limit <= 0) return null;
  return Math.min(100, Math.max(0, (side.request / side.limit) * 100));
}

export function ResourceMeter(props: {
  heading: string;
  label?: string;
  side: ResourceQuantity;
  format: (n: number) => string;
  showLabel?: boolean;
}) {
  const againstLimit = () => uncappedUsagePercent(props.side.used, props.side.limit);
  const width = () => {
    const pct = againstLimit();
    if (pct == null) return null;
    return Math.min(100, pct);
  };
  const tone = () => percentTone(againstLimit());
  const marker = () => requestMarker(props.side);
  const usedText = () => props.format(props.side.used ?? 0);
  const hasUsage = () => props.side.used != null;

  return (
    <div
      class="res-meter"
      title={hasUsage() ? resourceTooltip(props.heading, props.side, props.format) : undefined}
    >
      <Show when={hasUsage()}>
        <Show when={props.showLabel}>
          <span class="res-meter-label">{props.label ?? props.heading}</span>
        </Show>
        <Show
          when={width() != null}
          fallback={
            <div class="usage-track res-meter-track res-meter-track-empty">
              <span class="res-meter-inline mono">{usedText()}</span>
            </div>
          }
        >
          <div class="usage-track res-meter-track">
            <div class={`usage-fill tone-${tone()}`} style={{ width: `${width() ?? 0}%` }} />
            <span class="res-meter-inline mono">{usedText()}</span>
            <Show when={marker() != null}>
              <span class="res-meter-request" style={{ left: `${marker()}%` }} />
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function ResourceUsageCell(props: { budget: ResourceBudget }) {
  return (
    <div class="res-usage">
      <ResourceMeter heading="CPU" side={props.budget.cpu} format={formatCpu} showLabel />
      <ResourceMeter
        heading="Memory"
        label="Mem"
        side={props.budget.memory}
        format={formatBytes}
        showLabel
      />
    </div>
  );
}
