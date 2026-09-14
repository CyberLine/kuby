/** Kubernetes namespace names are DNS-1123 labels. */
export function isValidNamespaceName(name: string): boolean {
  return name.length >= 1 && name.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);
}

const EXTRA_NS_PREFIX = "kuby.extraNamespaces:";

export function loadExtraNamespaces(context: string): string[] {
  if (!context || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${EXTRA_NS_PREFIX}${encodeURIComponent(context)}`);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((n): n is string => typeof n === "string" && isValidNamespaceName(n)),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveExtraNamespaces(context: string, names: string[]): void {
  if (!context || typeof localStorage === "undefined") return;
  const key = `${EXTRA_NS_PREFIX}${encodeURIComponent(context)}`;
  const unique = [...new Set(names.filter(isValidNamespaceName))];
  if (!unique.length) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(unique));
}
