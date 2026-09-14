import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

/**
 * Confirmation dialog that works in Tauri on macOS.
 * `window.confirm` is a silent no-op in WKWebView (always returns false).
 */
export async function confirmAction(message: string, title = "Kuby"): Promise<boolean> {
  try {
    return await tauriConfirm(message, { title, kind: "warning" });
  } catch (e) {
    console.warn("native confirm failed, falling back", e);
    return window.confirm(message);
  }
}
