import { createRoot, createSignal } from "solid-js";
import { applyTelemetry } from "../sentry";

const STORAGE_KEY = "kuby.telemetry";

export type TelemetryConsent = boolean | null;

function readConsent(): TelemetryConsent {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "on") return true;
    if (value === "off") return false;
  } catch {
    /* ignore */
  }
  return null;
}

function createTelemetryStore() {
  const [consent, setConsentState] = createSignal<TelemetryConsent>(readConsent());

  const initial = consent();
  if (initial !== null) {
    void applyTelemetry(initial);
  }

  function setConsent(enabled: boolean) {
    setConsentState(enabled);
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      /* ignore */
    }
    void applyTelemetry(enabled);
  }

  return { consent, setConsent };
}

export const telemetryStore = createRoot(createTelemetryStore);
