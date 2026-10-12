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
        // v11 replaced sendDefaultPii with dataCollection; keep the old restrictive defaults.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: {
            request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
            response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          },
          httpBodies: [],
          urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          graphQL: { document: false, variables: false },
        },
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
