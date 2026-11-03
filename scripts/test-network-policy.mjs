/**
 * NetworkPolicy detail phrasing.
 * Run: node --experimental-strip-types scripts/test-network-policy.mjs
 */
import { networkPolicyText, parseNetworkPolicy } from "../src/utils/networkPolicy.ts";

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}\n got: ${JSON.stringify(actual)}\nwant: ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

const denyIngress = parseNetworkPolicy({
  metadata: { namespace: "prod" },
  spec: { podSelector: { matchLabels: { app: "db" } } },
});
assertEq(denyIngress.directions[0].mode, "deny", "missing ingress rules deny ingress");
assertEq(denyIngress.directions[1].mode, "unaffected", "omitted egress is not affected");
assertEq(
  networkPolicyText(denyIngress).split("\n")[0],
  "Pods in prod labeled app=db",
  "target pods",
);
assertEq(
  denyIngress.effect,
  "Ingress is denied. Egress is not affected.",
  "deny ingress effect",
);
assertEq(
  denyIngress.policyTypesLabel,
  "No policyTypes field, treated as Ingress",
  "default policy types",
);

const allowRules = parseNetworkPolicy({
  metadata: { namespace: "prod" },
  spec: {
    podSelector: {},
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      {
        from: [
          { podSelector: { matchLabels: { role: "frontend" } } },
          { ipBlock: { cidr: "172.17.0.0/16", except: ["172.17.1.0/24"] } },
        ],
        ports: [{ protocol: "TCP", port: 6379, endPort: 6380 }],
      },
      {
        from: [{ namespaceSelector: { matchLabels: { env: "prod" } }, podSelector: {} }],
        ports: [{ port: "metrics" }, { protocol: "UDP", port: 53 }],
      },
    ],
    egress: [
      {
        to: [{ namespaceSelector: { matchLabels: { team: "platform" } } }],
        ports: [{ protocol: "UDP" }],
      },
    ],
  },
});
assertEq(allowRules.directions[0].mode, "rules", "ingress rules");
assertEq(allowRules.directions[0].rules.length, 2, "two ingress rules");
assertEq(
  allowRules.directions[0].rules.map((rule) => rule.segments.map((s) => s.text).join("")).join(" | "),
  "Allow TCP 6379–6380 from pods in prod labeled role=frontend or 172.17.0.0/16 except 172.17.1.0/24. | Allow TCP metrics or UDP 53 from any pod in namespaces labeled env=prod.",
  "ingress sentences",
);
assertEq(
  allowRules.directions[1].rules.map((rule) => rule.segments.map((s) => s.text).join("")).join(""),
  "Allow any UDP port to any pod in namespaces labeled team=platform.",
  "egress sentence",
);
assertEq(networkPolicyText(allowRules).split("\n")[0], "All pods in prod", "empty selector is all pods");

const egressOnly = parseNetworkPolicy({
  spec: {
    podSelector: { matchLabels: { app: "web" } },
    policyTypes: ["Egress"],
    egress: [],
  },
});
assertEq(egressOnly.directions[0].mode, "unaffected", "explicit egress-only leaves ingress alone");
assertEq(egressOnly.directions[1].mode, "deny", "empty egress list denies egress");

const impliedEgress = parseNetworkPolicy({
  spec: {
    podSelector: { matchLabels: { app: "web" } },
    egress: [],
  },
});
assertEq(impliedEgress.directions[0].mode, "deny", "implied ingress still denies");
assertEq(impliedEgress.directions[1].mode, "deny", "present empty egress is denied");
assertEq(
  impliedEgress.policyTypesLabel,
  "No policyTypes field, treated as Ingress, Egress",
  "egress key implies both types",
);

const allowAll = parseNetworkPolicy({
  spec: {
    podSelector: { matchLabels: { app: "web" } },
    ingress: [{}, { from: [{ podSelector: { matchLabels: { app: "web" } } }], ports: [{ port: 80 }] }],
  },
});
assertEq(allowAll.directions[0].mode, "allow-all", "an empty rule allows everything");
assertEq(allowAll.directions[0].rules.length, 0, "redundant rules are not listed");

const expressions = parseNetworkPolicy({
  metadata: { namespace: "prod" },
  spec: {
    podSelector: {
      matchLabels: { app: "db" },
      matchExpressions: [
        { key: "tier", operator: "NotIn", values: ["frontend"] },
        { key: "track", operator: "Exists" },
      ],
    },
    ingress: [
      {
        from: [{ podSelector: { matchExpressions: [{ key: "canary", operator: "DoesNotExist" }] } }],
      },
    ],
  },
});
assertEq(
  networkPolicyText(expressions).split("\n")[0],
  "Pods in prod labeled app=db and tier not in (frontend) and track exists",
  "selector expressions",
);
assertEq(
  expressions.directions[0].rules[0].segments.map((s) => s.text).join(""),
  "Allow any port from pods in prod labeled canary does not exist.",
  "peer expression",
);
assertEq(
  expressions.target.find((s) => s.kind === "link" && s.link.kind === "Pod"),
  undefined,
  "expressions are not an equality filter",
);

const explicitIngressKeepsEgress = parseNetworkPolicy({
  spec: {
    podSelector: {},
    policyTypes: ["Ingress"],
    egress: [{ to: [{ ipBlock: { cidr: "10.0.0.0/8" } }] }],
  },
});
assertEq(
  explicitIngressKeepsEgress.directions[1].mode,
  "unaffected",
  "explicit policyTypes wins over an egress section",
);
