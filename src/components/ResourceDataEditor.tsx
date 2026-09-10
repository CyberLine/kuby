import { createEffect, createMemo, createSignal, Index, Show, untrack } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { api } from "../api/tauri";
import type { K8sObject } from "../types";

export type DataRow = {
  id: string;
  key: string;
  value: string;
  /** Original base64 when decode failed; re-sent unchanged if value not edited. */
  rawEncoded?: string;
  decodeFailed?: boolean;
  valueEdited?: boolean;
};

type Props = {
  context: string;
  apiVersion: string;
  kind: string;
  namespace: string | null;
  name: string;
  /** Resource UID or key — resets editor when selection changes. */
  objectId: string;
  data: Record<string, string> | undefined;
  isSecret: boolean;
  onApplied: () => void | Promise<void>;
  onStatus: (msg: string, isError?: boolean) => void;
};

let rowIdSeq = 0;
function nextRowId() {
  rowIdSeq += 1;
  return `row-${rowIdSeq}`;
}

export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeUtf8Base64(encoded: string): { value: string; ok: boolean } {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return { value: new TextDecoder().decode(bytes), ok: true };
  } catch {
    return { value: encoded, ok: false };
  }
}

function rowsFromData(data: Record<string, string> | undefined, isSecret: boolean): DataRow[] {
  if (!data) return [];
  return Object.entries(data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, raw]) => {
      if (!isSecret) {
        return { id: nextRowId(), key, value: raw };
      }
      const decoded = decodeUtf8Base64(raw);
      if (!decoded.ok) {
        return {
          id: nextRowId(),
          key,
          value: raw,
          rawEncoded: raw,
          decodeFailed: true,
          valueEdited: false,
        };
      }
      return { id: nextRowId(), key, value: decoded.value };
    });
}

function serializeRows(rows: DataRow[], isSecret: boolean): Record<string, string> | null {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (seen.has(key)) return null;
    seen.add(key);
    if (isSecret) {
      if (row.decodeFailed && !row.valueEdited && row.rawEncoded != null) {
        out[key] = row.rawEncoded;
      } else {
        out[key] = encodeUtf8Base64(row.value);
      }
    } else {
      out[key] = row.value;
    }
  }
  return out;
}

function snapshotRows(rows: DataRow[]): string {
  return JSON.stringify(rows.map((r) => ({ key: r.key, value: r.value })));
}

export function resourceDataMap(
  obj: K8sObject | null | undefined,
): Record<string, string> | undefined {
  const data = obj?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function isOpaqueSecret(obj: K8sObject | null | undefined, kind?: string): boolean {
  const k = kind || (obj?.kind as string | undefined);
  if (k !== "Secret") return false;
  const t = obj?.type;
  return t == null || t === "" || t === "Opaque";
}

export function supportsDataTab(obj: K8sObject | null | undefined, kind: string): boolean {
  if (kind === "ConfigMap") return true;
  return isOpaqueSecret(obj, kind);
}

export function ResourceDataEditor(props: Props) {
  const [rows, setRows] = createStore<DataRow[]>([]);
  const [baseline, setBaseline] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [dupError, setDupError] = createSignal(false);
  const [tick, setTick] = createSignal(0);

  createEffect(() => {
    const id = props.objectId;
    const isSecret = props.isSecret;
    void id;
    void isSecret;
    const data = untrack(() => props.data);
    const next = rowsFromData(data, isSecret);
    setRows(reconcile(next));
    setBaseline(snapshotRows(next));
    setDupError(false);
    setTick((t) => t + 1);
  });

  const dirty = createMemo(() => {
    void tick();
    return snapshotRows(unwrap(rows)) !== baseline();
  });

  function bump() {
    setTick((t) => t + 1);
    setDupError(false);
  }

  function addRow() {
    setRows(rows.length, { id: nextRowId(), key: "", value: "" });
    bump();
  }

  function removeRow(index: number) {
    setRows(
      produce((list) => {
        list.splice(index, 1);
      }),
    );
    bump();
  }

  async function apply() {
    const serialized = serializeRows(unwrap(rows), props.isSecret);
    if (serialized == null) {
      setDupError(true);
      props.onStatus("Duplicate keys are not allowed", true);
      return;
    }
    setSaving(true);
    try {
      await api.patchResourceData(
        {
          context: props.context,
          apiVersion: props.apiVersion,
          kind: props.kind,
          namespace: props.namespace,
          name: props.name,
        },
        serialized,
      );
      setBaseline(snapshotRows(unwrap(rows)));
      setTick((t) => t + 1);
      props.onStatus("Applied successfully");
      await props.onApplied();
    } catch (e) {
      props.onStatus(String(e), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="data-editor">
      <div class="yaml-toolbar data-editor-toolbar">
        <button
          type="button"
          class="btn"
          disabled={!dirty() || saving()}
          onClick={() => void apply()}
        >
          Apply
        </button>
        <Show when={dupError()}>
          <span class="data-editor-error">Duplicate keys</span>
        </Show>
        <Show when={props.isSecret}>
          <span class="muted data-editor-hint">Values hidden until focused</span>
        </Show>
      </div>
      <div class="data-editor-table-wrap">
        <table class="data-editor-table">
          <thead>
            <tr>
              <th class="data-col-key">Key</th>
              <th class="data-col-value">Value</th>
              <th class="data-col-actions" />
            </tr>
          </thead>
          <tbody>
            <Index each={rows}>
              {(row, index) => (
                <tr>
                  <td>
                    <input
                      class="data-input"
                      type="text"
                      value={row().key}
                      spellcheck={false}
                      placeholder="key"
                      onInput={(e) => {
                        setRows(index, "key", e.currentTarget.value);
                        bump();
                      }}
                    />
                  </td>
                  <td>
                    <textarea
                      class={`data-input data-value ${props.isSecret ? "secret-blur" : ""}`}
                      value={row().value}
                      spellcheck={false}
                      rows={1}
                      placeholder="value"
                      onInput={(e) => {
                        setRows(index, {
                          value: e.currentTarget.value,
                          valueEdited: true,
                        });
                        bump();
                      }}
                    />
                    <Show when={row().decodeFailed}>
                      <div class="data-decode-warn">Could not decode; raw value shown</div>
                    </Show>
                  </td>
                  <td class="data-col-actions">
                    <button
                      type="button"
                      class="btn ghost data-row-delete"
                      title="Delete"
                      aria-label={`Delete ${row().key || "row"}`}
                      onClick={() => removeRow(index)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
        <button type="button" class="btn ghost data-add-row" onClick={addRow}>
          + Add entry
        </button>
      </div>
    </div>
  );
}
