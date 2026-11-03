import type { K8sObject } from "../types";

export type NpLink = {
  apiVersion: string;
  kind: "Pod" | "Namespace";
  namespace: string | null;
  name?: string;
  labelSelector?: Record<string, string>;
  title: string;
};

export type NpSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; link: NpLink };

export type NpRule = {
  segments: NpSegment[];
};

export type NpDirectionMode = "unaffected" | "deny" | "allow-all" | "rules";

export type NpDirection = {
  id: "ingress" | "egress";
  title: "Ingress" | "Egress";
  mode: NpDirectionMode;
  tone: "ok" | "err" | "idle";
  badge: string;
  detail: string;
  rules: NpRule[];
};

export type NetworkPolicyView = {
  target: NpSegment[];
  effect: string;
  policyTypesLabel: string;
  directions: NpDirection[];
};

type SelectorModel = {
  all: boolean;
  lines: string[];
  /** Equality labels when the selector can be used as a list filter. Null when expressions make that incomplete. */
  labelFilter: Record<string, string> | null;
};

type PeerModel =
  | { kind: "ip"; cidr: string; except: string[] }
  | { kind: "pods"; pods: SelectorModel | null; namespaces: SelectorModel | null }
  | { kind: "invalid"; detail: string };

type RuleModel = {
  anyPeer: boolean;
  peers: PeerModel[];
  anyPort: boolean;
  ports: string[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function flattenSegments(segments: NpSegment[]): string {
  return segments.map((s) => s.text).join("");
}

function joinSegments(groups: NpSegment[][], separator: string): NpSegment[] {
  const out: NpSegment[] = [];
  groups.forEach((group, i) => {
    if (i > 0) out.push({ kind: "text", text: separator });
    out.push(...group);
  });
  return out;
}

function formatExpr(key: string, operator: string, values: string[]): string {
  if (operator === "Exists") return `${key} exists`;
  if (operator === "DoesNotExist") return `${key} does not exist`;
  if (operator === "In") return `${key} in (${values.join(", ")})`;
  if (operator === "NotIn") return `${key} not in (${values.join(", ")})`;
  if (values.length) return `${key} ${operator} (${values.join(", ")})`;
  return `${key} ${operator}`.trim();
}

function parseSelector(raw: unknown): SelectorModel {
  const rec = asRecord(raw) ?? {};
  const matchLabelsRaw = asRecord(rec.matchLabels) ?? {};
  const matchLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(matchLabelsRaw)) {
    if (typeof value === "string") matchLabels[key] = value;
  }
  const lines = Object.entries(matchLabels).map(([key, value]) => `${key}=${value}`);
  const exprs = Array.isArray(rec.matchExpressions) ? rec.matchExpressions : [];
  let expressions = 0;
  for (const item of exprs) {
    const expr = asRecord(item);
    if (!expr || typeof expr.key !== "string") continue;
    expressions += 1;
    const operator = typeof expr.operator === "string" ? expr.operator : "";
    const values = Array.isArray(expr.values)
      ? expr.values.filter((value): value is string => typeof value === "string")
      : [];
    lines.push(formatExpr(expr.key, operator, values));
  }
  return {
    all: lines.length === 0,
    lines,
    labelFilter: expressions === 0 ? matchLabels : null,
  };
}

function parsePeer(raw: unknown): PeerModel {
  const rec = asRecord(raw);
  if (!rec) return { kind: "invalid", detail: "empty peer" };
  const ip = asRecord(rec.ipBlock);
  const hasPods = rec.podSelector !== undefined;
  const hasNamespaces = rec.namespaceSelector !== undefined;
  if (ip && (hasPods || hasNamespaces)) {
    return { kind: "invalid", detail: "ipBlock combined with a selector" };
  }
  if (ip) {
    const cidr = typeof ip.cidr === "string" ? ip.cidr : "";
    if (!cidr) return { kind: "invalid", detail: "ipBlock without a CIDR" };
    const except = Array.isArray(ip.except)
      ? ip.except.filter((value): value is string => typeof value === "string")
      : [];
    return { kind: "ip", cidr, except };
  }
  if (!hasPods && !hasNamespaces) return { kind: "invalid", detail: "peer selects nothing" };
  return {
    kind: "pods",
    pods: hasPods ? parseSelector(rec.podSelector) : null,
    namespaces: hasNamespaces ? parseSelector(rec.namespaceSelector) : null,
  };
}

function formatPort(port: Record<string, unknown>): string {
  const protocol = typeof port.protocol === "string" && port.protocol ? port.protocol : "TCP";
  const value = port.port;
  const hasPort = typeof value === "number" || (typeof value === "string" && value !== "");
  if (!hasPort) return `any ${protocol} port`;
  if (typeof value === "number" && typeof port.endPort === "number") {
    return `${protocol} ${value}–${port.endPort}`;
  }
  return `${protocol} ${value}`;
}

function parsePorts(raw: unknown): { any: boolean; ports: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { any: true, ports: [] };
  const ports = raw.flatMap((item) => {
    const rec = asRecord(item);
    return rec ? [formatPort(rec)] : [];
  });
  if (!ports.length) return { any: true, ports: [] };
  return { any: false, ports };
}

function parseRules(raw: unknown, peerKey: "from" | "to"): RuleModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const rec = asRecord(item) ?? {};
    const peerField = rec[peerKey];
    const anyPeer = !Array.isArray(peerField) || peerField.length === 0;
    const ports = parsePorts(rec.ports);
    return {
      anyPeer,
      peers: anyPeer ? [] : (peerField as unknown[]).map(parsePeer),
      anyPort: ports.any,
      ports: ports.ports,
    };
  });
}

