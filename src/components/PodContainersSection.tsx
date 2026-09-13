import { createMemo, createSignal, For, Show } from "solid-js";
import type { K8sObject, PodMetrics } from "../types";
import {
  formatContainerPorts,
  type PodContainerKind,
  type PodContainerRow,
  podContainerGroups,
  readyLabel,
} from "../utils/podContainers";

type Props = {
  pod: K8sObject;
  metrics?: PodMetrics | null;
};

function ContainerTile(props: { row: PodContainerRow }) {
  const ready = () => readyLabel(props.row.ready);
  return (
    <article class="pod-container-tile">
      <div class="pod-container-tile-head">
        <span class="pod-container-tile-name mono" title={props.row.name}>
          {props.row.name}
        </span>
        <div class="status-labels">
          <span class={`status-label ${ready().tone}`}>{ready().text}</span>
          <span class={`status-label ${props.row.state.tone}`} title={props.row.state.text}>
            {props.row.state.text}
          </span>
        </div>
      </div>
      <dl class="pod-container-tile-meta">
        <div>
          <dt>Restarts</dt>
          <dd class="mono">{props.row.restartCount == null ? "—" : props.row.restartCount}</dd>
        </div>
        <div>
          <dt>CPU</dt>
          <dd class="mono">{props.row.cpu || "—"}</dd>
        </div>
        <div>
          <dt>Mem</dt>
          <dd class="mono">{props.row.memory || "—"}</dd>
        </div>
        <div class="pod-container-tile-wide">
          <dt>Image</dt>
          <dd class="mono" title={props.row.image}>
            {props.row.image}
          </dd>
        </div>
        <div class="pod-container-tile-wide">
          <dt>Ports</dt>
          <dd class="mono muted">{formatContainerPorts(props.row.ports)}</dd>
        </div>
      </dl>
    </article>
  );
}

export function PodContainersSection(props: Props) {
  const groups = createMemo(() =>
    podContainerGroups(props.pod as unknown as Record<string, unknown>, props.metrics?.containers),
  );

  /** Collapsed group kinds; empty = all expanded. Init starts collapsed. */
  const [collapsed, setCollapsed] = createSignal<Set<PodContainerKind>>(new Set(["init"]));

  function isCollapsed(kind: PodContainerKind): boolean {
    return collapsed().has(kind);
  }

  function toggleGroup(kind: PodContainerKind) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <Show when={groups().length > 0}>
      <section class="pod-containers">
        <For each={groups()}>
          {(group) => {
            const closed = () => isCollapsed(group.kind);
            return (
              <div class={`pod-container-group ${closed() ? "collapsed" : ""}`}>
                <button
                  type="button"
                  class="pod-container-group-toggle"
                  aria-expanded={!closed()}
                  onClick={() => toggleGroup(group.kind)}
                >
                  <svg class="pod-container-group-chevron" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M3 4.5 L6 8 L9 4.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span class="pod-container-group-title">{group.title}</span>
                  <span class="pod-container-group-count muted">{group.rows.length}</span>
                </button>
                <Show when={!closed()}>
                  <div class="pod-container-tiles">
                    <For each={group.rows}>{(row) => <ContainerTile row={row} />}</For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </section>
    </Show>
  );
}
