import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../../api/tauri";
import { objectName, objectNamespace } from "../../constants/resources";
import type { DiscoveredResource, K8sObject } from "../../types";
import type { RelationLink } from "../../utils/relations";
import { matchesLabelSelector } from "../../utils/relations";
import { isRouteFlowKind } from "../../views/families/routing";
import { asNumber, asRecord, asString, matchesApiGroup } from "../../views/helpers";
import { ConditionsSection } from "./ConditionsSection";
import { RouteFlowView } from "./RouteFlowView";

type Props = {
  context: string;
  apiVersion: string;
  kind: string;
  obj: K8sObject;
  discovered: DiscoveredResource[];
  allObjects: K8sObject[];
  openRelation: (link: RelationLink) => void;
};

export function CrdDetailPanel(props: Props) {
  const kind = () => props.kind;
  const apiVersion = () => props.apiVersion;
  const obj = () => props.obj as Record<string, unknown>;

  return (
    <>
      <Show when={isRouteFlowKind(kind(), apiVersion())}>
        <RouteFlowView
          context={props.context}
          apiVersion={apiVersion()}
          kind={kind()}
          namespace={objectNamespace(props.obj)}
          name={objectName(props.obj)}
          onOpenResource={props.openRelation}
        />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "traefik.io") && kind() === "Middleware"}>
        <MiddlewareDetail obj={obj()} />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "cert-manager.io")}>
        <CertManagerDetail kind={kind()} obj={obj()} />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "monitoring.coreos.com")}>
        <PrometheusDetail
          context={props.context}
          kind={kind()}
          obj={obj()}
          openRelation={props.openRelation}
        />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "external-secrets.io")}>
        <ExternalSecretDetail kind={kind()} obj={obj()} />
      </Show>

      <Show
        when={
          matchesApiGroup(apiVersion(), "helm.toolkit.fluxcd.io") ||
          matchesApiGroup(apiVersion(), "source.toolkit.fluxcd.io") ||
          matchesApiGroup(apiVersion(), "kustomize.toolkit.fluxcd.io")
        }
      >
        <FluxDetail kind={kind()} obj={obj()} />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "argoproj.io")}>
        <ArgoDetail kind={kind()} obj={obj()} />
      </Show>

      <Show when={matchesApiGroup(apiVersion(), "keda.sh")}>
        <KedaDetail kind={kind()} obj={obj()} openRelation={props.openRelation} />
      </Show>

      <Show
        when={
          matchesApiGroup(apiVersion(), "cert-manager.io") ||
          matchesApiGroup(apiVersion(), "external-secrets.io") ||
          matchesApiGroup(apiVersion(), "helm.toolkit.fluxcd.io") ||
          matchesApiGroup(apiVersion(), "source.toolkit.fluxcd.io") ||
          matchesApiGroup(apiVersion(), "kustomize.toolkit.fluxcd.io") ||
          matchesApiGroup(apiVersion(), "argoproj.io") ||
          matchesApiGroup(apiVersion(), "keda.sh") ||
          matchesApiGroup(apiVersion(), "gateway.networking.k8s.io")
        }
      >
        <ConditionsSection obj={obj()} />
      </Show>
    </>
  );
}

function MiddlewareDetail(props: { obj: Record<string, unknown> }) {
  const types = createMemo(() => {
    const spec = asRecord(props.obj.spec) || {};
    return Object.keys(spec);
  });
  return (
    <section class="detail-block">
      <h3>Middleware</h3>
      <dl class="kv">
        <dt>Types</dt>
        <dd class="mono">{types().join(", ") || "—"}</dd>
      </dl>
    </section>
  );
}

function CertManagerDetail(props: { kind: string; obj: Record<string, unknown> }) {
  const spec = () => asRecord(props.obj.spec) || {};
  const status = () => asRecord(props.obj.status) || {};

  return (
    <section class="detail-block">
      <h3>{props.kind}</h3>
      <Show when={props.kind === "Certificate"}>
        <dl class="kv">
          <dt>Secret</dt>
          <dd class="mono">{asString(spec().secretName) || "—"}</dd>
          <dt>Issuer</dt>
          <dd class="mono">
            {asString(asRecord(spec().issuerRef)?.kind) || "Issuer"}/
            {asString(asRecord(spec().issuerRef)?.name) || "—"}
          </dd>
          <dt>DNS names</dt>
          <dd class="mono">
            {(Array.isArray(spec().dnsNames) ? (spec().dnsNames as string[]) : []).join(", ") ||
              "—"}
          </dd>
          <dt>Not before</dt>
          <dd>{asString(status().notBefore) || "—"}</dd>
          <dt>Not after</dt>
          <dd>{asString(status().notAfter) || "—"}</dd>
          <dt>Renewal</dt>
          <dd>{asString(status().renewalTime) || "—"}</dd>
        </dl>
      </Show>
      <Show when={props.kind === "Issuer" || props.kind === "ClusterIssuer"}>
        <dl class="kv">
          <dt>Type</dt>
          <dd class="mono">
            {asRecord(spec().acme)
              ? "ACME"
              : asRecord(spec().ca)
                ? "CA"
                : asRecord(spec().selfSigned)
                  ? "SelfSigned"
                  : asRecord(spec().vault)
                    ? "Vault"
                    : "—"}
          </dd>
          <Show when={asRecord(spec().acme)}>
            <dt>ACME server</dt>
            <dd class="mono">{asString(asRecord(spec().acme)?.server) || "—"}</dd>
          </Show>
        </dl>
      </Show>
    </section>
  );
}

