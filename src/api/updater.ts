import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export type UpdateProgress = {
  phase: "checking" | "downloading" | "installing";
  version?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type UpdateCheckResult =
  | { status: "busy" }
  | { status: "up-to-date" }
  | { status: "skipped"; version: string }
  | { status: "installed"; version: string }
  | { status: "error"; message: string };

export type UpdateCheckHooks = {
  confirmInstall: (info: { currentVersion: string; version: string }) => Promise<boolean>;
  onProgress: (progress: UpdateProgress) => void;
};

const CHECK_TIMEOUT_MS = 20_000;

let inFlight = false;

/** Check GitHub latest.json, confirm, then download + install with progress. */
export async function checkForUpdates(hooks: UpdateCheckHooks): Promise<UpdateCheckResult> {
  if (inFlight) return { status: "busy" };
  inFlight = true;
  let update: Update | null = null;
  try {
    hooks.onProgress({ phase: "checking" });
    update = await check({ timeout: CHECK_TIMEOUT_MS });
    if (!update) return { status: "up-to-date" };
    const found = update;

    const accepted = await hooks.confirmInstall({
      currentVersion: found.currentVersion,
      version: found.version,
    });
    if (!accepted) return { status: "skipped", version: found.version };

    let downloaded = 0;
    let total: number | undefined;
    const reportDownload = () => {
      hooks.onProgress({
        phase: "downloading",
        version: found.version,
        downloadedBytes: downloaded,
        totalBytes: total,
      });
    };
    reportDownload();
    await found.download((event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
        downloaded = 0;
        reportDownload();
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        reportDownload();
      }
    });

    hooks.onProgress({ phase: "installing", version: found.version });
    await found.install();
    return { status: "installed", version: found.version };
  } catch (e) {
    return { status: "error", message: formatUpdaterError(e) };
  } finally {
    if (update) await update.close().catch(() => {});
    inFlight = false;
  }
}

export function formatUpdateProgress(progress: UpdateProgress): string {
  if (progress.phase === "checking") return "Checking for updates…";
  if (progress.phase === "installing") return `Installing ${progress.version}…`;
  const version = progress.version ?? "update";
  const total = progress.totalBytes;
  const downloaded = progress.downloadedBytes ?? 0;
  if (total && total > 0) {
    const pct = percentOf(downloaded, total);
    return `Downloading ${version}… ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`;
  }
  if (downloaded > 0) return `Downloading ${version}… ${formatBytes(downloaded)}`;
  return `Downloading ${version}…`;
}

export function updateProgressPercent(progress: UpdateProgress): number | null {
  if (progress.phase !== "downloading" || !progress.totalBytes) return null;
  return percentOf(progress.downloadedBytes ?? 0, progress.totalBytes);
}

function percentOf(downloaded: number, total: number): number {
  return Math.min(100, Math.round((downloaded / total) * 100));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdaterError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return String(e);
}
