import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api } from "../api/tauri";
import { type ResolvedTheme, themeStore } from "../stores/theme";
import "@xterm/xterm/css/xterm.css";

type Props = {
  context: string;
  namespace: string;
  pod: string;
  containers?: string[];
  container?: string;
};

const TERM_THEMES: Record<ResolvedTheme, Terminal["options"]["theme"]> = {
  dark: {
    background: "#0f1419",
    foreground: "#e7ecf3",
    cursor: "#7dd3a7",
  },
  light: {
    background: "#ffffff",
    foreground: "#1b2430",
    cursor: "#2a8a66",
  },
};

export function ExecTerminal(props: Props) {
  const initial = props.container || (props.containers?.length ? props.containers[0] : "");
  const [container, setContainer] = createSignal(initial);
  const [status, setStatus] = createSignal("");

  let termHost!: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let sessionId: string | null = null;
  let starting = false;
  let unlisten: UnlistenFn | null = null;
  let endUnlisten: UnlistenFn | null = null;
  let dataDisposable: { dispose: () => void } | null = null;
  let disposed = false;

  async function stopSession() {
    const id = sessionId;
    sessionId = null;
    if (!id) return;
    try {
      await api.stopExecSession(props.context, id);
    } catch {
      /* ignore */
    }
  }

  async function startSession(selected?: string) {
    if (!term || disposed || starting) return;
    starting = true;
    await stopSession();
    if (disposed) {
      starting = false;
      return;
    }
    term.reset();
    const c = selected ?? container();
    setStatus(c ? `Connecting to ${c}…` : "Connecting…");
    try {
      const id = await api.startExecSession({
        context: props.context,
        namespace: props.namespace,
        pod: props.pod,
        container: c || undefined,
      });
      if (disposed) {
        try {
          await api.stopExecSession(props.context, id);
        } catch {
          /* ignore */
        }
        starting = false;
        return;
      }
      sessionId = id;
      setStatus(c ? `Connected · ${c}` : "Connected");
      term.focus();
    } catch (e) {
      if (!disposed) {
        setStatus(`Failed: ${String(e)}`);
        term.writeln(`\r\n\x1b[31m${String(e)}\x1b[0m`);
      }
    } finally {
      starting = false;
    }
  }

  onMount(() => {
    term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: TERM_THEMES[themeStore.resolved()],
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    fit.fit();

    dataDisposable = term.onData((data) => {
      if (!sessionId) return;
      void api.writeExecStdin(sessionId, data);
    });

    const onResize = () => fit?.fit();
    window.addEventListener("resize", onResize);

    void (async () => {
      unlisten = await listen<{
        sessionId: string;
        stream: string;
        data: string;
      }>("k8s://exec", (ev) => {
        if (ev.payload.sessionId !== sessionId) return;
        term?.write(ev.payload.data);
      });
      endUnlisten = await listen<{ sessionId: string }>("k8s://exec-end", (ev) => {
        if (ev.payload.sessionId !== sessionId) return;
        term?.writeln("\r\n\x1b[90m[session closed]\x1b[0m");
        setStatus("Session closed");
        sessionId = null;
      });

      if (disposed) return;
      const names = props.containers || [];
      if (names.length && !container()) {
        setContainer(names[0]);
        await startSession(names[0]);
      } else {
        await startSession();
      }
    })();

    onCleanup(() => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      void stopSession();
      unlisten?.();
      endUnlisten?.();
      dataDisposable?.dispose();
      term?.dispose();
      term = null;
    });
  });

  createEffect(
    on(
      () => themeStore.resolved(),
      (mode) => {
        if (!term) return;
        term.options.theme = TERM_THEMES[mode];
      },
      { defer: true },
    ),
  );

  return (
    <div class="exec-terminal">
      <div class="exec-toolbar">
        <Show when={(props.containers?.length || 0) > 0}>
          <select
            class="container-select"
            value={container()}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setContainer(value);
              void startSession(value);
            }}
          >
            <For each={props.containers || []}>
              {(name) => <option value={name}>{name}</option>}
            </For>
          </select>
        </Show>
        <span class="muted exec-status">{status()}</span>
        <button class="btn ghost" onClick={() => startSession()}>
          Reconnect
        </button>
      </div>
      <div class="xterm-host" ref={termHost} />
    </div>
  );
}
