import { openUrl } from "@tauri-apps/plugin-opener";
import { createMemo, createSignal, For, Show } from "solid-js";
import { api } from "../api/tauri";
import type {
  K8sObject,
  PodMetrics,
  TrivyCliInfo,
  TrivyScanResult,
  TrivyVulnerability,
} from "../types";
import {
  formatContainerPorts,
  type PodContainerKind,
  type PodContainerRow,
  podContainerGroups,
  readyLabel,
} from "../utils/podContainers";
import { ResourceUsageCell } from "./ResourceUsageCell";

type Props = {
  pod: K8sObject;
  metrics?: PodMetrics | null;
};

type ScanDialogState = {
  row: PodContainerRow;
  cli: TrivyCliInfo | null;
  scanning: boolean;
  result: TrivyScanResult | null;
  error: string | null;
};

function severityClass(severity: string): string {
  switch (severity.toUpperCase()) {
    case "CRITICAL":
      return "sev-critical";
    case "HIGH":
      return "sev-high";
    case "MEDIUM":
      return "sev-medium";
    case "LOW":
      return "sev-low";
    default:
      return "sev-unknown";
  }
}

function canScanImage(image: string): boolean {
  return Boolean(image && image !== "—");
}

async function openVulnUrl(url: string) {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function ContainerTile(props: {
  row: PodContainerRow;
  onScan: (row: PodContainerRow) => void;
  scanBusy: boolean;
}) {
  const ready = () => readyLabel(props.row.ready);
  return (
    <article class="pod-container-tile">
      <div class="pod-container-tile-head">
        <span class="pod-container-tile-name mono" title={props.row.name}>
          {props.row.name}
        </span>
        <div class="status-labels">
          <span class={`status-label ${ready().tone}`}>{ready().text}</span>
          <span class={`status-label ${props.row.state.tone}`} title={props.row.state.text}>
            {props.row.state.text}
          </span>
        </div>
      </div>
      <dl class="pod-container-tile-meta">
        <div>
          <dt>Restarts</dt>
          <dd class="mono">{props.row.restartCount == null ? "—" : props.row.restartCount}</dd>
        </div>
        <div class="pod-container-tile-usage">
          <ResourceUsageCell budget={props.row.resources} />
        </div>
        <div class="pod-container-tile-wide">
          <dt>Image</dt>
          <dd class="mono" title={props.row.image}>
            {props.row.image}
          </dd>
        </div>
        <div class="pod-container-tile-wide">
          <dt>Ports</dt>
          <dd class="mono muted">{formatContainerPorts(props.row.ports)}</dd>
        </div>
      </dl>
      <div class="pod-container-tile-actions">
        <button
          type="button"
          class="btn ghost"
          disabled={!canScanImage(props.row.image) || props.scanBusy}
          title="Scan image with local Trivy CLI"
          onClick={() => props.onScan(props.row)}
        >
          Trivy scan
        </button>
      </div>
    </article>
  );
}

function VulnRow(props: { vuln: TrivyVulnerability }) {
  return (
    <tr>
      <td>
        <span class={`trivy-sev ${severityClass(props.vuln.severity)}`}>{props.vuln.severity}</span>
      </td>
      <td class="mono">
        <Show
          when={props.vuln.primaryUrl}
          fallback={<span title={props.vuln.title}>{props.vuln.id}</span>}
        >
          {(url) => (
            <button
              type="button"
              class="linkish mono"
              title={props.vuln.title || props.vuln.id}
              onClick={() => void openVulnUrl(url())}
            >
              {props.vuln.id}
            </button>
          )}
        </Show>
      </td>
      <td class="mono" title={props.vuln.pkgName}>
        {props.vuln.pkgName || "—"}
      </td>
      <td class="mono muted" title={props.vuln.installedVersion}>
        {props.vuln.installedVersion || "—"}
      </td>
      <td class="mono" title={props.vuln.fixedVersion}>
        {props.vuln.fixedVersion || "—"}
      </td>
    </tr>
  );
}

export function PodContainersSection(props: Props) {
  const groups = createMemo(() =>
    podContainerGroups(props.pod as unknown as Record<string, unknown>, props.metrics?.containers),
  );

  /** Collapsed group kinds; empty = all expanded. Init starts collapsed. */
  const [collapsed, setCollapsed] = createSignal<Set<PodContainerKind>>(new Set(["init"]));
  const [dialog, setDialog] = createSignal<ScanDialogState | null>(null);

  function isCollapsed(kind: PodContainerKind): boolean {
    return collapsed().has(kind);
  }

  function toggleGroup(kind: PodContainerKind) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function closeDialog() {
    if (dialog()?.scanning) return;
    setDialog(null);
  }

  async function openScan(row: PodContainerRow) {
    if (!canScanImage(row.image)) return;
    setDialog({
      row,
      cli: null,
      scanning: true,
      result: null,
      error: null,
    });

    let cli: TrivyCliInfo;
    try {
      cli = await api.trivyCliAvailable();
    } catch (e) {
      setDialog({
        row,
        cli: { available: false, message: String(e) },
        scanning: false,
        result: null,
        error: String(e),
      });
      return;
    }

    if (!cli.available) {
      setDialog({
        row,
        cli,
        scanning: false,
        result: null,
        error:
          cli.message || "Trivy CLI not found. Install Trivy and ensure it is on PATH, then retry.",
      });
      return;
    }

    setDialog({
      row,
      cli,
      scanning: true,
      result: null,
      error: null,
    });

    try {
      const result = await api.trivyScanImage(row.image, row.imageId);
      setDialog({
        row,
        cli,
        scanning: false,
        result,
        error: null,
      });
    } catch (e) {
      setDialog({
        row,
        cli,
        scanning: false,
        result: null,
        error: String(e),
      });
    }
  }

  return (
    <Show when={groups().length > 0}>
      <section class="pod-containers">
        <For each={groups()}>
          {(group) => {
            const closed = () => isCollapsed(group.kind);
            return (
              <div class={`pod-container-group ${closed() ? "collapsed" : ""}`}>
                <button
                  type="button"
                  class="pod-container-group-toggle"
                  aria-expanded={!closed()}
                  onClick={() => toggleGroup(group.kind)}
                >
                  <svg class="pod-container-group-chevron" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M3 4.5 L6 8 L9 4.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span class="pod-container-group-title">{group.title}</span>
                  <span class="pod-container-group-count muted">{group.rows.length}</span>
                </button>
                <Show when={!closed()}>
                  <div class="pod-container-tiles">
                    <For each={group.rows}>
                      {(row) => (
                        <ContainerTile
                          row={row}
                          scanBusy={Boolean(dialog()?.scanning)}
                          onScan={(r) => void openScan(r)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </section>

      <Show when={dialog()}>
        {(d) => (
          <div
            class="about-overlay"
            onClick={() => closeDialog()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeDialog();
            }}
          >
            <div
              class="about-dialog trivy-dialog"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label={`Trivy scan ${d().row.name}`}
            >
              <button
                type="button"
                class="about-close"
                aria-label="Close"
                disabled={d().scanning}
                onClick={() => closeDialog()}
              >
                ×
              </button>
              <h1>Trivy scan</h1>
              <p class="muted trivy-dialog-sub">
                <span class="mono">{d().row.name}</span>
                {" · "}
                <span class="mono" title={d().row.image}>
                  {d().row.image}
                </span>
              </p>

              <Show when={d().cli?.available && d().cli?.version}>
                <div class="trivy-cli-row">
                  <span class="tone-badge tone-ok">{d().cli?.version || "trivy"}</span>
                </div>
              </Show>

              <Show when={d().scanning}>
                <div class="trivy-scanning">
                  <p>Scanning image…</p>
                  <p class="muted">First run may download the vulnerability database.</p>
                </div>
              </Show>

              <Show when={d().error}>
                {(err) => (
                  <div class="trivy-error">
                    <p>{err()}</p>
                    <Show when={!d().cli?.available}>
                      <p class="muted">
                        Install from{" "}
                        <button
                          type="button"
                          class="linkish"
                          onClick={() =>
                            void openVulnUrl(
                              "https://trivy.dev/latest/getting-started/installation/",
                            )
                          }
                        >
                          trivy.dev
                        </button>{" "}
                        and ensure the binary is on PATH.
                      </p>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={d().result}>
                {(result) => (
                  <div class="trivy-result">
                    <Show when={result().scannedImage !== result().image}>
                      <p class="muted trivy-scanned-ref">
                        Scanned digest: <span class="mono">{result().scannedImage}</span>
                      </p>
                    </Show>
                    <div class="trivy-counts">
                      <span class={`trivy-count ${severityClass("CRITICAL")}`}>
                        {result().counts.critical} Critical
                      </span>
                      <span class={`trivy-count ${severityClass("HIGH")}`}>
                        {result().counts.high} High
                      </span>
                      <span class={`trivy-count ${severityClass("MEDIUM")}`}>
                        {result().counts.medium} Medium
                      </span>
                      <span class={`trivy-count ${severityClass("LOW")}`}>
                        {result().counts.low} Low
                      </span>
                      <Show when={result().counts.unknown > 0}>
                        <span class={`trivy-count ${severityClass("UNKNOWN")}`}>
                          {result().counts.unknown} Unknown
                        </span>
                      </Show>
                    </div>

                    <Show
                      when={result().vulnerabilities.length > 0}
                      fallback={<p class="trivy-empty">No vulnerabilities found.</p>}
                    >
                      <div class="trivy-table-wrap">
                        <table class="trivy-table">
                          <thead>
                            <tr>
                              <th>Sev</th>
                              <th>ID</th>
                              <th>Package</th>
                              <th>Installed</th>
                              <th>Fixed</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={result().vulnerabilities}>
                              {(vuln) => <VulnRow vuln={vuln} />}
                            </For>
                          </tbody>
                        </table>
                      </div>
                      <Show when={result().truncated}>
                        <p class="muted trivy-truncated">
                          Showing first {result().vulnerabilities.length} of {result().counts.total}{" "}
                          findings.
                        </p>
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>

              <div class="trivy-dialog-actions">
                <button
                  type="button"
                  class="btn ghost"
                  disabled={d().scanning}
                  onClick={() => closeDialog()}
                >
                  Close
                </button>
                <Show when={!d().scanning && (d().error || d().result)}>
                  <button type="button" class="btn" onClick={() => void openScan(d().row)}>
                    Rescan
                  </button>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}
