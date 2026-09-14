import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "../api/tauri";
import type { LogLine } from "../types";

type Target = {
  context: string;
  namespace: string;
  pod: string;
  container?: string;
};

type Props = {
  context: string;
  namespace: string;
  pod: string;
  containers?: string[];
  aggregated?: boolean;
  pods?: Target[];
};

export function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<{ text: string; source?: string }[]>([]);
  const [filter, setFilter] = createSignal("");
  const [container, setContainer] = createSignal<string>("");
  let unlisten: UnlistenFn | null = null;
  let endUnlisten: UnlistenFn | null = null;
  let scroller!: HTMLDivElement;
  let activeIds = new Set<string>();

  async function start(selectedContainer?: string) {
    await stop();
    setLines([]);
    const c = selectedContainer ?? container();
    const targets: Target[] =
      props.aggregated && props.pods?.length
        ? props.pods
        : props.pod
          ? [
              {
                context: props.context,
                namespace: props.namespace,
                pod: props.pod,
                container: c || undefined,
              },
            ]
          : [];

    if (!targets.length) {
      setLines([{ text: "No pod selected for logs." }]);
      return;
    }

    try {
      if (targets.length === 1) {
        const id = await api.startPodLogs({
          context: targets[0].context,
          namespace: targets[0].namespace,
          pod: targets[0].pod,
          container: targets[0].container,
          tailLines: 300,
        });
        activeIds = new Set([id]);
      } else {
        const ids = await api.startAggregatedLogs(targets, false, 100);
        activeIds = new Set(ids);
      }
    } catch (e) {
      setLines([{ text: `Failed to start logs: ${String(e)}` }]);
    }
  }

  async function stop() {
    const ids = [...activeIds];
    activeIds = new Set();
    for (const id of ids) {
      try {
        await api.stopPodLogs(props.context, id);
      } catch {
        /* ignore */
      }
    }
  }

  onMount(async () => {
    const names = props.containers || [];
    if (names.length && !container()) {
      setContainer(names[0]);
    }

    unlisten = await listen<LogLine>("k8s://log", (ev) => {
      if (!activeIds.has(ev.payload.streamId)) return;
      const source = `${ev.payload.pod}`;
      setLines((prev) => {
        const next = [
          ...prev,
          {
            text: ev.payload.line,
            source: props.aggregated ? source : undefined,
          },
        ];
        return next.length > 5000 ? next.slice(-4000) : next;
      });
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    });
    endUnlisten = await listen("k8s://log-end", (ev) => {
      const id = (ev.payload as { streamId?: string })?.streamId;
      if (id && !activeIds.has(id)) return;
      setLines((prev) => [...prev, { text: "— stream ended —" }]);
    });
    await start();
  });

  createEffect(() => {
    const names = props.containers || [];
    if (!names.length) return;
    if (!names.includes(container())) {
      setContainer(names[0]);
      void start(names[0]);
    }
  });

  onCleanup(() => {
    void stop();
    unlisten?.();
    endUnlisten?.();
  });

  const visible = () => {
    const q = filter().toLowerCase();
    if (!q) return lines();
    return lines().filter(
      (l) => l.text.toLowerCase().includes(q) || (l.source || "").toLowerCase().includes(q),
    );
  };

  return (
    <div class="log-viewer">
      <div class="log-toolbar">
        <Show when={(props.containers?.length || 0) > 0 && !props.aggregated}>
          <select
            class="container-select"
            value={container()}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setContainer(value);
              void start(value);
            }}
          >
            <For each={props.containers || []}>
              {(name) => <option value={name}>{name}</option>}
            </For>
          </select>
        </Show>
        <input
          class="search"
          placeholder="Filter logs…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button class="btn ghost" onClick={() => start()}>
          Restart
        </button>
        <button class="btn ghost" onClick={() => setLines([])}>
          Clear
        </button>
      </div>
      <div class="log-body" ref={scroller}>
        <Show when={visible().length} fallback={<div class="empty">Waiting for log lines…</div>}>
          <For each={visible()}>
            {(l) => (
              <div class="log-line">
                <Show when={l.source}>
                  <span class="log-source">{l.source}</span>
                </Show>
                <span>{l.text}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
