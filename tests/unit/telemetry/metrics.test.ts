import { afterEach, describe, expect, test } from 'bun:test';
import { appendEvent } from '@crewyard/storage';
import { computeMetrics, pageEvents, percentile, recordOperation } from '@crewyard/telemetry';
import { createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function seedSession(
  c: TestContext,
  id: string,
  provider: string,
  usage: { input: number | null; output: number | null; cost: number | null; source: string; costSource: string },
) {
  const at = '2026-11-02T10:00:00Z';
  c.store.db
    .query(`INSERT INTO sessions (id, provider_id, state, started_at, managed) VALUES (?, ?, 'completed', ?, 1)`)
    .run(id, provider, at);
  c.store.db
    .query(
      `INSERT INTO session_usage (session_id, provider_id, model, input_tokens, output_tokens, cost_usd, usage_source, cost_source, at) VALUES (?, ?, 'm', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, provider, usage.input, usage.output, usage.cost, usage.source, usage.costSource, new Date().toISOString());
}

describe('metrics', () => {
  test('reports local validation separately from unavailable hosted timing and total integration latency', () => {
    ctx = createTestContext();
    const c = ctx;
    const at = c.clock.now().toISOString();
    c.store.db
      .query('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('p', 'p', at, at);
    c.store.db
      .query(
        'INSERT INTO repositories (id, project_id, canonical_path, default_base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('r', 'p', '/metrics-repo', 'main', at, at);
    c.store.db
      .query(
        `INSERT INTO pull_requests (id, repository_id, number, title, head_ref, head_sha, base_ref, state, merge_commit_sha, merged_at, created_at, updated_at)
       VALUES ('pr', 'r', 1, 'change', 'topic', 'head', 'main', 'merged', 'merge', ?, ?, ?)`,
      )
      .run(at, at, at);
    for (let i = 0; i < 2; i++) {
      c.store.db
        .query(
          `INSERT INTO validation_runs (id, repository_id, scope, commands, env_fingerprint, commit_sha, status, duration_ms, created_at, completed_at)
         VALUES (?, 'r', 'broad', '[]', 'env', 'head', 'passed', 60000, ?, ?)`,
        )
        .run(`v${i}`, at, at);
    }
    const report = computeMetrics(c, { projectId: 'p' });
    expect(report.schemaVersion).toBe(2);
    expect(report.localValidationMinutesPerMerge).toEqual({ status: 'measured', value: 2 });
    expect(report.localValidationReruns).toBe(1);
    expect(report.hostedCiMinutesPerMerge.status).toBe('unknown');
    expect(report.integrationMinutes.p50.status).toBe('unknown');
    expect(report).not.toHaveProperty('ciMinutesPerMerge');
    expect(report).not.toHaveProperty('queueWaitMinutes');
  });

  test('active request joins are measured separately from completed cache reuse', () => {
    ctx = createTestContext();
    const c = ctx;
    const at = c.clock.now().toISOString();
    c.store.db.query('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'p', at, at);
    c.store.db
      .query(
        'INSERT INTO repositories (id,project_id,canonical_path,default_base,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('r', 'p', '/metric-reviews', 'main', at, at);
    for (const [id, scope, reused] of [
      ['original', 'full', null],
      ['join', 'joined', 'original'],
      ['reuse', 'reused', 'original'],
    ] as const)
      c.store.db
        .query(`INSERT INTO review_artifacts (id,repository_id,review_type,fingerprint,fingerprint_inputs,commit_sha,base_sha,status,reviewer_identity,policy_version,prompt_version,security_class,scope,reused_from,created_at,completed_at)
        VALUES (?,'r','code','fp','{}','head','base','passed','fixture','p1','v1','[]',?,?,?,?)`)
        .run(id, scope, reused, at, at);
    expect(computeMetrics(c).reviewCache).toEqual({
      reviews: 3,
      reused: 1,
      joined: 1,
      hitRatio: { status: 'measured', value: 0.33 },
    });
  });

  test('aggregates measured operation durations and records an audit row without inventing percentiles', () => {
    ctx = createTestContext();
    for (const [durationMs, outcome] of [
      [100, 'completed'],
      [300, 'failed'],
    ] as const) {
      recordOperation(ctx, {
        operation: 'index',
        projectId: null,
        repositoryId: null,
        durationMs,
        outcome,
        actor: { kind: 'service', id: 'test' },
        counts: { parsedBlobs: 1 },
      });
    }
    expect(computeMetrics(ctx).operations).toEqual([
      {
        operation: 'index',
        count: 2,
        failed: 1,
        cancelled: 0,
        totalDurationMs: 400,
        meanDurationMs: 200,
        maxDurationMs: 300,
      },
    ]);
    expect(
      ctx.store.db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'operation.observe'").get(),
    ).toEqual({ n: 2 });
    expect(() =>
      recordOperation(ctx!, {
        operation: 'index',
        projectId: null,
        repositoryId: null,
        durationMs: Number.NaN,
        outcome: 'completed',
        actor: { kind: 'service', id: 'test' },
        counts: {},
      }),
    ).toThrow('finite non-negative');
  });

  test('AT-20: unknown usage is labelled unknown, never zero, across mixed adapters', () => {
    ctx = createTestContext();
    seedSession(ctx, 'ses_a', 'claude', {
      input: 1200,
      output: 300,
      cost: 0.02,
      source: 'measured',
      costSource: 'reported',
    });
    seedSession(ctx, 'ses_b', 'generic', {
      input: null,
      output: null,
      cost: null,
      source: 'unknown',
      costSource: 'unknown',
    });
    const report = computeMetrics(ctx);
    const claude = report.usage.find((u) => u.providerId === 'claude')!;
    const generic = report.usage.find((u) => u.providerId === 'generic')!;
    expect(claude.inputTokens).toEqual({ value: 1200, status: 'measured' });
    expect(claude.costSource).toBe('reported');
    expect(generic.inputTokens.status).toBe('unknown');
    expect(generic.inputTokens.value).toBeNull();
    expect(generic.costUsd.status).toBe('unknown');
    expect(generic.sessionsWithUnknownUsage).toBe(1);
    expect(report.reviewCache.hitRatio.status).toBe('unknown');
  });

  test('percentile uses nearest-rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  test('10,000 events page by cursor without loading history', () => {
    ctx = createTestContext();
    const c = ctx;
    c.store.immediate((db) => {
      for (let i = 0; i < 10_000; i++)
        appendEvent(db, { type: 'bulk', actor: { kind: 'system', id: 't' }, payload: { i } });
    });
    let page = pageEvents(c, { limit: 500, direction: 'older' });
    let seen = page.items.length;
    expect(page.items.at(-1)!.seq).toBe(10_000);
    while (page.cursor.before !== null && page.items.length > 0) {
      page = pageEvents(c, { limit: 500, direction: 'older', beforeSeq: page.cursor.before });
      seen += page.items.length;
    }
    expect(seen).toBe(10_000);
  });
});
