import type { StatusLabel, StatusTone } from "./nodeStatus";

export type PodContainerKind = "init" | "app" | "ephemeral";

export type PodContainerPort = {
  port: number;
  protocol: string;
  name: string;
};

export type PodContainerRow = {
  name: string;
  kind: PodContainerKind;
  ready: boolean | null;
  restartCount: number | null;
  image: string;
  ports: PodContainerPort[];
  state: StatusLabel;
  cpu: string | null;
  memory: string | null;
};

export type PodContainerGroup = {
  kind: PodContainerKind;
  title: string;
  rows: PodContainerRow[];
};

type ContainerMetrics = { name: string; cpu: string; memory: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function statusOf(obj: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(obj.status);
}

function specOf(obj: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(obj.spec);
}

function containerList(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of v) {
    const r = asRecord(item);
    if (r) out.push(r);
  }
  return out;
}

function statusByName(list: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const cs of list) {
    const name = typeof cs.name === "string" ? cs.name : "";
    if (name) map.set(name, cs);
  }
  return map;
}

function parsePorts(spec: Record<string, unknown>): PodContainerPort[] {
  const ports = spec.ports;
  if (!Array.isArray(ports)) return [];
  const out: PodContainerPort[] = [];
  for (const p of ports) {
    const r = asRecord(p);
    if (!r) continue;
    const port = Number(r.containerPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const protocol = (typeof r.protocol === "string" ? r.protocol : "TCP").toUpperCase();
    out.push({
      port,
      protocol,
      name: typeof r.name === "string" ? r.name : "",
    });
  }
  return out;
}

export function formatContainerPorts(ports: PodContainerPort[]): string {
  if (!ports.length) return "—";
  return ports
    .map((p) => {
      const base = `${p.port}/${p.protocol}`;
      return p.name ? `${p.name} (${base})` : base;
    })
    .join(", ");
}

function containerStateLabel(cs: Record<string, unknown> | undefined): StatusLabel {
  if (!cs) return { text: "—", tone: "muted" };
  const state = asRecord(cs.state);
  if (!state) return { text: "Unknown", tone: "muted" };

  const running = asRecord(state.running);
  if (running) return { text: "Running", tone: "ok" };

  const waiting = asRecord(state.waiting);
  if (waiting) {
    const reason =
      typeof waiting.reason === "string" && waiting.reason ? waiting.reason : "Waiting";
    return { text: reason, tone: waitingTone(reason) };
  }

  const terminated = asRecord(state.terminated);
  if (terminated) {
    const reason =
      typeof terminated.reason === "string" && terminated.reason ? terminated.reason : "Terminated";
    const exitCode =
      typeof terminated.exitCode === "number" ? terminated.exitCode : Number(terminated.exitCode);
    const text =
      Number.isFinite(exitCode) && reason === "Completed"
        ? `Completed (${exitCode})`
        : Number.isFinite(exitCode) && reason === "Terminated"
          ? `Terminated (${exitCode})`
          : Number.isFinite(exitCode)
            ? `${reason} (${exitCode})`
            : reason;
    const tone: StatusTone =
      reason === "Completed" || exitCode === 0
        ? "muted"
        : reason === "Error" || (Number.isFinite(exitCode) && exitCode !== 0)
          ? "err"
          : "warn";
    return { text, tone };
  }

  return { text: "Unknown", tone: "muted" };
}

function waitingTone(reason: string): StatusTone {
  const lower = reason.toLowerCase();
  if (
    lower.includes("backoff") ||
    lower === "errimagepull" ||
    lower === "imagepullbackoff" ||
    lower === "crashloopbackoff" ||
    lower === "error" ||
    lower === "createcontainerconfigerror" ||
    lower === "createcontainererror" ||
    lower === "invalidimagename" ||
    lower === "runcontainererror"
  ) {
    return "err";
  }
  if (
    lower === "containercreating" ||
    lower === "podinitializing" ||
    lower === "pending" ||
    lower.includes("pull")
  ) {
    return "warn";
  }
  return "warn";
}

function readyTone(ready: boolean | null): StatusTone {
  if (ready == null) return "muted";
  return ready ? "ok" : "err";
}

export function readyLabel(ready: boolean | null): StatusLabel {
  if (ready == null) return { text: "—", tone: "muted" };
  return { text: ready ? "Ready" : "NotReady", tone: readyTone(ready) };
}

function mergeGroup(
  kind: PodContainerKind,
  title: string,
  specs: Record<string, unknown>[],
  statuses: Record<string, unknown>[],
  metricsByName: Map<string, ContainerMetrics>,
): PodContainerGroup | null {
  if (!specs.length && !statuses.length) return null;

  const byStatus = statusByName(statuses);
  const seen = new Set<string>();
  const rows: PodContainerRow[] = [];

  const pushRow = (name: string, spec: Record<string, unknown> | undefined) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const cs = byStatus.get(name);
    const restartRaw = cs?.restartCount;
    const restartCount =
      typeof restartRaw === "number"
        ? restartRaw
        : restartRaw != null && Number.isFinite(Number(restartRaw))
          ? Number(restartRaw)
          : cs
            ? 0
            : null;
    const ready = typeof cs?.ready === "boolean" ? cs.ready : cs ? Boolean(cs.ready) : null;
    const statusImage = typeof cs?.image === "string" ? cs.image : "";
    const specImage = typeof spec?.image === "string" ? spec.image : "";
    const m = metricsByName.get(name);
    rows.push({
      name,
      kind,
      ready,
      restartCount,
      image: statusImage || specImage || "—",
      ports: spec ? parsePorts(spec) : [],
      state: containerStateLabel(cs),
      cpu: m?.cpu ?? null,
      memory: m?.memory ?? null,
    });
  };

  for (const spec of specs) {
    const name = typeof spec.name === "string" ? spec.name : "";
    pushRow(name, spec);
  }
  // Status-only entries (e.g. ephemeral added at runtime without matching order)
  for (const cs of statuses) {
    const name = typeof cs.name === "string" ? cs.name : "";
    pushRow(name, undefined);
  }

  if (!rows.length) return null;
  return { kind, title, rows };
}

/**
 * Build grouped container rows for a Pod detail view.
 * Order matches kubectl describe: Init → Containers → Ephemeral.
 */
export function podContainerGroups(
  obj: Record<string, unknown>,
  containerMetrics?: ContainerMetrics[] | null,
): PodContainerGroup[] {
  const spec = specOf(obj);
  const status = statusOf(obj);
  const metricsByName = new Map<string, ContainerMetrics>();
  for (const m of containerMetrics || []) {
    if (m.name) metricsByName.set(m.name, m);
  }

  const groups: PodContainerGroup[] = [];
  const init = mergeGroup(
    "init",
    "Init Containers",
    containerList(spec?.initContainers),
    containerList(status?.initContainerStatuses),
    metricsByName,
  );
  if (init) groups.push(init);

  const app = mergeGroup(
    "app",
    "Containers",
    containerList(spec?.containers),
    containerList(status?.containerStatuses),
    metricsByName,
  );
  if (app) groups.push(app);

  const ephemeral = mergeGroup(
    "ephemeral",
    "Ephemeral Containers",
    containerList(spec?.ephemeralContainers),
    containerList(status?.ephemeralContainerStatuses),
    metricsByName,
  );
  if (ephemeral) groups.push(ephemeral);

  return groups;
}
