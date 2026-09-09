import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { type ResolvedTheme, themeStore } from "../stores/theme";

type CodeLanguage = "yaml" | "json";

type Props = {
  value: string;
  language: CodeLanguage;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  compact?: boolean;
};

const fillTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace',
    overflow: "auto",
  },
});

const compactTheme = EditorView.theme({
  "&": { height: "auto", maxHeight: "min(60vh, 28rem)", fontSize: "12.5px" },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace',
    overflow: "auto",
    maxHeight: "min(60vh, 28rem)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
});

function languageExtension(language: CodeLanguage) {
  return language === "json" ? json() : yaml();
}

function themeExtensions(mode: ResolvedTheme, compact: boolean) {
  const size = compact ? compactTheme : fillTheme;
  return mode === "dark" ? [oneDark, size] : [size];
}

export function CodeEditor(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | null = null;
  let suppress = false;
  const themeComp = new Compartment();

  onMount(() => {
    const readOnly = Boolean(props.readOnly);
    const compact = Boolean(props.compact);
    const extensions = [
      basicSetup,
      languageExtension(props.language),
      themeComp.of(themeExtensions(themeStore.resolved(), compact)),
      ...(compact ? [EditorView.lineWrapping] : []),
      ...(readOnly
        ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [
            EditorView.updateListener.of((update) => {
              if (suppress || !update.docChanged || !view) return;
              props.onChange?.(view.state.doc.toString());
            }),
          ]),
    ];
    const state = EditorState.create({
      doc: props.value,
      extensions,
    });
    view = new EditorView({ state, parent: host });
  });

  createEffect(
    on(
      () => themeStore.resolved(),
      (mode) => {
        if (!view) return;
        view.dispatch({
          effects: themeComp.reconfigure(themeExtensions(mode, Boolean(props.compact))),
        });
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const v = props.value;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== v) {
      suppress = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: v },
      });
      suppress = false;
    }
  });

  onCleanup(() => {
    view?.destroy();
    view = null;
  });

  return <div class={`cm-host${props.compact ? " cm-host-compact" : ""}`} ref={host} />;
}
