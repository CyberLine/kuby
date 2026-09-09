import { check } from "@tauri-apps/plugin-updater";

/** Optional auto-update check (Phase 5). Safe to call; no-ops if unsigned/dev. */
export async function checkForUpdates(): Promise<string> {
  try {
    const update = await check();
    if (!update) return "Up to date";
    await update.downloadAndInstall();
    return `Downloaded ${update.version}. Restart Kuby to apply.`;
  } catch (e) {
    return `Updater: ${String(e)}`;
  }
}
