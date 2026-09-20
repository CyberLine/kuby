import { createEffect, createMemo, createSignal, For, Index, Show } from "solid-js";
import { api } from "../api/tauri";
import type { K8sObject } from "../types";
import {
  type CertificateInfo,
  certValidityTone,
  collectSecretCertificates,
  formatCertDate,
  formatCertValidityLabel,
  leafCertificate,
  type SecretCertEntry,
  summarizeSecretKeys,
  validityProgress,
} from "../utils/certificates";
import { resourceDataMap } from "./ResourceDataEditor";

type LinkedSecret = {
  context: string;
  namespace: string | null;
  name: string;
};

type Props = {
  data?: Record<string, string> | undefined;
  secretType?: string | null;
  /** Fetch TLS material from this Secret (cert-manager Certificate). */
  linkedSecret?: LinkedSecret | null;
  sourceLabel?: string | null;
  extraBadges?: string[];
};

function cnFromSubject(subject: string): string {
  const m = /(?:^|,\s*)CN=([^,]+)/.exec(subject);
  return m?.[1]?.trim() || subject || "Certificate";
}

function CertCard(props: {
  cert: CertificateInfo;
  index: number;
  total: number;
  sourceKey: string;
}) {
  const tone = () => certValidityTone(props.cert.notBefore, props.cert.notAfter);
  const progress = () => validityProgress(props.cert.notBefore, props.cert.notAfter) * 100;
  const sans = () => [
    ...props.cert.dnsNames.map((d) => `DNS:${d}`),
    ...props.cert.ipAddresses.map((ip) => `IP:${ip}`),
    ...props.cert.emails.map((e) => `email:${e}`),
    ...props.cert.uris.map((u) => `URI:${u}`),
  ];

  return (
    <article class={`cert-card tone-${tone()}`}>
      <header class="cert-card-head">
        <div class="cert-card-title">
          <h3>{cnFromSubject(props.cert.subject)}</h3>
          <div class="cert-card-tags">
            <span class={`tone-badge tone-${tone()}`}>
              {formatCertValidityLabel(props.cert.notBefore, props.cert.notAfter)}
            </span>
            <Show when={props.cert.isCA}>
              <span class="tone-badge tone-idle">CA</span>
            </Show>
            <Show when={props.total > 1}>
              <span class="tone-badge tone-idle">
                {props.index === 0 ? "Leaf" : `Chain #${props.index + 1}`}
              </span>
            </Show>
          </div>
        </div>
        <p class="cert-card-source muted">
          from <span class="mono">{props.sourceKey}</span>
        </p>
      </header>

      <div class="cert-validity">
        <div class="cert-validity-track">
          <div class={`cert-validity-fill tone-${tone()}`} style={{ width: `${progress()}%` }} />
        </div>
        <div class="cert-validity-dates">
          <span class="mono">{formatCertDate(props.cert.notBefore)}</span>
          <span class="mono">{formatCertDate(props.cert.notAfter)}</span>
        </div>
      </div>

      <dl class="cert-meta">
        <div>
          <dt>Subject</dt>
          <dd class="mono">{props.cert.subject || "—"}</dd>
        </div>
        <div>
          <dt>Issuer</dt>
          <dd class="mono">{props.cert.issuer || "—"}</dd>
        </div>
        <div>
          <dt>Serial</dt>
          <dd class="mono">{props.cert.serialNumber || "—"}</dd>
        </div>
        <div>
          <dt>Public key</dt>
          <dd class="mono">{props.cert.publicKeyAlgorithm || "—"}</dd>
        </div>
        <Show when={props.cert.keyUsage.length}>
          <div class="cert-meta-wide">
            <dt>Key usage</dt>
            <dd>
              <div class="cert-chip-row">
                <For each={props.cert.keyUsage}>{(u) => <span class="cert-chip">{u}</span>}</For>
              </div>
            </dd>
          </div>
        </Show>
        <Show when={sans().length}>
          <div class="cert-meta-wide">
            <dt>Subject Alternative Names</dt>
            <dd>
              <div class="cert-chip-row">
                <For each={sans()}>{(s) => <span class="cert-chip mono">{s}</span>}</For>
              </div>
            </dd>
          </div>
        </Show>
        <div class="cert-meta-wide">
          <dt>SHA-256 fingerprint</dt>
          <dd class="mono cert-fingerprint">{props.cert.fingerprintSha256}</dd>
        </div>
      </dl>
    </article>
  );
}