function podLink(
  namespace: string | null,
  labels: Record<string, string> | null,
  title: string,
): NpLink {
  const link: NpLink = { apiVersion: "v1", kind: "Pod", namespace, title };
  if (labels && Object.keys(labels).length) link.labelSelector = labels;
  return link;
}

function namespaceLink(labels: Record<string, string> | null, title: string): NpLink {
  const link: NpLink = { apiVersion: "v1", kind: "Namespace", namespace: null, title };
  if (labels && Object.keys(labels).length) link.labelSelector = labels;
  return link;
}

function namespaceNameLink(namespace: string): NpLink {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    namespace: null,
    name: namespace,
    title: `Namespace/${namespace}`,
  };
}

function whereSegments(namespace: string | null): NpSegment[] {
  if (!namespace) return [{ kind: "text", text: "this namespace" }];
  return [{ kind: "link", text: namespace, link: namespaceNameLink(namespace) }];
}

function labelSegments(selector: SelectorModel): NpSegment[] {
  return joinSegments(
    selector.lines.map((line) => [{ kind: "code", text: line }]),
    " and ",
  );
}

function podsInPolicyNamespace(selector: SelectorModel, namespace: string | null): NpSegment[] {
  const head: NpSegment = selector.labelFilter
    ? {
        kind: "link",
        text: selector.all ? "any pod" : "pods",
        link: podLink(namespace, selector.labelFilter, selector.all ? "All pods" : "Selected pods"),
      }
    : { kind: "text", text: selector.all ? "any pod" : "pods" };
  const out: NpSegment[] = [head, { kind: "text", text: " in " }, ...whereSegments(namespace)];
  if (!selector.all) {
    out.push({ kind: "text", text: " labeled " }, ...labelSegments(selector));
  }
  return out;
}

function crossNamespacePeers(pods: SelectorModel | null, namespaces: SelectorModel): NpSegment[] {
  const out: NpSegment[] = [];
  if (!pods || pods.all) {
    out.push({ kind: "text", text: "any pod in " });
  } else {
    out.push({ kind: "text", text: "pods labeled " }, ...labelSegments(pods), {
      kind: "text",
      text: " in ",
    });
  }
  if (namespaces.all) {
    out.push(
      namespaces.labelFilter
        ? { kind: "link", text: "any namespace", link: namespaceLink(null, "Namespaces") }
        : { kind: "text", text: "any namespace" },
    );
    return out;
  }
  out.push(
    namespaces.labelFilter
      ? {
          kind: "link",
          text: "namespaces",
          link: namespaceLink(namespaces.labelFilter, "Namespaces"),
        }
      : { kind: "text", text: "namespaces" },
    { kind: "text", text: " labeled " },
    ...labelSegments(namespaces),
  );
  return out;
}

function peerSegments(peer: PeerModel, namespace: string | null): NpSegment[] {
  if (peer.kind === "ip") {
    const out: NpSegment[] = [{ kind: "code", text: peer.cidr }];
    if (peer.except.length) {
      out.push({ kind: "text", text: " except " }, { kind: "code", text: peer.except.join(", ") });
    }
    return out;
  }
  if (peer.kind === "invalid") return [{ kind: "text", text: peer.detail }];
  if (!peer.namespaces) {
    return podsInPolicyNamespace(peer.pods ?? { all: true, lines: [], labelFilter: {} }, namespace);
  }
  return crossNamespacePeers(peer.pods, peer.namespaces);
}

function ruleSegments(
  direction: "ingress" | "egress",
  rule: RuleModel,
  namespace: string | null,
): NpSegment[] {
  const out: NpSegment[] = [{ kind: "text", text: "Allow " }];
  if (rule.anyPort) out.push({ kind: "text", text: "any port" });
  else
    out.push(
      ...joinSegments(
        rule.ports.map((port) => [{ kind: "code" as const, text: port }]),
        " or ",
      ),
    );
  out.push({ kind: "text", text: direction === "ingress" ? " from " : " to " });
  if (rule.anyPeer) out.push({ kind: "text", text: "anywhere" });
  else
    out.push(
      ...joinSegments(
        rule.peers.map((peer) => peerSegments(peer, namespace)),
        " or ",
      ),
    );
  out.push({ kind: "text", text: "." });
  return out;
}

