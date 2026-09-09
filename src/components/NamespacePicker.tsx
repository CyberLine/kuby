import { createMemo, createSignal, For, Show } from "solid-js";
import { clusterStore } from "../stores/cluster";

export function NamespacePicker() {
  const store = clusterStore;
  const [draft, setDraft] = createSignal("");
  const ctx = () => store.selectedContext();
  const access = () => store.namespaceAccess[ctx()];
  const restricted = () => Boolean(access()?.restricted);
  const selectedExtras = createMemo(() => {
    const selected = new Set(store.selectedNamespaces[ctx()] || []);
    return (store.extraNamespaces[ctx()] || []).filter((n) => selected.has(n));
  });

  function add() {
    if (!ctx()) return;
    if (store.addNamespace(ctx(), draft())) setDraft("");
  }

  return (
    <div class="ns-block">
      <label>
        <span class="ns-label-text">
          Namespaces
          <Show when={restricted()}>
            <span
              class="ns-limited"
              title="This user cannot list cluster namespaces. Using the kubeconfig default and names you add."
            >
              limited
            </span>
          </Show>
        </span>
        <button
          type="button"
          class="btn ghost ns-refresh"
          disabled={!ctx()}
          onClick={() => void store.refreshNamespaces()}
          title="Reload namespaces"
        >
          ↻
        </button>
      </label>
      <select
        multiple
        class="ns-select"
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
              {store.isExtraNamespace(ctx(), ns) ? " (added)" : ""}
            </option>
          )}
        </For>
      </select>
      <Show when={restricted()}>
        <p class="ns-hint">
          Cannot list cluster namespaces. Seeded from kubeconfig
          {access()?.defaultNamespace ? ` (${access()?.defaultNamespace})` : ""}. Add others by
          name.
        </p>
      </Show>
      <form
        class="ns-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          type="text"
          value={draft()}
          placeholder="Add namespace"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          disabled={!ctx()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class="btn" disabled={!ctx() || !draft().trim()}>
          Add
        </button>
        <Show when={selectedExtras().length}>
          <button
            type="button"
            class="btn ghost"
            title="Remove selected added namespaces"
            onClick={() => store.removeExtraNamespaces(ctx(), selectedExtras())}
          >
            Remove
          </button>
        </Show>
      </form>
    </div>
  );
}
