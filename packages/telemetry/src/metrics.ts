import { nowIso } from '@agent-rail/core';
import { all, one, type RailContext } from '@agent-rail/storage';

export type Measured<T> = { value: T; status: 'measured' } | { value: null; status: 'unknown'; reason: string };

const measured = <T>(value: T): Measured<T> => ({ value, status: 'measured' });
const unknown = (reason: string): Measured<never> => ({ value: null, status: 'unknown', reason });

export interface UsageBreakdown {
  providerId: string;
  profileId: string | null;
  model: string | null;
  sessions: number;
  inputTokens: Measured<number>;
  outputTokens: Measured<number>;
  costUsd: Measured<number>;
  costSource: 'reported' | 'configured_rate' | 'mixed' | 'unknown';
  sessionsWithUnknownUsage: number;
}

export interface MetricsReport {
  projectId: string | null;
  window: { since: string; until: string };
  throughput: { mergedPrs: number; perDay: number };
  leadTimeHours: { p50: Measured<number>; p95: Measured<number> };
  queueWaitMinutes: { p50: Measured<number>; p95: Measured<number> };
  openPrAgeHours: { p50: Measured<number>; p95: Measured<number>; open: number };
  wip: Record<string, number>;
  recoveries: number;
  escalations: number;
  reviewCache: { reviews: number; reused: number; hitRatio: Measured<number> };
  contextTokenReduction: Measured<number>;
  ciMinutesPerMerge: Measured<number>;
  ciReruns: number;
  usage: UsageBreakdown[];
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function dist(values: number[], label: string): { p50: Measured<number>; p95: Measured<number> } {
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  return {
    p50: p50 === null ? unknown(`no ${label} samples`) : measured(round(p50)),
    p95: p95 === null ? unknown(`no ${label} samples`) : measured(round(p95)),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

export function computeMetrics(ctx: RailContext, options: { projectId?: string | null; sinceDays?: number } = {}): MetricsReport {
  const db = ctx.store.db;
  const until = nowIso(ctx.clock);
  const sinceDays = options.sinceDays ?? 30;
  const since = new Date(Date.parse(until) - sinceDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const projectId = options.projectId ?? null;
  const repoFilter = projectId ? 'AND r.project_id = ?' : '';
  const p = projectId ? [projectId] : [];

  const merged = all<{ created_at: string; merged_at: string }>(
    db,
    `SELECT pr.created_at, pr.merged_at FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id
     WHERE pr.state = 'merged' AND pr.merge_commit_sha IS NOT NULL AND pr.merged_at >= ? ${repoFilter}`,
    since,
    ...p,
  );

  const leadTimes = all<{ created_at: string; state_changed_at: string }>(
    db,
    `SELECT created_at, state_changed_at FROM tasks WHERE state = 'DONE' AND state_changed_at >= ? ${projectId ? 'AND project_id = ?' : ''}`,
    since,
    ...p,
  ).map((t) => hoursBetween(t.created_at, t.state_changed_at));

  const queueWaits = all<{ enqueued_at: string; updated_at: string }>(
    db,
    `SELECT qe.enqueued_at, qe.updated_at FROM queue_entries qe
     JOIN integration_queues q ON q.id = qe.queue_id JOIN repositories r ON r.id = q.repository_id
     WHERE qe.status = 'merged' AND qe.updated_at >= ? ${repoFilter}`,
    since,
    ...p,
  ).map((q) => hoursBetween(q.enqueued_at, q.updated_at) * 60);

  const openPrs = all<{ created_at: string }>(
    db,
    `SELECT pr.created_at FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id WHERE pr.state = 'open' ${repoFilter}`,
    ...p,
  ).map((o) => hoursBetween(o.created_at, until));

  const wipRows = all<{ state: string; n: number }>(
    db,
    `SELECT state, COUNT(*) AS n FROM tasks WHERE state NOT IN ('DONE', 'CANCELLED', 'DRAFT') ${projectId ? 'AND project_id = ?' : ''} GROUP BY state`,
    ...p,
  );

  const eventCount = (pattern: string) =>
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM events WHERE type LIKE ? AND at >= ? ${projectId ? 'AND project_id = ?' : ''}`,
      pattern,
      since,
      ...p,
    )!.n;

  const reviews = one<{ total: number; reused: number }>(
    db,
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ra.reused_from IS NOT NULL THEN 1 ELSE 0 END), 0) AS reused
     FROM review_artifacts ra JOIN repositories r ON r.id = ra.repository_id WHERE ra.created_at >= ? ${repoFilter}`,
    since,
    ...p,
  )!;

  const packs = all<{ payload: string; token_estimate: number }>(
    db,
    `SELECT ca.payload, ca.token_estimate FROM context_artifacts ca JOIN repositories r ON r.id = ca.repository_id
     WHERE ca.kind = 'context_pack' AND ca.created_at >= ? ${repoFilter}`,
    since,
    ...p,
  );
  let packTokens = 0;
  let sourceTokens = 0;
  for (const pack of packs) {
    const parsed = safeParse(pack.payload);
    const source = typeof parsed?.sourceTokenEstimate === 'number' ? parsed.sourceTokenEstimate : null;
    if (source !== null && source > 0) {
      packTokens += pack.token_estimate;
      sourceTokens += source;
    }
  }

  const ci = one<{ ms: number | null; runs: number }>(
    db,
    `SELECT SUM(v.duration_ms) AS ms, COUNT(*) AS runs FROM validation_runs v JOIN repositories r ON r.id = v.repository_id
     WHERE v.created_at >= ? AND v.status IN ('passed', 'failed') ${repoFilter}`,
    since,
    ...p,
  )!;
  const reruns = one<{ n: number }>(
    db,
    `SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM validation_runs v JOIN repositories r ON r.id = v.repository_id
     WHERE v.created_at >= ? ${repoFilter} GROUP BY v.commit_sha, v.scope HAVING c > 1)`,
    since,
    ...p,
  )!.n;

  return {
    projectId,
    window: { since, until },
    throughput: { mergedPrs: merged.length, perDay: round(merged.length / sinceDays) },
    leadTimeHours: dist(leadTimes, 'completed task'),
    queueWaitMinutes: dist(queueWaits, 'merged queue entry'),
    openPrAgeHours: { ...dist(openPrs, 'open PR'), open: openPrs.length },
    wip: Object.fromEntries(wipRows.map((r) => [r.state, r.n])),
    recoveries: eventCount('recovery.%'),
    escalations: eventCount('task.escalated') + eventCount('queue.escalated'),
    reviewCache: {
      reviews: reviews.total,
      reused: reviews.reused,
      hitRatio: reviews.total === 0 ? unknown('no reviews in window') : measured(round(reviews.reused / reviews.total)),
    },
    contextTokenReduction:
      sourceTokens === 0
        ? unknown('no context packs with source token estimates')
        : measured(round(1 - packTokens / sourceTokens)),
    ciMinutesPerMerge:
      merged.length === 0 || ci.ms === null
        ? unknown(merged.length === 0 ? 'no merges in window' : 'no validation runs recorded')
        : measured(round(ci.ms / 60_000 / merged.length)),
    ciReruns: reruns,
    usage: usageBreakdown(ctx, since, projectId),
  };
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function usageBreakdown(ctx: RailContext, since: string, projectId: string | null = null): UsageBreakdown[] {
  const rows = all<{
    provider_id: string;
    profile_id: string | null;
    model: string | null;
    sessions: number;
    input_known: number;
    output_known: number;
    cost_known: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
    unknown_sessions: number;
    reported: number;
    configured: number;
  }>(
    ctx.store.db,
    `SELECT u.provider_id, u.profile_id, u.model, COUNT(DISTINCT u.session_id) AS sessions,
       COUNT(u.input_tokens) AS input_known, COUNT(u.output_tokens) AS output_known, COUNT(u.cost_usd) AS cost_known,
       SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cost_usd) AS cost_usd,
       COUNT(DISTINCT CASE WHEN u.usage_source = 'unknown' THEN u.session_id END) AS unknown_sessions,
       SUM(CASE WHEN u.cost_source = 'reported' THEN 1 ELSE 0 END) AS reported,
       SUM(CASE WHEN u.cost_source = 'configured_rate' THEN 1 ELSE 0 END) AS configured
     FROM session_usage u JOIN sessions s ON s.id = u.session_id
     LEFT JOIN tasks t ON t.id = s.task_id
     WHERE u.at >= ? ${projectId ? 'AND t.project_id = ?' : ''}
     GROUP BY u.provider_id, u.profile_id, u.model ORDER BY u.provider_id, u.profile_id, u.model`,
    since,
    ...(projectId ? [projectId] : []),
  );
  return rows.map((r) => ({
    providerId: r.provider_id,
    profileId: r.profile_id,
    model: r.model,
    sessions: r.sessions,
    inputTokens: r.input_known > 0 ? measured(r.input_tokens ?? 0) : unknown('provider did not report input tokens'),
    outputTokens: r.output_known > 0 ? measured(r.output_tokens ?? 0) : unknown('provider did not report output tokens'),
    costUsd: r.cost_known > 0 ? measured(round(r.cost_usd ?? 0)) : unknown('no reported usage cost or configured rate'),
    costSource: r.reported > 0 && r.configured > 0 ? 'mixed' : r.reported > 0 ? 'reported' : r.configured > 0 ? 'configured_rate' : 'unknown',
    sessionsWithUnknownUsage: r.unknown_sessions,
  }));
}
