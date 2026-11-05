import { afterEach, describe, expect, test } from 'bun:test';
import { CrewError } from '@crewyard/core';
import {
  acquireLeadership,
  appendEvent,
  claimDueOutbox,
  enqueueOutbox,
  isLeader,
  listEvents,
  migrate,
  migrationStatus,
  openStore,
} from '@crewyard/storage';
import { createTestContext, ManualClock, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe('storage', () => {
  test('migrations are checksummed, idempotent and refuse newer schemas', () => {
    ctx = createTestContext();
    expect(migrationStatus(ctx.store).pending).toEqual([]);
    expect(migrate(ctx.store).pending).toEqual([]);
    ctx.store.db.exec("INSERT INTO schema_migrations VALUES (999, 'future', 'x', '2026-01-01T00:00:00Z')");
    expect(() => migrationStatus(ctx!.store)).toThrow(CrewError);
  });

  test('dry-run reports pending migrations without applying them', () => {
    const store = openStore({ path: ':memory:' });
    const result = migrate(store, { dryRun: true });
    expect(result.pending.map((p) => p.version)).toEqual([1, 2, 3]);
    expect(migrationStatus(store).currentVersion).toBe(0);
  });

  test('events are monotonic, redacted and paged by cursor', () => {
    ctx = createTestContext();
    const c = ctx;
    for (let i = 0; i < 25; i++) {
      c.store.immediate((db) =>
        appendEvent(db, { type: 't', actor: { kind: 'system', id: 'x' }, payload: { i, apiKey: 'secret' } }),
      );
    }
    const first = listEvents(c.store, { limit: 10 });
    const second = listEvents(c.store, { afterSeq: first.at(-1)!.seq, limit: 10 });
    expect(first.length).toBe(10);
    expect(second[0]!.seq).toBeGreaterThan(first.at(-1)!.seq);
    expect(first[0]!.payload.apiKey).toBe('[REDACTED]');
  });

  test('outbox deduplicates by idempotency key and claims due work once', () => {
    ctx = createTestContext();
    const c = ctx;
    const a = c.store.immediate((db) =>
      enqueueOutbox(db, { kind: 'github.merge', intent: { pr: 1 }, idempotencyKey: 'merge:1' }),
    );
    const b = c.store.immediate((db) =>
      enqueueOutbox(db, { kind: 'github.merge', intent: { pr: 1 }, idempotencyKey: 'merge:1' }),
    );
    expect(a.operationId).toBe(b.operationId);
    expect(claimDueOutbox(c.store, { ownerId: 'worker', limit: 10, kinds: [], ttlSeconds: 60 }).length).toBe(1);
    expect(claimDueOutbox(c.store, { ownerId: 'worker', limit: 10, kinds: [], ttlSeconds: 60 }).length).toBe(0);
  });

  test('leadership is exclusive and generation-fenced', () => {
    const clock = new ManualClock();
    ctx = createTestContext({ clock });
    const first = acquireLeadership(ctx.store, 'repo:x:main', 'w1', 30)!;
    expect(acquireLeadership(ctx.store, 'repo:x:main', 'w2', 30)).toBeNull();
    clock.advance(31);
    const second = acquireLeadership(ctx.store, 'repo:x:main', 'w2', 30)!;
    expect(second.generation).toBe(first.generation + 1);
    expect(isLeader(ctx.store, 'repo:x:main', 'w1', first.generation)).toBe(false);
    expect(isLeader(ctx.store, 'repo:x:main', 'w2', second.generation)).toBe(true);
  });
});

describe('store preview', () => {
  test('returns the result of the transaction and rolls every write back', () => {
    const c = createTestContext();
    try {
      const at = new Date().toISOString();
      const result = c.store.preview((db) => {
        db.query(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_p', 'p', ?, ?)`).run(at, at);
        return (db.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
      });
      expect(result).toBe(1);
      expect(c.store.db.query('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
      expect(() =>
        c.store.preview(() => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
    } finally {
      c.cleanup();
    }
  });
});
