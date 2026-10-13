import { For, Show } from "solid-js";
import { type ConditionInfo, conditionTone, objectConditions } from "../../utils/conditions";

type Props = {
  obj: Record<string, unknown>;
  title?: string;
};

export function ConditionsSection(props: Props) {
  const conditions = () => objectConditions(props.obj);
  return (
    <Show when={conditions().length}>
      <section class="detail-block">
        <h3>{props.title || "Conditions"}</h3>
        <div class="status-labels crd-conditions">
          <For each={conditions()}>{(c) => <ConditionBadge condition={c} />}</For>
        </div>
        <table class="meta-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            <For each={conditions()}>
              {(c) => (
                <tr>
                  <td class="mono">{c.type}</td>
                  <td>
                    <span class={`status-label ${conditionTone(c)}`}>{c.status}</span>
                  </td>
                  <td class="mono">{c.reason || "—"}</td>
                  <td>{c.message || "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}

function ConditionBadge(props: { condition: ConditionInfo }) {
  const c = () => props.condition;
  return (
    <span class={`status-label ${conditionTone(c())}`} title={c().message || c().reason || ""}>
      {c().type}: {c().reason || c().status}
    </span>
  );
}