export function SecretCertificateView(props: Props) {
  const [entries, setEntries] = createSignal<SecretCertEntry[]>([]);
  const [resolvedData, setResolvedData] = createSignal<Record<string, string> | undefined>();
  const [resolvedType, setResolvedType] = createSignal<string | null>(null);
  const [resolvedSecretName, setResolvedSecretName] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal(0);

  const keySummaries = createMemo(() => summarizeSecretKeys(resolvedData()));

  createEffect(() => {
    const data = props.data;
    const linked = props.linkedSecret;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        let map = data;
        let type: string | null = props.secretType ?? null;
        let secretName: string | null = null;

        if (linked) {
          const secret = (await api.getResource({
            context: linked.context,
            apiVersion: "v1",
            kind: "Secret",
            namespace: linked.namespace,
            name: linked.name,
          })) as K8sObject;
          if (cancelled) return;
          map = resourceDataMap(secret);
          type = typeof secret.type === "string" ? secret.type : type;
          secretName = linked.name;
        }

        if (cancelled) return;
        setResolvedData(map);
        setResolvedType(type);
        setResolvedSecretName(secretName);

        const next = await collectSecretCertificates(map);
        if (cancelled) return;
        setEntries(next);
        setSelected(0);
      } catch (e) {
        if (cancelled) return;
        setResolvedData(undefined);
        setResolvedType(props.secretType ?? null);
        setResolvedSecretName(props.linkedSecret?.name ?? null);
        setEntries([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  const flatCerts = createMemo(() => {
    const out: {
      cert: CertificateInfo;
      sourceKey: string;
      chainIndex: number;
      chainTotal: number;
    }[] = [];
    for (const entry of entries()) {
      entry.certificates.forEach((cert, i) => {
        out.push({
          cert,
          sourceKey: entry.key,
          chainIndex: i,
          chainTotal: entry.certificates.length,
        });
      });
    }
    return out;
  });

  const overview = createMemo(() => {
    const all = flatCerts().map((c) => c.cert);
    const leaf = leafCertificate(all);
    if (!leaf) return null;
    return {
      leaf,
      tone: certValidityTone(leaf.notBefore, leaf.notAfter),
      label: formatCertValidityLabel(leaf.notBefore, leaf.notAfter),
      count: all.length,
    };
  });

  const active = createMemo(() => flatCerts()[selected()] ?? flatCerts()[0]);

  const toolbarBadges = createMemo(() => {
    const badges: string[] = [];
    if (props.sourceLabel) badges.push(props.sourceLabel);
    for (const b of props.extraBadges || []) badges.push(b);
    if (resolvedType()) badges.push(resolvedType()!);
    return badges;
  });

  return (
    <div class="cert-view">
      <Show
        when={
          toolbarBadges().length > 0 || overview() || resolvedSecretName() || props.linkedSecret
        }
      >
        <div class="cert-view-toolbar">
          <For each={toolbarBadges()}>
            {(badge) => <span class="tone-badge tone-idle mono">{badge}</span>}
          </For>
          <Show when={resolvedSecretName()}>
            {(name) => (
              <span class="muted cert-view-count">
                Secret <span class="mono">{name()}</span>
              </span>
            )}
          </Show>
          <Show when={overview()}>
            {(ov) => (
              <>
                <span class={`tone-badge tone-${ov().tone}`}>{ov().label}</span>
                <span class="muted cert-view-count">
                  {ov().count} certificate{ov().count === 1 ? "" : "s"}
                </span>
              </>
            )}
          </Show>
        </div>
      </Show>

      <Show when={loading()}>
        <p class="muted cert-view-empty">
          {props.linkedSecret ? "Loading secret…" : "Parsing certificates…"}
        </p>
      </Show>

      <Show when={!loading() && loadError()}>
        <div class="cert-view-empty">
          <p>Could not load certificate material.</p>
          <p class="muted">{loadError()}</p>
          <Show when={props.linkedSecret}>
            <p class="muted">
              Expected Secret <span class="mono">{props.linkedSecret!.name}</span>
              {props.linkedSecret!.namespace
                ? ` in namespace ${props.linkedSecret!.namespace}`
                : ""}
              .
            </p>
          </Show>
        </div>
      </Show>

      <Show when={!loading() && !loadError() && flatCerts().length === 0}>
        <div class="cert-view-empty">
          <p>No certificates could be parsed yet.</p>
          <p class="muted">
            {props.linkedSecret
              ? "The linked Secret may be empty until cert-manager issues the certificate."
              : "Raw values are still available in the YAML tab."}
          </p>
        </div>
      </Show>

      <Show when={!loading() && !loadError() && flatCerts().length > 0}>
        <Show when={flatCerts().length > 1}>
          <div class="cert-chain-tabs" role="tablist" aria-label="Certificates">
            <Index each={flatCerts()}>
              {(item, index) => (
                <button
                  type="button"
                  role="tab"
                  class={`cert-chain-tab ${selected() === index ? "active" : ""}`}
                  aria-selected={selected() === index}
                  onClick={() => setSelected(index)}
                >
                  <span class="cert-chain-tab-label">{cnFromSubject(item().cert.subject)}</span>
                  <span
                    class={`tone-badge tone-${certValidityTone(item().cert.notBefore, item().cert.notAfter)}`}
                  >
                    {item().cert.isCA
                      ? "CA"
                      : item().chainIndex === 0
                        ? "Leaf"
                        : `#${item().chainIndex + 1}`}
                  </span>
                </button>
              )}
            </Index>
          </div>
        </Show>

        <Show when={active()}>
          {(item) => (
            <CertCard
              cert={item().cert}
              index={item().chainIndex}
              total={item().chainTotal}
              sourceKey={item().sourceKey}
            />
          )}
        </Show>
      </Show>

      <Show when={!loadError() && keySummaries().length}>
        <section class="detail-block cert-keys">
          <h3>Secret keys</h3>
          <table class="meta-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              <For each={keySummaries()}>
                {(row) => (
                  <tr>
                    <td class="mono">{row.key}</td>
                    <td>
                      <Show when={row.kind === "private-key"} fallback={<span>{row.detail}</span>}>
                        <span class="cert-key-private">
                          <span class="tone-badge tone-idle">Private key</span>
                          <span class="muted">{row.detail}</span>
                          <span class="muted">— value hidden</span>
                        </span>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Show>

      <Show when={entries().some((e) => e.parseError)}>
        <section class="detail-block">
          <For each={entries().filter((e) => e.parseError)}>
            {(e) => (
              <p class="data-decode-warn">
                <span class="mono">{e.key}</span>: {e.parseError}
              </p>
            )}
          </For>
        </section>
      </Show>
    </div>
  );
}
