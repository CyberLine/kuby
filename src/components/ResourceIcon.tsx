import { Show } from "solid-js";
import { resourceIconTitle, resourceIconUrl } from "../constants/resourceIcons";

type Props = {
  kind: string;
  class?: string;
};

/** Kubernetes community icon, or a simple glyph for Overview / unknown. */
export function ResourceIcon(props: Props) {
  const url = () => resourceIconUrl(props.kind);

  return (
    <span
      class={`resource-icon ${props.class || ""}`}
      title={resourceIconTitle(props.kind)}
      aria-hidden="true"
    >
      <Show
        when={url()}
        fallback={
          <Show
            when={props.kind === "Overview"}
            fallback={
              <span class="resource-icon-fallback">{(props.kind[0] || "?").toUpperCase()}</span>
            }
          >
            <svg viewBox="0 0 16 16" class="resource-icon-svg">
              <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
              <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.55" />
              <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.55" />
              <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.35" />
            </svg>
          </Show>
        }
      >
        {(src) => <img class="resource-icon-img" src={src()} alt="" draggable={false} />}
      </Show>
    </span>
  );
}
