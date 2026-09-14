/** Parse Kubernetes CPU quantities to millicores (same rules as Rust metrics.rs). */
export function parseCpuMillis(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const raw = String(s).trim();
  if (!raw) return null;
  if (raw.endsWith("n")) {
    const n = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.floor(n / 1_000_000) : null;
  }
  if (raw.endsWith("u")) {
    const n = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.floor(n / 1_000) : null;
  }
  if (raw.endsWith("m")) {
    const n = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.floor(n * 1000) : null;
}

/** Parse Kubernetes memory/storage quantities to bytes. */
export function parseMemoryBytes(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const raw = String(s).trim();
  if (!raw) return null;
  const units: [string, number][] = [
    ["Ki", 1024],
    ["Mi", 1024 ** 2],
    ["Gi", 1024 ** 3],
    ["Ti", 1024 ** 4],
    ["Pi", 1024 ** 5],
    ["K", 1000],
    ["M", 1000 ** 2],
    ["G", 1000 ** 3],
    ["T", 1000 ** 4],
    ["P", 1000 ** 5],
  ];
  for (const [suf, mul] of units) {
    if (raw.endsWith(suf)) {
      const n = Number.parseFloat(raw.slice(0, -suf.length));
      return Number.isFinite(n) ? Math.floor(n * mul) : null;
    }
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export function formatCpu(millis: number | null | undefined): string {
  if (millis == null || !Number.isFinite(millis)) return "—";
  if (millis >= 1000) {
    const cores = millis / 1000;
    return cores >= 10 ? `${Math.round(cores)}` : `${cores.toFixed(2).replace(/\.?0+$/, "")}`;
  }
  return `${Math.round(millis)}m`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)}Ti`;
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}Gi`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}Mi`;
  if (abs >= 1024) return `${(n / 1024).toFixed(1)}Ki`;
  return `${Math.round(n)}`;
}

/** Usage percent clamped to [0, 100]; null when either side is missing. */
export function usagePercent(
  used: number | null | undefined,
  capacity: number | null | undefined,
): number | null {
  if (used == null || capacity == null || !Number.isFinite(used) || !Number.isFinite(capacity)) {
    return null;
  }
  if (capacity <= 0) return null;
  return Math.min(100, Math.max(0, (used / capacity) * 100));
}

export function percentTone(percent: number | null | undefined): "ok" | "warn" | "err" | "muted" {
  if (percent == null || !Number.isFinite(percent)) return "muted";
  if (percent >= 95) return "err";
  if (percent >= 80) return "warn";
  return "ok";
}
