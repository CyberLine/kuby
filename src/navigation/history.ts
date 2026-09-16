import { createSignal } from "solid-js";

/** Session navigation history for resource browsing (no URL router). */

export type NavMode = "list" | "detail" | "node" | "visualize" | "overview" | "longhorn";

export type NavOwnerFilter = { kind: string; name: string; uid?: string };

export type NavLocation = {
  context: string;
  namespaces: string[];
  kind: string;
  apiVersion: string;
  mode: NavMode;
  objectKey?: string | null;
  objectName?: string | null;
  viewingNodeName?: string | null;
  visualizeNamespace?: string | null;
  searchQuery?: string;
  labelFilter?: Record<string, string> | null;
  ownerFilter?: NavOwnerFilter | null;
  statusFilter?: string | null;
};

const MAX_DEPTH = 30;

export function locationLabel(loc: NavLocation): string {
  if (loc.mode === "visualize" && loc.visualizeNamespace) {
    return `Visualize · ${loc.visualizeNamespace}`;
  }
  if (loc.mode === "node" && loc.viewingNodeName) {
    return `Node/${loc.viewingNodeName}`;
  }
  if (loc.objectName) {
    return `${loc.kind}/${loc.objectName}`;
  }
  if (loc.mode === "overview") return "Overview";
  if (loc.mode === "longhorn") return "Longhorn";
  return loc.kind;
}

export function createNavHistory() {
  const [past, setPast] = createSignal<NavLocation[]>([]);

  function canBack(): boolean {
    return past().length > 0;
  }

  function peekBack(): NavLocation | null {
    const stack = past();
    return stack.length ? stack[stack.length - 1]! : null;
  }

  function push(loc: NavLocation) {
    setPast((prev) => {
      const next = [...prev, loc];
      return next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next;
    });
  }

  function back(): NavLocation | null {
    const stack = past();
    if (!stack.length) return null;
    const loc = stack[stack.length - 1]!;
    setPast(stack.slice(0, -1));
    return loc;
  }

  function clear() {
    setPast([]);
  }

  return { canBack, peekBack, push, back, clear, past };
}

export type NavHistory = ReturnType<typeof createNavHistory>;
