import { Show } from "solid-js";

type Props = {
  label?: string;
  class?: string;
};

/** Shared loading indicator for resource lists, pickers, and overlays. */
export function LoadingSpinner(props: Props) {
  return (
    <div class={`loading-spinner ${props.class || ""}`} role="status" aria-live="polite">
      <span class="loading-spinner-icon" aria-hidden="true" />
      <Show when={props.label}>
        <span class="loading-spinner-label">{props.label}</span>
      </Show>
    </div>
  );
}
