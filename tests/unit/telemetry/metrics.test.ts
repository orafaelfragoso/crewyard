import { afterEach, describe, expect, test } from 'bun:test';
import { appendEvent } from '@agent-rail/storage';
import { computeMetrics, pageEvents, percentile } from '@agent-rail/telemetry';
import { createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function seedSession(c: TestContext, id: string, provider: string, usage: { input: number | null; output: number | null; cost: number | null; source: string; costSource: string }) {
  const at = '2026-11-02T10:00:00Z';
  c.store.db.query(`INSERT INTO sessions (id, provider_id, state, started_at, managed) VALUES (?, ?, 'completed', ?, 1)`).run(id, provider, at);
  c.store.db
    .query(
      `INSERT INTO session_usage (session_id, provider_id, model, input_tokens, output_tokens, cost_usd, usage_source, cost_source, at) VALUES (?, ?, 'm', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, provider, usage.input, usage.output, usage.cost, usage.source, usage.costSource, new Date().toISOString());
}

describe('metrics', () => {
  test('AT-20: unknown usage is labelled unknown, never zero, across mixed adapters', () => {
    ctx = createTestContext();
    seedSession(ctx, 'ses_a', 'claude', { input: 1200, output: 300, cost: 0.02, source: 'measured', costSource: 'reported' });
    seedSession(ctx, 'ses_b', 'generic', { input: null, output: null, cost: null, source: 'unknown', costSource: 'unknown' });
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
      for (let i = 0; i < 10_000; i++) appendEvent(db, { type: 'bulk', actor: { kind: 'system', id: 't' }, payload: { i } });
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
