import { createWriteStream } from 'node:fs';
import { type EventQuery, listEvents, type RailContext, type RailEvent } from '@agent-rail/storage';
import { computeMetrics, followEvents, type MetricsReport, pageEvents } from '@agent-rail/telemetry';

export function listEventPage(ctx: RailContext, query: EventQuery & { direction?: 'older' | 'newer' }) {
  return pageEvents(ctx, query);
}

export async function exportEvents(ctx: RailContext, file: string, query: Omit<EventQuery, 'afterSeq' | 'limit' | 'order'> = {}) {
  const out = createWriteStream(file, { encoding: 'utf8', mode: 0o600 });
  let cursor = 0;
  let count = 0;
  for (;;) {
    const batch = listEvents(ctx.store, { ...query, afterSeq: cursor, limit: 1000, order: 'asc' });
    if (batch.length === 0) break;
    for (const event of batch) {
      out.write(`${JSON.stringify(event)}\n`);
      count++;
    }
    cursor = batch.at(-1)!.seq;
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return { file, count, lastSeq: cursor };
}

export function follow(
  ctx: RailContext,
  query: Omit<EventQuery, 'afterSeq' | 'order'> & { afterSeq?: number },
  onEvent: (event: RailEvent) => void,
  signal: AbortSignal,
) {
  return followEvents(ctx, { ...query, signal }, { onEvent });
}

export function metrics(ctx: RailContext, projectId: string | null, sinceDays?: number): MetricsReport {
  return computeMetrics(ctx, { projectId, ...(sinceDays === undefined ? {} : { sinceDays }) });
}

export function metricsCsv(report: MetricsReport): string {
  const rows: [string, string][] = [
    ['window_since', report.window.since],
    ['window_until', report.window.until],
    ['merged_prs', String(report.throughput.mergedPrs)],
    ['merged_per_day', String(report.throughput.perDay)],
    ['lead_time_p50_hours', String(report.leadTimeHours.p50.value ?? 'unknown')],
    ['lead_time_p95_hours', String(report.leadTimeHours.p95.value ?? 'unknown')],
    ['queue_wait_p50_minutes', String(report.queueWaitMinutes.p50.value ?? 'unknown')],
    ['queue_wait_p95_minutes', String(report.queueWaitMinutes.p95.value ?? 'unknown')],
    ['open_prs', String(report.openPrAgeHours.open)],
    ['recoveries', String(report.recoveries)],
    ['escalations', String(report.escalations)],
    ['review_cache_hit_ratio', String(report.reviewCache.hitRatio.value ?? 'unknown')],
    ['context_token_reduction', String(report.contextTokenReduction.value ?? 'unknown')],
    ['ci_minutes_per_merge', String(report.ciMinutesPerMerge.value ?? 'unknown')],
    ['ci_reruns', String(report.ciReruns)],
  ];
  for (const u of report.usage) {
    const key = `${u.providerId}/${u.profileId ?? '-'}/${u.model ?? 'default'}`;
    rows.push([`tokens_in:${key}`, String(u.inputTokens.value ?? 'unknown')]);
    rows.push([`tokens_out:${key}`, String(u.outputTokens.value ?? 'unknown')]);
    rows.push([`cost_usd:${key}`, u.costUsd.value === null ? 'unknown' : `${u.costUsd.value} (${u.costSource})`]);
  }
  return ['metric,value', ...rows.map(([k, v]) => `${JSON.stringify(k)},${JSON.stringify(v)}`)].join('\n');
}
