import type { DiscoveredResource } from "../types";

export function apiGroupOf(apiVersion?: string | null, group?: string | null): string {
  if (group) return group;
  const av = apiVersion || "";
  const slash = av.indexOf("/");
  return slash >= 0 ? av.slice(0, slash) : "";
}

export function matchesApiGroup(apiVersion: string | null | undefined, apiGroup: string): boolean {
  return apiGroupOf(apiVersion).toLowerCase() === apiGroup.toLowerCase();
}

export function clusterHasApiGroup(
  discovered: { group?: string; apiVersion?: string }[] | undefined | null,
  apiGroup: string,
): boolean {
  if (!discovered?.length) return false;
  const want = apiGroup.toLowerCase();
  return discovered.some(
    (r) =>
      (r.group || "").toLowerCase() === want ||
      (r.apiVersion || "").toLowerCase().startsWith(`${want}/`),
  );
}

/** Prefer listed versions, else first discovered for kind+group. */
export function preferApiVersion(
  discovered: { group?: string; kind?: string; apiVersion?: string }[] | undefined | null,
  kind: string,
  apiGroup: string,
  prefer: string[],
): string | null {
  if (!discovered?.length) return null;
  const matches = discovered.filter(
    (r) =>
      r.kind === kind &&
      ((r.group || "").toLowerCase() === apiGroup.toLowerCase() ||
        (r.apiVersion || "").toLowerCase().startsWith(`${apiGroup.toLowerCase()}/`)),
  );
  if (!matches.length) return null;
  for (const ver of prefer) {
    const hit = matches.find((r) => (r.apiVersion || "").endsWith(`/${ver}`));
    if (hit?.apiVersion) return hit.apiVersion;
  }
  return matches[0]?.apiVersion || null;
}

export function resolveNavApiVersion(
  item: { kind: string; apiVersion: string; apiGroup: string },
  discovered: DiscoveredResource[] | undefined | null,
): string {
  const prefer = item.apiVersion.includes("/")
    ? [item.apiVersion.split("/")[1]!]
    : [item.apiVersion];
  return preferApiVersion(discovered, item.kind, item.apiGroup, prefer) || item.apiVersion;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
