import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import logo from "../assets/logo.png";
import {
  APP_AUTHOR,
  APP_COPYRIGHT,
  APP_GITHUB_LABEL,
  APP_GITHUB_URL,
  APP_LICENSE,
  APP_NAME,
  APP_TAGLINE,
} from "../constants/about";
import { telemetryStore } from "../stores/telemetry";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function AboutDialog(props: Props) {
  const [version, setVersion] = createSignal("…");

  onMount(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }

  createEscapeListener(() => props.open, onKey);

  async function openGithub() {
    try {
      await openUrl(APP_GITHUB_URL);
    } catch {
      window.open(APP_GITHUB_URL, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <Show when={props.open}>
      <div class="about-overlay" onClick={props.onClose} role="presentation">
        <section
          class="about-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="about-close"
            onClick={props.onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
          <div class="about-hero">
            <span class="about-mark-wrap">
              <img src={logo} class="about-mark" alt="" />
            </span>
            <h1 id="about-title">About {APP_NAME}</h1>
            <p class="about-tagline">{APP_TAGLINE}</p>
            <span class="about-version">Version {version()}</span>
          </div>

          <div class="about-credits">
            <div class="about-credits-label">Credits</div>
            <p>
              Created and maintained by
              <strong> {APP_AUTHOR}</strong>
            </p>
          </div>

          <button type="button" class="about-github" onClick={() => void openGithub()}>
            <GithubIcon />
            <span>
              <span class="about-github-kicker">Source &amp; issues</span>
              <span class="about-github-url">{APP_GITHUB_LABEL}</span>
            </span>
          </button>

          <div class="about-telemetry">
            <div class="about-credits-label">Privacy</div>
            <div class="about-telemetry-row">
              <p>Send crash reports to Sentry</p>
              <div class="theme-toggle" role="radiogroup" aria-label="Error reporting">
                <button
                  type="button"
                  role="radio"
                  class={`theme-toggle-btn ${telemetryStore.consent() === false ? "active" : ""}`}
                  aria-checked={telemetryStore.consent() === false}
                  onClick={() => telemetryStore.setConsent(false)}
                >
                  Off
                </button>
                <button
                  type="button"
                  role="radio"
                  class={`theme-toggle-btn ${telemetryStore.consent() === true ? "active" : ""}`}
                  aria-checked={telemetryStore.consent() === true}
                  onClick={() => telemetryStore.setConsent(true)}
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <p class="about-legal">
            {APP_COPYRIGHT} · {APP_LICENSE}
            <br />
            Kubernetes icons © The Kubernetes Authors
          </p>
        </section>
      </div>
    </Show>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 4.77c.68.003 1.36.092 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
      />
    </svg>
  );
}

function createEscapeListener(isOpen: () => boolean, handler: (e: KeyboardEvent) => void) {
  onMount(() => {
    const wrapped = (e: KeyboardEvent) => {
      if (isOpen()) handler(e);
    };
    window.addEventListener("keydown", wrapped);
    onCleanup(() => window.removeEventListener("keydown", wrapped));
  });
}
