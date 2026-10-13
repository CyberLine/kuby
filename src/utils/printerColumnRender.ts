/** Heuristic rendering for dynamic kubectl/CRD printer columns. */

import type { PrinterColumn } from "../types";
import type { StatusTone } from "./conditions";

export type PrinterCellKind = "status" | "node" | "image" | "text";

export function classifyPrinterColumn(
  col: PrinterColumn | undefined,
  columnId: string,
): PrinterCellKind {
  const name = (col?.name || columnId.replace(/^printer:/, "")).trim().toLowerCase();
  const format = (col?.format || "").toLowerCase();

  if (
    name === "state" ||
    name === "status" ||
    name === "phase" ||
    name === "ready" ||
    name === "robustness" ||
    name.endsWith(" state") ||
    name.endsWith(" status") ||
    name.endsWith(" phase")
  ) {
    return "status";
  }
  if (
    name === "node" ||
    name === "nodename" ||
    name === "node name" ||
    (format === "name" && name.includes("node"))
  ) {
    return "node";
  }
  if (
    name === "image" ||
    name === "containerimage" ||
    name === "container image" ||
    name.endsWith(" image")
  ) {
    return "image";
  }
  return "text";
}

export function classifyPrinterColumnId(
  columnId: string,
  printerById?: Map<string, PrinterColumn>,
): PrinterCellKind {
  if (!columnId.startsWith("printer:")) return "text";
  return classifyPrinterColumn(printerById?.get(columnId), columnId);
}

/** Map free-text status/state values to the same badge tones used for pods. */
export function statusToneFromText(text: string): StatusTone {
  const lower = text.trim().toLowerCase();
  if (!lower || lower === "-" || lower === "—" || lower === "unknown" || lower === "n/a") {
    return "muted";
  }
  if (
    lower === "running" ||
    lower === "active" ||
    lower === "bound" ||
    lower === "succeeded" ||
    lower === "completed" ||
    lower === "healthy" ||
    lower === "schedulable" ||
    lower === "ready" ||
    lower === "true" ||
    lower === "attached" ||
    lower === "started" ||
    lower === "complete"
  ) {
    return "ok";
  }
  if (
    lower === "pending" ||
    lower.includes("backoff") ||
    lower === "degraded" ||
    lower === "in progress" ||
    lower === "unschedulable" ||
    lower === "detached" ||
    lower === "stopped" ||
    lower === "stopping" ||
    lower === "starting" ||
    lower === "creating" ||
    lower === "attaching" ||
    lower === "detaching" ||
    lower === "deleting" ||
    lower === "rebuilding" ||
    lower === "false"
  ) {
    return "warn";
  }
  if (
    lower === "failed" ||
    lower === "error" ||
    lower === "crashloopbackoff" ||
    lower === "imagepullbackoff" ||
    lower === "fault" ||
    lower === "faulted" ||
    lower === "down"
  ) {
    return "err";
  }
  if (lower === "terminating") return "warn";
  return "muted";
}

/**
 * Best-effort public browser URL for a container image reference.
 * Returns null when we shouldn't invent a link (digest-only, localhost, etc.).
 */
export function registryUrlForImage(image: string): string | null {
  const raw = image.trim();
  if (!raw || raw === "-" || raw === "—") return null;

  // Strip digest; keep tag for display but drop for URL path when needed.
  const withoutDigest = raw.split("@")[0] || raw;
  const parts = withoutDigest.split("/");
  if (parts.length < 2) {
    // docker hub official short name: nginx → library/nginx
    const name = withoutDigest.split(":")[0];
    if (!name) return null;
    return `https://hub.docker.com/r/_/${encodeURIComponent(name)}`;
  }

  const first = parts[0];
  const isRegistryHost = first.includes(".") || first.includes(":") || first === "localhost";
  if (!isRegistryHost) {
    // docker hub user/image
    const [user, ...rest] = parts;
    const repo = rest.join("/").split(":")[0];
    if (!user || !repo) return null;
    return `https://hub.docker.com/r/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`;
  }

  if (first === "localhost" || first.startsWith("localhost:") || first.startsWith("127.")) {
    return null;
  }

  const pathAndTag = parts.slice(1).join("/");
  const path = pathAndTag.split(":")[0];
  if (!path) return null;

  if (first === "docker.io" || first === "index.docker.io" || first === "registry-1.docker.io") {
    const segs = path.split("/");
    if (segs.length === 1) {
      return `https://hub.docker.com/r/_/${encodeURIComponent(segs[0])}`;
    }
    return `https://hub.docker.com/r/${segs.map(encodeURIComponent).join("/")}`;
  }
  if (first === "ghcr.io") {
    return `https://ghcr.io/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (first === "quay.io") {
    return `https://quay.io/repository/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (first === "gcr.io" || first.endsWith(".gcr.io") || first.endsWith(".pkg.dev")) {
    return `https://${first}/${path}`;
  }

  // Generic registry: open the HTTPS host (path often needs auth; still useful).
  return `https://${first}/${path}`;
}
