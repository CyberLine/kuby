import * as Sentry from "@sentry/solid";
import { version } from "../package.json";
import { api } from "./api/tauri";

const DSN =
  "https://d9e43a5ce95be19fc2f20293fa2188b4@o4510487186571264.ingest.de.sentry.io/4512055874551888";

export async function applyTelemetry(enabled: boolean) {
  if (enabled) {
    if (!Sentry.getClient()) {
      Sentry.init({
        dsn: DSN,
        release: `kuby@${version}`,
        environment: import.meta.env.DEV ? "development" : "production",
        sendDefaultPii: false,
      });
    }
  } else if (Sentry.getClient()) {
    await Sentry.close();
  }

  try {
    await api.setTelemetryEnabled(enabled);
  } catch {
    /* browser preview without Tauri */
  }
}