function PrometheusDetail(props: {
  context: string;
  kind: string;
  obj: Record<string, unknown>;
  openRelation: (link: RelationLink) => void;
}) {
  const spec = () => asRecord(props.obj.spec) || {};
  const [namespaceServices, setNamespaceServices] = createSignal<K8sObject[]>([]);

  createEffect(() => {
    if (props.kind !== "ServiceMonitor") {
      setNamespaceServices([]);
      return;
    }
    const ns = objectNamespace(props.obj as K8sObject);
    const ctx = props.context;
    const name = objectName(props.obj as K8sObject);
    if (!ns || !ctx) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    void name;
    void api.listResourcesOnce(ctx, "v1", "Service", ns).then((list) => {
      if (cancelled) return;
      setNamespaceServices(
        list.map((o) => ({ ...o, kind: "Service", apiVersion: "v1" }) as K8sObject),
      );
    });
  });

  const matchingServices = createMemo(() => {
    if (props.kind !== "ServiceMonitor") return [];
    const selector = asRecord(asRecord(spec().selector)?.matchLabels) || {};
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(selector)) {
      if (typeof v === "string") labels[k] = v;
    }
    return namespaceServices().filter((o) => matchesLabelSelector(o, labels));
  });

  const endpoints = createMemo(() => {
    const list = Array.isArray(spec().endpoints) ? (spec().endpoints as unknown[]) : [];
    return list.map((e) => asRecord(e)).filter(Boolean) as Record<string, unknown>[];
  });

  const ruleGroups = createMemo(() => {
    const groups = Array.isArray(spec().groups) ? (spec().groups as unknown[]) : [];
    const rows: { group: string; alert: string; expr: string; severity: string; for: string }[] =
      [];
    for (const g of groups) {
      const group = asRecord(g);
      const groupName = asString(group?.name) || "—";
      const rules = Array.isArray(group?.rules) ? (group!.rules as unknown[]) : [];
      for (const r of rules) {
        const rule = asRecord(r);
        if (!rule) continue;
        rows.push({
          group: groupName,
          alert: asString(rule.alert) || asString(rule.record) || "—",
          expr: asString(rule.expr) || "—",
          severity: asString(asRecord(rule.labels)?.severity) || "—",
          for: asString(rule.for) || "—",
        });
      }
    }
    return rows;
  });

  return (
    <>
      <Show when={props.kind === "ServiceMonitor" || props.kind === "PodMonitor"}>
        <section class="detail-block">
          <h3>Endpoints</h3>
          <table class="meta-table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Path</th>
                <th>Interval</th>
                <th>Scheme</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={endpoints()}
                fallback={
                  <tr>
                    <td colspan="4" class="muted">
                      —
                    </td>
                  </tr>
                }
              >
                {(ep) => (
                  <tr>
                    <td class="mono">{asString(ep.port) || asString(ep.targetPort) || "—"}</td>
                    <td class="mono">{asString(ep.path) || "/metrics"}</td>
                    <td>{asString(ep.interval) || "—"}</td>
                    <td>{asString(ep.scheme) || "http"}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <Show when={props.kind === "ServiceMonitor"}>
          <section class="detail-block">
            <h3>Matching Services ({matchingServices().length})</h3>
            <div class="relation-links">
              <For
                each={matchingServices()}
                fallback={
                  <span class="muted">No services match the selector in the current watch.</span>
                }
              >
                {(svc) => (
                  <button
                    type="button"
                    class="relation-link"
                    onClick={() =>
                      props.openRelation({
                        id: `sm-svc-${objectName(svc)}`,
                        group: "Targets",
                        title: `Service/${objectName(svc)}`,
                        apiVersion: "v1",
                        kind: "Service",
                        namespace: objectNamespace(svc),
                        name: objectName(svc),
                      })
                    }
                  >
                    Service/{objectName(svc)}
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>
      <Show when={props.kind === "PrometheusRule"}>
        <section class="detail-block">
          <h3>Rules</h3>
          <table class="meta-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Alert</th>
                <th>Severity</th>
                <th>For</th>
                <th>Expr</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={ruleGroups()}
                fallback={
                  <tr>
                    <td colspan="5" class="muted">
                      —
                    </td>
                  </tr>
                }
              >
                {(row) => (
                  <tr>
                    <td class="mono">{row.group}</td>
                    <td class="mono">{row.alert}</td>
                    <td>{row.severity}</td>
                    <td>{row.for}</td>
                    <td class="mono crd-expr">{row.expr}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Show>
    </>
  );
}

function ExternalSecretDetail(props: { kind: string; obj: Record<string, unknown> }) {
  const spec = () => asRecord(props.obj.spec) || {};
  const status = () => asRecord(props.obj.status) || {};

  const mappings = createMemo(() => {
    const data = Array.isArray(spec().data) ? (spec().data as unknown[]) : [];
    const from = Array.isArray(spec().dataFrom) ? (spec().dataFrom as unknown[]) : [];
    const rows: { remote: string; secret: string }[] = [];
    for (const d of data) {
      const rec = asRecord(d);
      if (!rec) continue;
      rows.push({
        remote: asString(asRecord(rec.remoteRef)?.key) || asString(rec.key) || "—",
        secret: asString(rec.secretKey) || "—",
      });
    }
    for (const d of from) {
      const rec = asRecord(d);
      const extract = asRecord(rec?.extract);
      const key = asString(extract?.key) || asString(asRecord(rec?.find)?.name) || "dataFrom";
      rows.push({ remote: key, secret: "(all keys)" });
    }
    return rows;
  });

  return (
    <Show when={props.kind === "ExternalSecret"}>
      <section class="detail-block">
        <h3>External Secret</h3>
        <dl class="kv">
          <dt>Store</dt>
          <dd class="mono">
            {asString(asRecord(spec().secretStoreRef)?.kind) || "SecretStore"}/
            {asString(asRecord(spec().secretStoreRef)?.name) || "—"}
          </dd>
          <dt>Target Secret</dt>
          <dd class="mono">{asString(asRecord(spec().target)?.name) || "—"}</dd>
          <dt>Refresh</dt>
          <dd>{asString(spec().refreshInterval) || "—"}</dd>
          <dt>Synced resource version</dt>
          <dd class="mono">{asString(status().syncedResourceVersion) || "—"}</dd>
        </dl>
        <h3>Key mapping</h3>
        <table class="meta-table">
          <thead>
            <tr>
              <th>Remote key</th>
              <th>Secret key</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={mappings()}
              fallback={
                <tr>
                  <td colspan="2" class="muted">
                    —
                  </td>
                </tr>
              }
            >
              {(row) => (
                <tr>
                  <td class="mono">{row.remote}</td>
                  <td class="mono">{row.secret}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}

function FluxDetail(props: { kind: string; obj: Record<string, unknown> }) {
  const spec = () => asRecord(props.obj.spec) || {};
  const status = () => asRecord(props.obj.status) || {};
  return (
    <section class="detail-block">
      <h3>{props.kind}</h3>
      <dl class="kv">
        <Show when={props.kind === "HelmRelease"}>
          <dt>Chart</dt>
          <dd class="mono">
            {asString(asRecord(asRecord(spec().chart)?.spec)?.chart) || "—"}{" "}
            {asString(asRecord(asRecord(spec().chart)?.spec)?.version)}
          </dd>
          <dt>Target namespace</dt>
          <dd class="mono">{asString(spec().targetNamespace) || "—"}</dd>
        </Show>
        <Show when={props.kind === "Kustomization"}>
          <dt>Path</dt>
          <dd class="mono">{asString(spec().path) || "—"}</dd>
          <dt>Source</dt>
          <dd class="mono">
            {asString(asRecord(spec().sourceRef)?.kind)}/
            {asString(asRecord(spec().sourceRef)?.name)}
          </dd>
        </Show>
        <Show
          when={
            props.kind === "GitRepository" ||
            props.kind === "HelmRepository" ||
            props.kind === "OCIRepository"
          }
        >
          <dt>URL</dt>
          <dd class="mono">{asString(spec().url) || "—"}</dd>
        </Show>
        <dt>Suspended</dt>
        <dd>{spec().suspend ? "yes" : "no"}</dd>
        <dt>Revision</dt>
        <dd class="mono">
          {asString(status().lastAppliedRevision) ||
            asString(status().lastAttemptedRevision) ||
            asString(asRecord(status().artifact)?.revision) ||
            "—"}
        </dd>
        <dt>Last handled</dt>
        <dd>{asString(status().lastHandledReconcileAt) || "—"}</dd>
      </dl>
    </section>
  );
}

function ArgoDetail(props: { kind: string; obj: Record<string, unknown> }) {
  const spec = () => asRecord(props.obj.spec) || {};
  const status = () => asRecord(props.obj.status) || {};
  const resources = createMemo(() => {
    const list = Array.isArray(status().resources) ? (status().resources as unknown[]) : [];
    return list.map((r) => asRecord(r)).filter(Boolean) as Record<string, unknown>[];
  });
  const source = () => {
    if (asRecord(spec().source)) return asRecord(spec().source);
    const sources = Array.isArray(spec().sources) ? (spec().sources as unknown[]) : [];
    return asRecord(sources[0] ?? null);
  };

  return (
    <Show when={props.kind === "Application"}>
      <section class="detail-block">
        <h3>Application</h3>
        <dl class="kv">
          <dt>Project</dt>
          <dd class="mono">{asString(spec().project) || "—"}</dd>
          <dt>Destination</dt>
          <dd class="mono">
            {asString(asRecord(spec().destination)?.namespace) || "—"} @{" "}
            {asString(asRecord(spec().destination)?.name) ||
              asString(asRecord(spec().destination)?.server) ||
              "—"}
          </dd>
          <dt>Source</dt>
          <dd class="mono">
            {asString(source()?.repoURL) || "—"}
            {asString(source()?.path) ? ` (${asString(source()?.path)})` : ""}
            {asString(source()?.chart) ? ` chart:${asString(source()?.chart)}` : ""}
          </dd>
          <dt>Sync</dt>
          <dd>{asString(asRecord(status().sync)?.status) || "—"}</dd>
          <dt>Health</dt>
          <dd>{asString(asRecord(status().health)?.status) || "—"}</dd>
        </dl>
        <h3>Resources ({resources().length})</h3>
        <table class="meta-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Namespace</th>
              <th>Health</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={resources()}
              fallback={
                <tr>
                  <td colspan="5" class="muted">
                    —
                  </td>
                </tr>
              }
            >
              {(r) => (
                <tr>
                  <td class="mono">{asString(r.kind)}</td>
                  <td class="mono">{asString(r.name)}</td>
                  <td class="mono">{asString(r.namespace) || "—"}</td>
                  <td>{asString(asRecord(r.health)?.status) || "—"}</td>
                  <td>{asString(r.status) || "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}

function KedaDetail(props: {
  kind: string;
  obj: Record<string, unknown>;
  openRelation: (link: RelationLink) => void;
}) {
  const spec = () => asRecord(props.obj.spec) || {};
  const status = () => asRecord(props.obj.status) || {};
  const triggers = createMemo(() => {
    const list = Array.isArray(spec().triggers) ? (spec().triggers as unknown[]) : [];
    return list.map((t) => asRecord(t)).filter(Boolean) as Record<string, unknown>[];
  });
  const target = () => asRecord(spec().scaleTargetRef) || {};

  return (
    <Show when={props.kind === "ScaledObject" || props.kind === "ScaledJob"}>
      <section class="detail-block">
        <h3>{props.kind}</h3>
        <dl class="kv">
          <dt>Target</dt>
          <dd>
            <button
              type="button"
              class="linkish mono"
              onClick={() =>
                props.openRelation({
                  id: "keda-target",
                  group: "Scales",
                  title: `${asString(target().kind) || "Deployment"}/${asString(target().name)}`,
                  apiVersion:
                    asString(target().apiVersion) ||
                    (["Deployment", "StatefulSet", "DaemonSet"].includes(
                      asString(target().kind) || "Deployment",
                    )
                      ? "apps/v1"
                      : "v1"),
                  kind: asString(target().kind) || "Deployment",
                  namespace: objectNamespace(props.obj as K8sObject),
                  name: asString(target().name),
                })
              }
            >
              {asString(target().kind) || "Deployment"}/{asString(target().name) || "—"}
            </button>
          </dd>
          <dt>Min / Max</dt>
          <dd>
            {asNumber(spec().minReplicaCount) ?? "—"} / {asNumber(spec().maxReplicaCount) ?? "—"}
          </dd>
          <dt>Current / Desired</dt>
          <dd>
            {asNumber(status().currentReplicas) ?? "—"} /{" "}
            {asNumber(status().desiredReplicas) ?? "—"}
          </dd>
        </dl>
        <h3>Triggers</h3>
        <table class="meta-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Metric / metadata</th>
              <th>Auth</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={triggers()}
              fallback={
                <tr>
                  <td colspan="3" class="muted">
                    —
                  </td>
                </tr>
              }
            >
              {(t) => {
                const meta = asRecord(t.metadata) || {};
                const metaText = Object.entries(meta)
                  .filter(([, v]) => typeof v === "string")
                  .map(([k, v]) => `${k}=${v}`)
                  .slice(0, 4)
                  .join(", ");
                return (
                  <tr>
                    <td class="mono">{asString(t.type)}</td>
                    <td class="mono">{metaText || "—"}</td>
                    <td class="mono">{asString(asRecord(t.authenticationRef)?.name) || "—"}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}