function targetSegments(selector: SelectorModel, namespace: string | null): NpSegment[] {
  const head: NpSegment = selector.labelFilter
    ? {
        kind: "link",
        text: selector.all ? "All pods" : "Pods",
        link: podLink(namespace, selector.labelFilter, selector.all ? "All pods" : "Selected pods"),
      }
    : { kind: "text", text: selector.all ? "All pods" : "Pods" };
  const out: NpSegment[] = [head, { kind: "text", text: " in " }, ...whereSegments(namespace)];
  if (!selector.all) out.push({ kind: "text", text: " labeled " }, ...labelSegments(selector));
  return out;
}

function effectClause(name: "Ingress" | "Egress", direction: NpDirection): string {
  switch (direction.mode) {
    case "unaffected":
      return `${name} is not affected.`;
    case "deny":
      return `${name} is denied.`;
    case "allow-all":
      return name === "Ingress"
        ? "Ingress is allowed from anywhere."
        : "Egress is allowed to anywhere.";
    case "rules":
      return direction.rules.length === 1
        ? `${name} has 1 allow rule.`
        : `${name} has ${direction.rules.length} allow rules.`;
  }
}

function buildDirection(
  id: "ingress" | "egress",
  affected: boolean,
  rawRules: unknown,
  namespace: string | null,
): NpDirection {
  const title = id === "ingress" ? "Ingress" : "Egress";
  if (!affected) {
    return {
      id,
      title,
      mode: "unaffected",
      tone: "idle",
      badge: "Not set",
      detail:
        id === "ingress"
          ? "Ingress is not selected. Inbound traffic is unchanged by this policy."
          : "Egress is not selected. Outbound traffic is unchanged by this policy.",
      rules: [],
    };
  }
  const rules = parseRules(rawRules, id === "ingress" ? "from" : "to");
  if (rules.length === 0) {
    return {
      id,
      title,
      mode: "deny",
      tone: "err",
      badge: "Deny all",
      detail:
        id === "ingress"
          ? "No ingress rules. This policy allows no inbound traffic. Another policy on the same pods can still allow some."
          : "No egress rules. This policy allows no outbound traffic. Another policy on the same pods can still allow some.",
      rules: [],
    };
  }
  if (rules.some((rule) => rule.anyPeer && rule.anyPort)) {
    return {
      id,
      title,
      mode: "allow-all",
      tone: "ok",
      badge: "Allow all",
      detail:
        rules.length > 1
          ? "One rule matches every peer and port. Because rules are combined with OR, the other rules add nothing."
          : id === "ingress"
            ? "Every source and port is allowed, so this policy does not restrict ingress."
            : "Every destination and port is allowed, so this policy does not restrict egress.",
      rules: [],
    };
  }
  return {
    id,
    title,
    mode: "rules",
    tone: "ok",
    badge: rules.length === 1 ? "1 rule" : `${rules.length} rules`,
    detail:
      id === "ingress"
        ? "A connection is allowed when it matches any rule. Inside a rule, one source and one port are enough."
        : "A connection is allowed when it matches any rule. Inside a rule, one destination and one port are enough.",
    rules: rules.map((rule) => ({ segments: ruleSegments(id, rule, namespace) })),
  };
}

/** Turn a NetworkPolicy object into the sentences shown in the detail panel. */
export function parseNetworkPolicy(obj: K8sObject): NetworkPolicyView {
  const spec = asRecord(obj.spec) ?? {};
  const namespace =
    typeof obj.metadata?.namespace === "string"
      ? obj.metadata.namespace
      : typeof obj.namespace === "string"
        ? obj.namespace
        : null;
  const explicit = Array.isArray(spec.policyTypes)
    ? spec.policyTypes.filter(
        (value): value is "Ingress" | "Egress" => value === "Ingress" || value === "Egress",
      )
    : null;
  const types = explicit ?? (spec.egress !== undefined ? ["Ingress", "Egress"] : ["Ingress"]);
  const ingress = buildDirection("ingress", types.includes("Ingress"), spec.ingress, namespace);
  const egress = buildDirection("egress", types.includes("Egress"), spec.egress, namespace);
  const target = parseSelector(spec.podSelector);
  return {
    target: targetSegments(target, namespace),
    effect: `${effectClause("Ingress", ingress)} ${effectClause("Egress", egress)}`,
    policyTypesLabel: explicit
      ? `policyTypes: ${explicit.join(", ") || "—"}`
      : `No policyTypes field, treated as ${types.join(", ")}`,
    directions: [ingress, egress],
  };
}

export function networkPolicyText(view: NetworkPolicyView): string {
  const rules = view.directions.flatMap((direction) =>
    direction.rules.map((rule) => flattenSegments(rule.segments)),
  );
  return [flattenSegments(view.target), view.effect, view.policyTypesLabel, ...rules].join("\n");
}
