import { createEffect, createSignal, For, Show } from "solid-js";
import { api } from "../api/tauri";
import type { OverviewCard, OverviewOpenTarget, WorkloadOverview } from "../types";
import { LoadingSpinner } from "./LoadingSpinner";

type Props = {
  context: string;
  namespaces: string[];
  onOpenResource?: (target: OverviewOpenTarget) => void;
  onOpenSegment?: (kind: string, statusLabel: string) => void;
};

export function OverviewView(props: Props) {
  const [data, setData] = createSignal<WorkloadOverview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [threshold, setThreshold] = createSignal(0.95);

  async function load(context: string, namespaces: string[], thr: number) {
    if (!context) return;
    setLoading(true);
    setError(null);
    try {
      const ns = namespaces.length ? [...namespaces] : ["*"];
      const overview = await api.getWorkloadOverview(context, ns, thr);
      setData(overview);
    } catch (e) {
      setData(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    const context = props.context;
    const namespaces = [...(props.namespaces || [])];
    const thr = threshold();
    void load(context, namespaces, thr);
  });

  const totalResources = () => (data()?.cards || []).reduce((sum, c) => sum + (c.total || 0), 0);

  return (
    <div class="overview">
      <header class="overview-header">
        <div>
          <h1>Workload Overview</h1>
          <p class="muted">
            {props.context || "—"}
            {" · "}
            {props.namespaces.includes("*")
              ? "all namespaces"
              : props.namespaces.join(", ") || "default"}
          </p>
        </div>
        <div class="overview-header-actions">
          <select
            value={String(threshold())}
            onChange={(e) => setThreshold(Number(e.currentTarget.value))}
          >
            <option value="0.8">80% of Limit</option>
            <option value="0.9">90% of Limit</option>
            <option value="0.95">95% of Limit</option>
            <option value="1">100% of Limit</option>
          </select>
          <button
            class="btn"
            disabled={loading() || !props.context}
            onClick={() => load(props.context, [...(props.namespaces || [])], threshold())}
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
          <LoadingSpinner label="Loading overview…" />
        </div>
      </Show>

      <Show when={data()}>
        {(ov) => (
          <>
            <Show when={totalResources() === 0}>
              <div class="banner">
                No workload resources found for this selection. Pick more namespaces (or All
                namespaces) in the sidebar.
              </div>
            </Show>

            <section class="overview-cards">
              <For each={ov().cards}>
                {(card) => <StatusCard card={card} onSegmentClick={props.onOpenSegment} />}
              </For>
            </section>

            <section class="overview-split">
              <div class="overview-panel">
                <h2>Recent Warnings</h2>
                <Show when={ov().warnings.length} fallback={<div class="empty">No warnings</div>}>
                  <ul class="overview-list">
                    <For each={ov().warnings}>
                      {(w) => (
                        <li>
                          <div class="overview-list-main">
                            <span
                              class={`tone-badge tone-${w.reason.includes("Fail") ? "err" : "warn"}`}
                            >
                              {w.reason}
                              {` (${w.count}x)`}
                            </span>
                          </div>
                          <div class="overview-list-meta">
                            <Show
                              when={
                                w.involvedName &&
                                w.involvedName !== "?" &&
                                w.involvedKind &&
                                w.involvedKind !== "?"
                              }
                              fallback={<span class="mono muted">{w.involved}</span>}
                            >
                              <button
                                type="button"
                                class="linkish mono"
                                title={
                                  w.message ? `${w.involved} — ${w.message}` : `Open ${w.involved}`
                                }
                                onClick={() =>
                                  props.onOpenResource?.({
                                    kind: w.involvedKind,
                                    name: w.involvedName,
                                    namespace: w.involvedNamespace,
                                    apiVersion: w.involvedApiVersion,
                                  })
                                }
                              >
                                {w.involvedNamespace
                                  ? `${w.involvedNamespace} / ${w.involved}`
                                  : w.involved}
                              </button>
                            </Show>
                            <span class="muted">{w.age}</span>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>

              <div class="overview-panel">
                <h2>Recent Restarts</h2>
                <Show
                  when={ov().restarts.length}
                  fallback={<div class="empty">No recent restarts</div>}
                >
                  <ul class="overview-list">
                    <For each={ov().restarts}>
                      {(r) => (
                        <li>
                          <div class="overview-list-main">
                            <button
                              class="linkish"
                              onClick={() =>
                                props.onOpenResource?.({
                                  kind: "Pod",
                                  apiVersion: "v1",
                                  namespace: r.namespace,
                                  name: r.pod,
                                })
                              }
                            >
                              {r.namespace} / {r.pod}
                            </button>
                          </div>
                          <div class="overview-list-meta">
                            <span class="tone-badge tone-err">
                              {r.reason}
                              {r.exitCode != null ? ` (ExitCode: ${r.exitCode})` : ""}
                              {` (${r.restartCount}x)`}
                            </span>
                            <span class="muted">{r.age}</span>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </section>

            <section class="overview-panel">
              <div class="overview-panel-head">
                <h2>Abnormal Resource Usage</h2>
                <span class="muted">{Math.round(threshold() * 100)}% of Limit</span>
              </div>
              <Show
                when={ov().usage.length}
                fallback={<div class="empty">No containers above threshold</div>}
              >
                <table class="overview-table">
                  <thead>
                    <tr>
                      <th>Context</th>
                      <th>Pod</th>
                      <th>Container</th>
                      <th>CPU</th>
                      <th>Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={ov().usage}>
                      {(u) => (
                        <tr>
                          <td class="mono">{u.context}</td>
                          <td>
                            <button
                              class="linkish"
                              onClick={() =>
                                props.onOpenResource?.({
                                  kind: "Pod",
                                  apiVersion: "v1",
                                  namespace: u.namespace,
                                  name: u.pod,
                                })
                              }
                            >
                              {u.namespace} / {u.pod}
                            </button>
                          </td>
                          <td class="mono">{u.container}</td>
                          <td>
                            <UsageBar value={u.cpu} percent={u.cpuPercent} />
                          </td>
                          <td>
                            <UsageBar value={u.memory} percent={u.memoryPercent} />
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}

function StatusCard(props: {
  card: OverviewCard;
  onSegmentClick?: (kind: string, label: string) => void;
}) {
  const total = () =>
    props.card.segments.reduce((sum, s) => sum + s.count, 0) || props.card.total || 1;

  return (
    <article class="status-card">
      <h3>
        <button
          type="button"
          class="linkish status-card-title"
          onClick={() => props.onSegmentClick?.(props.card.kind, "")}
          title={`Open all ${props.card.kind}`}
        >
          {props.card.kind}
          <span class="muted"> · {props.card.total}</span>
        </button>
      </h3>
      <div class="status-bar">
        <For each={props.card.segments}>
          {(seg) => (
            <button
              type="button"
              class={`status-seg tone-${seg.tone}`}
              style={{ width: `${(seg.count / total()) * 100}%` }}
              title={`${seg.label}: ${seg.count} — open filtered list`}
              onClick={() => props.onSegmentClick?.(props.card.kind, seg.label)}
            />
          )}
        </For>
      </div>
      <ul class="status-legend">
        <Show when={props.card.segments.length} fallback={<li class="muted">None</li>}>
          <For each={props.card.segments}>
            {(seg) => (
              <li>
                <button
                  type="button"
                  class="linkish status-legend-btn"
                  onClick={() => props.onSegmentClick?.(props.card.kind, seg.label)}
                >
                  <span class={`dot tone-${seg.tone}`} />
                  {seg.count} {seg.label}
                </button>
              </li>
            )}
          </For>
        </Show>
      </ul>
    </article>
  );
}

function UsageBar(props: { value: string; percent: number }) {
  const pct = () => Math.min(100, Math.max(0, props.percent));
  const tone = () => (props.percent >= 95 ? "err" : props.percent >= 80 ? "warn" : "ok");
  return (
    <div class="usage-cell">
      <span class="mono">{props.value}</span>
      <div class="usage-track">
        <div class={`usage-fill tone-${tone()}`} style={{ width: `${pct()}%` }} />
      </div>
    </div>
  );
}
