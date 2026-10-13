/** Minimal kubectl-style JSONPath for CRD additionalPrinterColumns. */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function asJson(v: unknown): Json {
  return v as Json;
}

function isObject(v: Json): v is { [k: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Strip leading `$` / `.` and split into path tokens (including `[…]` filters). */
export function tokenizeJsonPath(path: string): string[] {
  let p = path.trim();
  if (p.startsWith("$")) p = p.slice(1);
  if (p.startsWith(".")) p = p.slice(1);
  if (!p) return [];

  const tokens: string[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === ".") {
      i += 1;
      continue;
    }
    if (p[i] === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) break;
      tokens.push(p.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < p.length && p[j] !== "." && p[j] !== "[") j += 1;
    if (j > i) tokens.push(p.slice(i, j));
    i = j;
  }
  return tokens;
}

const FILTER_RE = /^\[\?\(@\.([A-Za-z0-9_]+)\s*==\s*(?:"([^"]*)"|'([^']*)')\)\]$/;
const INDEX_RE = /^\[(\d+)\]$/;

function applyFilter(arr: Json[], token: string): Json[] {
  const m = FILTER_RE.exec(token);
  if (!m) return [];
  const key = m[1];
  const want = m[2] ?? m[3] ?? "";
  return arr.filter((item) => isObject(item) && String(item[key] ?? "") === want);
}

function step(current: Json[], token: string): Json[] {
  const next: Json[] = [];
  for (const cur of current) {
    if (token.startsWith("[?")) {
      if (!Array.isArray(cur)) continue;
      next.push(...applyFilter(cur, token));
      continue;
    }
    const idx = INDEX_RE.exec(token);
    if (idx) {
      if (!Array.isArray(cur)) continue;
      const i = Number(idx[1]);
      if (i >= 0 && i < cur.length) next.push(cur[i]);
      continue;
    }
    if (isObject(cur) && token in cur) {
      next.push(cur[token]);
    }
  }
  return next;
}

function formatValue(v: Json | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    if (v.length === 1) return formatValue(v[0]);
    return v
      .map((x) => formatValue(x))
      .filter(Boolean)
      .join(",");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/**
 * Evaluate a simple JSONPath against a Kubernetes object.
 * Supports `.spec.replicas`, `.status.conditions[?(@.type=="Ready")].status`, `.items[0].name`.
 */
export function evalJsonPath(obj: unknown, path: string): string {
  if (!path || obj == null) return "";
  const tokens = tokenizeJsonPath(path);
  if (!tokens.length) return "";
  let current: Json[] = [asJson(obj)];
  for (const token of tokens) {
    current = step(current, token);
    if (!current.length) return "";
  }
  if (current.length === 1) return formatValue(current[0]);
  return current.map(formatValue).filter(Boolean).join(",");
}

/** Display helper: empty path results become an em dash for list cells. */
export function evalJsonPathCell(obj: unknown, path: string | null | undefined): string {
  if (!path) return "—";
  const v = evalJsonPath(obj, path);
  return v || "—";
}
