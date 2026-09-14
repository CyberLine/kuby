import type { MetricSample } from "../components/MetricChart";

const MAX_SAMPLES = 60;
const histories = new Map<string, MetricSample[]>();

export function historyKey(context: string, nodeName: string, metric: string): string {
  return `${context}|${nodeName}|${metric}`;
}

export function pushSample(key: string, value: number, t = Date.now()): MetricSample[] {
  const prev = histories.get(key) || [];
  const next = [...prev, { t, value }];
  while (next.length > MAX_SAMPLES) next.shift();
  histories.set(key, next);
  return next;
}

export function getSamples(key: string): MetricSample[] {
  return histories.get(key) || [];
}
