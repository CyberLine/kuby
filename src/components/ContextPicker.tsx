import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import logo from "../assets/logo.png";
import type { ContextInfo } from "../types";
import { ThemeToggle } from "./ThemeToggle";

type Props = {
  contexts: ContextInfo[];
  activeContexts?: string[];
  loading: boolean;
  error: string | null;
  offline?: boolean;
  connecting?: string | null;
  onConnect: (name: string) => void | Promise<void>;
  onConnectMany: (names: string[]) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onDismissError?: () => void;
  onBack?: () => void;
};

export function ContextPicker(props: Props) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [offlineDismissed, setOfflineDismissed] = createSignal(false);

  createEffect(() => {
    if (!props.offline) setOfflineDismissed(false);
  });

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return props.contexts;
    return props.contexts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.cluster.toLowerCase().includes(q) ||
        c.user.toLowerCase().includes(q) ||
        c.auth.method.toLowerCase().includes(q),
    );
  });

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set<string>(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(filtered().map((c) => c.name)));
  }

  function clearSelection() {
    setSelected(new Set<string>());
  }

  return (
    <div class="welcome">
      <div class="welcome-inner">
        <header class="welcome-header">
          <div class="welcome-brand">
            <span class="brand-mark-wrap">
              <img src={logo} class="brand-mark" alt="Kuby" />
            </span>
            <div>
              <h1>Kuby</h1>
              <p>Choose one or more kubeconfig contexts to connect.</p>
            </div>
          </div>
          <div class="welcome-actions">
            <ThemeToggle />
            <Show when={props.onBack && (props.activeContexts?.length || 0) > 0}>
              <button class="btn ghost" onClick={() => props.onBack?.()}>
                Back to cluster
              </button>
            </Show>
            <input
              class="search"
              placeholder="Filter contexts…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <button class="btn ghost" onClick={() => props.onRefresh()} disabled={props.loading}>
              Refresh
            </button>
          </div>
        </header>

        <Show when={props.offline && !offlineDismissed()}>
          <div class="banner warn">
            <span>Offline — no network connection.</span>
            <button
              class="banner-close"
              type="button"
              onClick={() => setOfflineDismissed(true)}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </Show>
        <Show when={props.error}>
          <div class="banner err">
            <span>{props.error}</span>
            <button
              class="banner-close"
              type="button"
              onClick={() => props.onDismissError?.()}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </Show>

        <Show
          when={props.contexts.length}
          fallback={
            <div class="welcome-empty">
              <p>No contexts found in kubeconfig.</p>
              <p class="muted">
                Check <code>~/.kube/config</code> or the <code>KUBECONFIG</code> env var.
              </p>
              <button class="btn" onClick={() => props.onRefresh()} disabled={props.offline}>
                Retry
              </button>
            </div>
          }
        >
          <div class="welcome-toolbar">
            <span class="muted">
              {filtered().length} of {props.contexts.length} contexts
            </span>
            <div class="welcome-toolbar-actions">
              <button class="btn ghost" onClick={selectAllVisible} disabled={props.offline}>
                Select visible
              </button>
              <button class="btn ghost" onClick={clearSelection} disabled={!selected().size}>
                Clear
              </button>
              <button
                class="btn"
                disabled={!selected().size || props.loading || props.offline}
                onClick={() => props.onConnectMany([...selected()])}
              >
                Connect selected ({selected().size})
              </button>
            </div>
          </div>

          <div class={`context-grid ${props.offline ? "is-offline" : ""}`}>
            <For each={filtered()}>
              {(ctx) => {
                const isConnecting = () => props.connecting === ctx.name;
                const isChecked = () => selected().has(ctx.name);
                const isActive = () => (props.activeContexts || []).includes(ctx.name);
                const canOpen = () => isActive() && !props.offline;
                const canConnect = () => !props.loading && !props.offline;
                return (
                  <article
                    class={`context-card ${isChecked() ? "selected" : ""} ${ctx.current ? "current" : ""} ${isActive() ? "active-card" : ""} ${props.offline ? "offline" : ""}`}
                  >
                    <label class="context-check">
                      <input
                        type="checkbox"
                        checked={isChecked()}
                        disabled={isActive() || props.offline}
                        onChange={() => toggle(ctx.name)}
                      />
                      <div class="context-card-body">
                        <div class="context-card-top">
                          <h2>{ctx.name}</h2>
                          <Show when={ctx.current}>
                            <span class="chip active">current</span>
                          </Show>
                          <Show when={isActive()}>
                            <span class="chip active">connected</span>
                          </Show>
                        </div>
                        <dl class="context-meta">
                          <div>
                            <dt>Cluster</dt>
                            <dd class="mono">{ctx.cluster || "—"}</dd>
                          </div>
                          <div>
                            <dt>User</dt>
                            <dd class="mono">{ctx.user || "—"}</dd>
                          </div>
                          <div>
                            <dt>Namespace</dt>
                            <dd>{ctx.namespace || "default"}</dd>
                          </div>
                          <div>
                            <dt>Auth</dt>
                            <dd title={ctx.auth.detail}>{ctx.auth.method}</dd>
                          </div>
                        </dl>
                      </div>
                    </label>
                    <button
                      class="btn"
                      disabled={isActive() ? !canOpen() : !canConnect()}
                      onClick={() => props.onConnect(ctx.name)}
                    >
                      {isConnecting() ? "Connecting…" : isActive() ? "Open" : "Connect"}
                    </button>
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
