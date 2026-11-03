import { createMemo, For, Show } from "solid-js";
import type { K8sObject } from "../types";
import {
  type NetworkPolicyView,
  type NpLink,
  type NpSegment,
  parseNetworkPolicy,
} from "../utils/networkPolicy";
import type { RelationLink } from "../utils/relations";

type Props = {
  obj: K8sObject;
  openRelation: (link: RelationLink) => void;
};

function openParsedLink(openRelation: Props["openRelation"], link: NpLink) {
  openRelation({
    id: `np-${link.kind}-${link.title}-${link.name ?? ""}`,
    group: "Network",
    title: link.title,
    apiVersion: link.apiVersion,
    kind: link.kind,
    namespace: link.namespace,
    ...(link.name ? { name: link.name } : {}),
    ...(link.labelSelector ? { labelSelector: link.labelSelector } : {}),
  });
}

function Segments(props: { segments: NpSegment[]; onOpen: (link: NpLink) => void }) {
  return (
    <For each={props.segments}>
      {(segment) => {
        if (segment.kind === "link") {
          return (
            <button
              type="button"
              class="relation-link np-link"
              title={segment.link.title}
              onClick={() => props.onOpen(segment.link)}
            >
              {segment.text}
            </button>
          );
        }
        if (segment.kind === "code") return <code class="np-code">{segment.text}</code>;
        return <span>{segment.text}</span>;
      }}
    </For>
  );
}

function DirectionCard(props: {
  direction: NetworkPolicyView["directions"][number];
  onOpen: (link: NpLink) => void;
}) {
  const direction = () => props.direction;
  return (
    <div class={`np-card np-${direction().id} np-${direction().mode}`}>
      <div class="np-card-head">
        <h4>{direction().title}</h4>
        <span class={`tone-badge tone-${direction().tone}`}>{direction().badge}</span>
      </div>
      <p class="np-detail">{direction().detail}</p>
      <Show when={direction().rules.length > 0}>
        <div class="np-rules">
          <For each={direction().rules}>
            {(rule, index) => (
              <div class="np-rule-wrap">
                <Show when={index() > 0}>
                  <div class="np-or">or</div>
                </Show>
                <div class="np-rule">
                  <span class="np-rule-index">{index() + 1}</span>
                  <p class="np-sentence">
                    <Segments segments={rule.segments} onOpen={props.onOpen} />
                  </p>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function NetworkPolicyDetail(props: Props) {
  const view = createMemo(() => parseNetworkPolicy(props.obj));
  const onOpen = (link: NpLink) => openParsedLink(props.openRelation, link);

  return (
    <section class="detail-block np-policy">
      <h3>Network policy</h3>
      <div class="np-card">
        <div class="np-card-head">
          <h4>Applies to</h4>
        </div>
        <p class="np-sentence">
          <Segments segments={view().target} onOpen={onOpen} />
        </p>
        <p class="np-effect">{view().effect}</p>
        <p class="np-meta">{view().policyTypesLabel}</p>
      </div>
      <For each={view().directions}>
        {(direction) => <DirectionCard direction={direction} onOpen={onOpen} />}
      </For>
      <p class="np-footnote">
        Policies that select the same pods are added together: traffic is allowed when any of them
        allows it.
      </p>
    </section>
  );
}
