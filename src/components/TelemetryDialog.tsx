import { Show } from "solid-js";

type Props = {
  open: boolean;
  onAllow: () => void;
  onDecline: () => void;
};

export function TelemetryDialog(props: Props) {
  return (
    <Show when={props.open}>
      <div class="about-overlay telemetry-overlay" role="presentation">
        <section
          class="about-dialog telemetry-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="telemetry-title"
          aria-describedby="telemetry-copy"
        >
          <h1 id="telemetry-title">Error reporting</h1>
          <p id="telemetry-copy" class="about-tagline telemetry-copy">
            Kuby can send crash and error reports to Sentry (EU) so bugs can be fixed faster.
            Reports include stack traces, app version, and OS information. Kubeconfig, tokens, and
            cluster credentials are not sent. Nothing is transmitted unless you allow it.
          </p>
          <p class="about-legal">
            Your choice is stored on this device. You can change it later in About.
          </p>
          <div class="telemetry-actions">
            <button type="button" class="btn" onClick={props.onDecline}>
              Don&apos;t send
            </button>
            <button type="button" class="btn primary" onClick={props.onAllow}>
              Allow reporting
            </button>
          </div>
        </section>
      </div>
    </Show>
  );
}
