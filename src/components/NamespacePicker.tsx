import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { clusterStore } from "../stores/cluster";
import { LoadingSpinner } from "./LoadingSpinner";

export function NamespacePicker() {
  const store = clusterStore;
  const [draft, setDraft] = createSignal("");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [inputEl, setInputEl] = createSignal<HTMLInputElement | null>(null);
  const ctx = () => store.selectedContext();
  const access = () => store.namespaceAccess[ctx()];
  const restricted = () => Boolean(access()?.restricted);
  const nsLoading = () => store.namespacesLoading();
  const selectedExtras = createMemo(() => {
    const selected = new Set(store.selectedNamespaces[ctx()] || []);
    return (store.extraNamespaces[ctx()] || []).filter((n) => selected.has(n));
  });

  createEffect(() => {
    if (!dialogOpen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creating()) closeDialog();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  createEffect(() => {
    if (!dialogOpen()) return;
    queueMicrotask(() => inputEl()?.focus());
  });

  function closeDialog() {
    if (creating()) return;
    setDialogOpen(false);
    setDraft("");
  }

  async function create() {
    if (!ctx() || creating()) return;
    setCreating(true);
    try {
      const ok = await store.createNamespace(ctx(), draft());
      if (ok) {
        setDraft("");
        setDialogOpen(false);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div class="ns-block">
      <label>
        <span class="ns-label-text">
          Namespaces
          <Show when={restricted()}>
            <span
              class="ns-limited"
              title="This user cannot list cluster namespaces. Using the kubeconfig default and names you track locally."
            >
              limited
            </span>
          </Show>
        </span>
        <span class="ns-label-actions">
          <button
            type="button"
            class="btn ghost ns-action"
            disabled={!ctx()}
            onClick={() => setDialogOpen(true)}
            title="Create namespace"
            aria-label="Create namespace"
          >
            +
          </button>
          <button
            type="button"
            class={`btn ghost ns-action ns-refresh ${nsLoading() ? "is-loading" : ""}`}
            disabled={!ctx() || nsLoading()}
            onClick={() => void store.refreshNamespaces()}
            title="Reload namespaces"
            aria-label="Reload namespaces"
          >
            ↻
          </button>
        </span>
      </label>
      <div class="ns-select-wrap">
        <select
          multiple
          class="ns-select"
          disabled={nsLoading()}
          value={store.selectedNamespaces[ctx()] || []}
          onChange={(e) => {
            const opts = Array.from(e.currentTarget.selectedOptions).map((o) => o.value);
            store.setSelectedNamespaces(ctx(), opts);
          }}
        >
          <Show when={!restricted()}>
            <option value="*">All namespaces</option>
          </Show>
          <For each={store.namespaces[ctx()] || []}>
            {(ns) => (
              <option value={ns}>
                {ns}
                {store.isExtraNamespace(ctx(), ns) ? " (local)" : ""}
              </option>
            )}
          </For>
        </select>
        <Show when={nsLoading()}>
          <div class="ns-loading-overlay">
            <LoadingSpinner label="Loading namespaces…" />
          </div>
        </Show>
      </div>
      <Show when={restricted()}>
        <p class="ns-hint">
          Cannot list cluster namespaces. Seeded from kubeconfig
          {access()?.defaultNamespace ? ` (${access()?.defaultNamespace})` : ""}. Use + to create
          one on the cluster.
        </p>
      </Show>
      <Show when={selectedExtras().length && !dialogOpen()}>
        <button
          type="button"
          class="btn ghost ns-remove-extras"
          title="Stop tracking selected local namespace names"
          onClick={() => store.removeExtraNamespaces(ctx(), selectedExtras())}
        >
          Remove local names
        </button>
      </Show>

      <Show when={dialogOpen()}>
        <div class="about-overlay" onClick={closeDialog} role="presentation">
          <section
            class="about-dialog ns-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ns-add-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="about-close"
              onClick={closeDialog}
              title="Close"
              aria-label="Close"
              disabled={creating()}
            >
              ×
            </button>
            <h1 id="ns-add-title">Create namespace</h1>
            <p class="about-tagline ns-add-copy">
              Creates a new Namespace resource on the connected cluster.
            </p>
            <form
              class="ns-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                ref={setInputEl}
                type="text"
                value={draft()}
                placeholder="my-namespace"
                spellcheck={false}
                autocapitalize="off"
                autocomplete="off"
                disabled={!ctx() || creating()}
                onInput={(e) => setDraft(e.currentTarget.value)}
              />
              <div class="ns-add-actions">
                <button type="button" class="btn ghost" onClick={closeDialog} disabled={creating()}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn primary"
                  disabled={!ctx() || !draft().trim() || creating()}
                >
                  {creating() ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </section>
        </div>
      </Show>
    </div>
  );
}
