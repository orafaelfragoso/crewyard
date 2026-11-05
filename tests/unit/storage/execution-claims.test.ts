import { afterEach, describe, expect, test } from 'bun:test';
import { nowIso } from '@crewyard/core';
import {
  acquireExecutionClaim,
  assertExecutionClaim,
  bindExecutionProcess,
  claimDueOutbox,
  completeOutbox,
  type ExecutionClaim,
  enqueueOutbox,
  getExecutionClaim,
  getOutbox,
  listEvents,
  releaseExecutionClaim,
  renewExecutionClaim,
  renewOutboxClaim,
} from '@crewyard/storage';
import { createTestContext, ManualClock, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(): { ctx: TestContext; clock: ManualClock } {
  const clock = new ManualClock();
  ctx = createTestContext({ clock });
  return { ctx, clock };
}

function acquire(c: TestContext, attemptId: string, ownerId: string): ExecutionClaim | null {
  return c.store.immediate((db) =>
    acquireExecutionClaim(
      db,
      {
        scope: 'review:input',
        attemptId,
        ownerId,
        inputIdentity: 'tree:policy',
        ttlSeconds: 30,
      },
      nowIso(c.clock),
    ),
  );
}

function enqueue(c: TestContext): void {
  c.store.immediate((db) =>
    enqueueOutbox(
      db,
      {
        operationId: 'op-test',
        kind: 'test.effect',
        intent: { value: 'original' },
      },
      nowIso(c.clock),
    ),
  );
}

function claim(c: TestContext, ownerId: string) {
  return claimDueOutbox(c.store, { ownerId, limit: 1, kinds: ['test.effect'], ttlSeconds: 30 });
}

describe('execution claims', () => {
  test('admission is exclusive, immutable and records event plus audit in the same transaction', () => {
    const { ctx: c } = setup();
    const first = acquire(c, 'attempt-1', 'owner-1')!;
    expect(acquire(c, 'attempt-2', 'owner-2')).toBeNull();
    expect(acquire(c, 'attempt-3', 'owner-1')).toBeNull();
    expect(() => acquire(c, 'attempt-1', 'owner-1')).toThrow('already exists');
    expect(() => c.store.db.query('UPDATE execution_claims SET input_identity = ?').run('changed')).toThrow(
      'immutable',
    );
    expect(listEvents(c.store, {}).map((e) => e.type)).toEqual(['execution.claim.acquired']);
    expect(c.store.db.query('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
    expect(getExecutionClaim(c.store.db, first.scope)).toEqual(first);
    c.store.db.exec(
      `CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit failure'); END`,
    );
    expect(() => c.store.immediate((db) => releaseExecutionClaim(db, first, nowIso(c.clock)))).toThrow('audit failure');
    expect(getExecutionClaim(c.store.db, first.scope)?.releasedAt).toBeNull();
    expect(listEvents(c.store, {}).map((e) => e.type)).toEqual(['execution.claim.acquired']);
  });

  test('completion fences scope, owner, generation, attempt and input identity', () => {
    const { ctx: c } = setup();
    const first = acquire(c, 'attempt-1', 'owner-1')!;
    for (const mismatch of [
      { scope: 'review:other' },
      { ownerId: 'owner-2' },
      { generation: 2 },
      { attemptId: 'attempt-other' },
      { inputIdentity: 'other-tree' },
    ]) {
      expect(() =>
        c.store.immediate((db) => assertExecutionClaim(db, { ...first, ...mismatch }, nowIso(c.clock))),
      ).toThrow('no longer current');
    }
    expect(() => assertExecutionClaim(c.store.db, first, nowIso(c.clock))).toThrow('require a transaction');
  });

  test('expiry rejects a stale result before and after takeover and rolls back accompanying writes', () => {
    const { ctx: c, clock } = setup();
    const first = acquire(c, 'attempt-1', 'owner-1')!;
    clock.advance(30);
    expect(() => c.store.immediate((db) => renewExecutionClaim(db, first, 30, nowIso(clock)))).toThrow(
      'no longer current',
    );
    const next = acquire(c, 'attempt-2', 'owner-2')!;
    expect(next.generation).toBe(2);
    expect(() =>
      c.store.immediate((db) => {
        db.query('INSERT INTO sequences (name, value) VALUES (?, ?)').run('stale-result', 1);
        releaseExecutionClaim(db, first, nowIso(clock));
      }),
    ).toThrow('no longer current');
    expect(c.store.db.query('SELECT * FROM sequences').all()).toEqual([]);
    expect(getExecutionClaim(c.store.db, next.scope)).toEqual(next);
    expect(c.store.db.query('SELECT COUNT(*) AS n FROM execution_claims WHERE released_at IS NULL').get()).toEqual({
      n: 1,
    });
  });

  test('heartbeats extend authority while release retains generation history', () => {
    const { ctx: c, clock } = setup();
    const first = acquire(c, 'attempt-1', 'owner-1')!;
    clock.advance(20);
    const renewed = c.store.immediate((db) => renewExecutionClaim(db, first, 30, nowIso(clock)));
    clock.advance(15);
    expect(acquire(c, 'attempt-2', 'owner-2')).toBeNull();
    expect(renewed.heartbeatAt).toBe('2026-11-02T12:00:20Z');
    expect(renewed.expiresAt).toBe('2026-11-02T12:00:50Z');
    c.store.immediate((db) => releaseExecutionClaim(db, first, nowIso(clock)));
    expect(() => acquire(c, 'attempt-1', 'owner-1')).toThrow('already exists');
    expect(acquire(c, 'attempt-2', 'owner-2')?.generation).toBe(2);
  });

  test('process binding rejects a reused PID with a different birth identity', () => {
    const { ctx: c } = setup();
    const first = acquire(c, 'attempt-1', 'owner-1')!;
    const identity = { host: 'host', pid: 123, startIdentity: 'boot:42:start:456' };
    const bound = c.store.immediate((db) => bindExecutionProcess(db, first, identity, nowIso(c.clock)));
    expect(bound.process).toEqual(identity);
    expect(c.store.immediate((db) => bindExecutionProcess(db, first, identity, nowIso(c.clock)))).toEqual(bound);
    expect(() =>
      c.store.immediate((db) =>
        bindExecutionProcess(db, first, { ...identity, startIdentity: 'new-birth' }, nowIso(c.clock)),
      ),
    ).toThrow('different process identity');
    expect(() => c.store.db.query('UPDATE execution_claims SET process_pid = ?').run(456)).toThrow('immutable');
    expect(listEvents(c.store, {}).map((e) => e.type)).toEqual([
      'execution.claim.acquired',
      'execution.claim.process_bound',
    ]);
  });
});

describe('fenced outbox delivery', () => {
  test('scheduling timestamps cannot steal an active delivery and old owners cannot settle after expiry', () => {
    const { ctx: c, clock } = setup();
    enqueue(c);
    const first = claim(c, 'owner-1')[0]!;
    expect(first.attempts).toBe(1);
    expect(claim(c, 'owner-2')).toEqual([]);
    clock.advance(20);
    renewOutboxClaim(c.store, first, 30);
    clock.advance(15);
    expect(claim(c, 'owner-2')).toEqual([]);
    clock.advance(15);
    const next = claim(c, 'owner-2')[0]!;
    expect(next.attempts).toBe(2);
    expect(next.claim.generation).toBe(2);
    expect(() =>
      c.store.immediate((db) => {
        db.query('INSERT INTO sequences (name, value) VALUES (?, ?)').run('stale-effect', 1);
        completeOutbox(db, first, { status: 'succeeded' }, nowIso(clock));
      }),
    ).toThrow('no longer current');
    expect(c.store.db.query('SELECT * FROM sequences').all()).toEqual([]);
    c.store.immediate((db) => completeOutbox(db, next, { status: 'succeeded' }, nowIso(clock)));
    expect(getOutbox(c.store.db, first.operationId)?.status).toBe('succeeded');
    expect(claim(c, 'owner-3')).toEqual([]);
  });

  test('intent or expected-state changes invalidate both renewals and settlements', () => {
    const { ctx: c } = setup();
    enqueue(c);
    const first = claim(c, 'owner-1')[0]!;
    c.store.immediate((db) =>
      db
        .query('UPDATE outbox SET intent = ? WHERE operation_id = ?')
        .run(JSON.stringify({ value: 'revived' }), first.operationId),
    );
    expect(() => renewOutboxClaim(c.store, first, 30)).toThrow('no longer current');
    expect(() =>
      c.store.immediate((db) => completeOutbox(db, first, { status: 'succeeded' }, nowIso(c.clock))),
    ).toThrow('no longer current');
    c.store.immediate((db) =>
      db
        .query('UPDATE outbox SET intent = ?, expected_state = ? WHERE operation_id = ?')
        .run(JSON.stringify(first.intent), JSON.stringify({ changed: true }), first.operationId),
    );
    expect(() => renewOutboxClaim(c.store, first, 30)).toThrow('no longer current');
    expect(getOutbox(c.store.db, first.operationId)?.status).toBe('attempted');
  });

  test('settlement releases delivery authority and explicit retry scheduling is respected', () => {
    const { ctx: c, clock } = setup();
    enqueue(c);
    const first = claim(c, 'owner-1')[0]!;
    c.store.immediate((db) =>
      completeOutbox(
        db,
        first,
        {
          status: 'retry',
          error: 'rate limited',
          attempts: first.attempts,
          nextAttemptAt: '2026-11-02T12:01:00Z',
        },
        nowIso(clock),
      ),
    );
    expect(claim(c, 'owner-2')).toEqual([]);
    expect(() => renewOutboxClaim(c.store, first, 30)).toThrow('no longer current');
    clock.advance(60);
    const next = claim(c, 'owner-2')[0]!;
    expect(next.claim.generation).toBe(2);
    c.store.immediate((db) =>
      completeOutbox(
        db,
        next,
        {
          status: 'ambiguous',
          error: 'unknown',
          nextAttemptAt: '2026-11-02T12:02:00Z',
        },
        nowIso(clock),
      ),
    );
    expect(getOutbox(c.store.db, next.operationId)?.nextAttemptAt).toBe('2026-11-02T12:02:00Z');
    expect(claim(c, 'owner-3')).toEqual([]);
  });
});
