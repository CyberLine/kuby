import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { confirmAction } from "../api/confirm";
import { api } from "../api/tauri";
import { ageFromTimestamp } from "../constants/resources";
import type { HelmCliInfo, HelmReleaseDetail, HelmReleaseSummary } from "../types";
import { LoadingSpinner } from "./LoadingSpinner";

type Props = {
  context: string;
  namespaces: string[];
  onStatus?: (message: string, isError?: boolean) => void;
};

function releaseKey(r: { namespace: string; name: string }): string {
  return `${r.namespace}/${r.name}`;
}

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "deployed") return "ok";
  if (s === "failed" || s === "superseded" || s.includes("failed")) return "err";
  if (s.includes("pending") || s.includes("uninstalling")) return "warn";
  return "idle";
}

function chartRefFromRelease(chart: string): string {
  // "nginx-15.2.0" → try "nginx" as a repo-less chart name hint
  const m = chart.match(/^(.+)-(\d+\.\d+.*)$/);
  return m?.[1] || chart || "";
}

export function HelmReleasesView(props: Props) {
  const [releases, setReleases] = createSignal<HelmReleaseSummary[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<HelmReleaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [cli, setCli] = createSignal<HelmCliInfo | null>(null);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [upgradeOpen, setUpgradeOpen] = createSignal(false);
  const [upgradeChart, setUpgradeChart] = createSignal("");
  const [reuseValues, setReuseValues] = createSignal(true);
  const [search, setSearch] = createSignal("");

  async function loadList() {
    if (!props.context) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listHelmReleases(props.context, props.namespaces);
      setReleases(list);
      const key = selectedKey();
      if (key && !list.some((r) => releaseKey(r) === key)) {
        setSelectedKey(null);
        setDetail(null);
      }
    } catch (e) {
      setReleases([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadCli() {
    try {
      setCli(await api.helmCliAvailable());
    } catch {
      setCli({ available: false, message: "Could not detect helm CLI" });
    }
  }

  createEffect(() => {
    // Track context + namespaces for reload
    void props.context;
    void props.namespaces.join(",");
    void loadList();
    void loadCli();
  });

  createEffect(() => {
    const key = selectedKey();
    if (!key || !props.context) {
      setDetail(null);
      return;
    }
    const slash = key.indexOf("/");
    if (slash < 0) return;
    const ns = key.slice(0, slash);
    const name = key.slice(slash + 1);
    if (!ns || !name) return;

    let cancelled = false;
    setDetailLoading(true);
    void api
      .getHelmRelease(props.context, ns, name)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDetail(null);
          props.onStatus?.(String(e), true);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return releases();
    return releases().filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.namespace.toLowerCase().includes(q) ||
        r.chart.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q),
    );
  });

  const selected = createMemo(() => {
    const key = selectedKey();
    if (!key) return null;
    return releases().find((r) => releaseKey(r) === key) || null;
  });

  const cliReady = () => cli()?.available === true;

  function notify(msg: string, isError = false) {
    props.onStatus?.(msg, isError);
  }

  async function runUninstall() {
    const r = selected();
    if (!r || !cliReady()) return;
    const ok = await confirmAction(
      `Uninstall Helm release ${r.namespace}/${r.name}?\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    setActionBusy(true);
    try {
      const out = await api.helmUninstall(props.context, r.namespace, r.name);
      notify(out || `Uninstalled ${r.name}`);
      setSelectedKey(null);
      setDetail(null);
      await loadList();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setActionBusy(false);
    }
  }

  async function runRollback() {
    const r = selected();
    const d = detail();
    if (!r || !cliReady()) return;
    const prev = d?.history.find((h) => h.revision < r.revision)?.revision;
    const ok = await confirmAction(
      prev
        ? `Rollback ${r.namespace}/${r.name} to revision ${prev}?`
        : `Rollback ${r.namespace}/${r.name} to the previous revision?`,
    );
    if (!ok) return;
    setActionBusy(true);
    try {
      const out = await api.helmRollback(props.context, r.namespace, r.name, prev ?? null);
      notify(out || `Rolled back ${r.name}`);
      await loadList();
      // Force detail refresh
      setSelectedKey(null);
      setSelectedKey(releaseKey(r));
    } catch (e) {
      notify(String(e), true);
    } finally {
      setActionBusy(false);
    }
  }

  function openUpgrade() {
    const r = selected();
    if (!r || !cliReady()) return;
    setUpgradeChart(chartRefFromRelease(r.chart));
    setReuseValues(true);
    setUpgradeOpen(true);
  }

  async function runUpgrade() {
    const r = selected();
    const chart = upgradeChart().trim();
    if (!r || !chart || !cliReady()) return;
    setActionBusy(true);
    try {
      const out = await api.helmUpgrade(props.context, r.namespace, r.name, chart, reuseValues());
      notify(out || `Upgraded ${r.name}`);
      setUpgradeOpen(false);
      await loadList();
      setSelectedKey(null);
      setSelectedKey(releaseKey(r));
    } catch (e) {
      notify(String(e), true);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div class={`helm-releases ${selectedKey() ? "with-detail" : ""}`}>
      <section class="list-pane">
        <header class="helm-toolbar">
          <div class="helm-toolbar-main">
            <h1>Helm Releases</h1>
            <p class="muted">
              {props.context || "—"}
              <Show when={cli()}>
                {(info) => (
                  <>
                    {" · "}
                    <Show
                      when={info().available}
                      fallback={<span class="tone-badge tone-warn">helm CLI missing</span>}
                    >
                      <span class="tone-badge tone-ok">{info().version || "helm"}</span>
                    </Show>
                  </>
                )}
              </Show>
            </p>
          </div>
          <div class="helm-toolbar-actions">
            <input
              class="search"
              type="search"
              placeholder="Filter releases…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <button
              class="btn"
              disabled={loading() || !props.context}
              onClick={() => void loadList()}
            >
              {loading() ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <Show when={error()}>
          <div class="banner err">{error()}</div>
        </Show>

        <Show when={!cliReady() && cli()}>
          <div class="banner">
            Install the Helm CLI and ensure it is on PATH to enable uninstall, rollback, and
            upgrade. Listing works without it.
            <Show when={cli()?.message}>
              {" "}
              <span class="muted">({cli()?.message})</span>
            </Show>
          </div>
        </Show>

        <Show when={loading() && releases().length === 0}>
          <div class="empty">
            <LoadingSpinner label="Loading Helm releases…" />
          </div>
        </Show>

        <Show when={!loading() || releases().length > 0}>
          <div class="list-body">
            <div class="helm-table-wrap">
              <table class="helm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Revision</th>
                    <th>Status</th>
                    <th>Chart</th>
                    <th>App Version</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  <Show
                    when={filtered().length}
                    fallback={
                      <tr>
                        <td colSpan={7} class="empty-cell">
                          No Helm releases found in the selected namespaces.
                        </td>
                      </tr>
                    }
                  >
                    <For each={filtered()}>
                      {(r) => {
                        const key = releaseKey(r);
                        return (
                          <tr
                            classList={{ selected: selectedKey() === key }}
                            onClick={() => setSelectedKey(key)}
                          >
                            <td>{r.name}</td>
                            <td>{r.namespace}</td>
                            <td>{r.revision}</td>
                            <td>
                              <span class={`tone-badge tone-${statusTone(r.status)}`}>
                                {r.status || "—"}
                              </span>
                            </td>
                            <td>{r.chart || "—"}</td>
                            <td>{r.appVersion || "—"}</td>
                            <td title={r.updated || undefined}>
                              {r.updated ? ageFromTimestamp(r.updated) : "—"}
                            </td>
                          </tr>
                        );
                      }}
                    </For>
                  </Show>
                </tbody>
              </table>
            </div>
          </div>
        </Show>
      </section>

      <Show when={selectedKey()}>
        <aside class="detail-pane helm-detail">
          <header class="detail-header">
            <div>
              <h2>{selected()?.name || "Release"}</h2>
              <p class="muted">
                {selected()?.namespace}
                {selected()?.chart ? ` · ${selected()?.chart}` : ""}
              </p>
            </div>
            <button class="btn ghost" onClick={() => setSelectedKey(null)} title="Close">
              ×
            </button>
          </header>

          <div class="helm-actions">
            <button
              class="btn"
              disabled={!cliReady() || actionBusy()}
              onClick={() => openUpgrade()}
              title={cliReady() ? "helm upgrade" : "Requires helm CLI"}
            >
              Upgrade…
            </button>
            <button
              class="btn"
              disabled={!cliReady() || actionBusy()}
              onClick={() => void runRollback()}
              title={cliReady() ? "helm rollback" : "Requires helm CLI"}
            >
              Rollback
            </button>
            <button
              class="btn danger"
              disabled={!cliReady() || actionBusy()}
              onClick={() => void runUninstall()}
              title={cliReady() ? "helm uninstall" : "Requires helm CLI"}
            >
              Uninstall
            </button>
          </div>

          <Show when={detailLoading() && !detail()}>
            <div class="empty">
              <LoadingSpinner label="Loading release…" />
            </div>
          </Show>

          <Show when={detail()}>
            {(d) => (
              <div class="helm-detail-body">
                <section class="overview-panel helm-panel">
                  <h3>Info</h3>
                  <div class="helm-panel-scroll">
                    <table class="meta-table">
                      <tbody>
                        <tr>
                          <th>Status</th>
                          <td>
                            <span class={`tone-badge tone-${statusTone(d().status)}`}>
                              {d().status}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <th>Revision</th>
                          <td>{d().revision}</td>
                        </tr>
                        <tr>
                          <th>Chart</th>
                          <td>{d().chart || "—"}</td>
                        </tr>
                        <tr>
                          <th>App Version</th>
                          <td>{d().appVersion || "—"}</td>
                        </tr>
                        <tr>
                          <th>Updated</th>
                          <td>{d().updated || "—"}</td>
                        </tr>
                        <tr>
                          <th>Description</th>
                          <td>{d().description || "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>

                <section class="overview-panel helm-panel">
                  <h3>History</h3>
                  <div class="helm-panel-scroll">
                    <Show
                      when={d().history.length}
                      fallback={<div class="empty">No revision history</div>}
                    >
                      <table class="helm-table compact">
                        <thead>
                          <tr>
                            <th>Rev</th>
                            <th>Status</th>
                            <th>Chart</th>
                            <th>Updated</th>
                            <th>Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={d().history}>
                            {(h) => (
                              <tr>
                                <td>{h.revision}</td>
                                <td>
                                  <span class={`tone-badge tone-${statusTone(h.status)}`}>
                                    {h.status}
                                  </span>
                                </td>
                                <td>{h.chart || "—"}</td>
                                <td title={h.updated || undefined}>
                                  {h.updated ? ageFromTimestamp(h.updated) : "—"}
                                </td>
                                <td>{h.description || "—"}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                  </div>
                </section>

                <section class="overview-panel helm-panel">
                  <h3>Values</h3>
                  <div class="helm-panel-scroll">
                    <Show
                      when={d().valuesYaml.trim()}
                      fallback={<div class="empty">No values (empty config)</div>}
                    >
                      <pre class="helm-values">{d().valuesYaml}</pre>
                    </Show>
                  </div>
                </section>
              </div>
            )}
          </Show>
        </aside>
      </Show>

      <Show when={upgradeOpen()}>
        <div class="about-overlay" onClick={() => !actionBusy() && setUpgradeOpen(false)}>
          <div
            class="about-dialog helm-upgrade-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Upgrade Helm release"
          >
            <h1>Upgrade {selected()?.name}</h1>
            <p class="muted">
              Runs <code>helm upgrade</code> with the chart reference below. The chart must be
              available locally or from a configured repo.
            </p>
            <label class="helm-field">
              Chart
              <input
                type="text"
                value={upgradeChart()}
                onInput={(e) => setUpgradeChart(e.currentTarget.value)}
                placeholder="repo/chart or ./path"
                disabled={actionBusy()}
              />
            </label>
            <label class="helm-check">
              <input
                type="checkbox"
                checked={reuseValues()}
                onChange={(e) => setReuseValues(e.currentTarget.checked)}
                disabled={actionBusy()}
              />
              Reuse values
            </label>
            <div class="helm-dialog-actions">
              <button
                class="btn ghost"
                disabled={actionBusy()}
                onClick={() => setUpgradeOpen(false)}
              >
                Cancel
              </button>
              <button
                class="btn"
                disabled={actionBusy() || !upgradeChart().trim()}
                onClick={() => void runUpgrade()}
              >
                {actionBusy() ? "Upgrading…" : "Upgrade"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
