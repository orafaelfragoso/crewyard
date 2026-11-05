import { expect, test } from 'bun:test';
import { nowIso } from '@crewyard/core';
import { acquireExecutionClaim, executionContext } from '@crewyard/storage';
import { createTestContext, ManualClock } from '../../helpers/index.ts';

test('execution context rejects stale and cancelled domain transactions', () => {
  const clock = new ManualClock();
  const ctx = createTestContext({ clock });
  try {
    const claim = ctx.store.immediate((db) =>
      acquireExecutionClaim(
        db,
        {
          scope: 'domain',
          attemptId: 'attempt',
          ownerId: 'owner',
          inputIdentity: 'input',
          ttlSeconds: 30,
        },
        nowIso(clock),
      ),
    )!;
    const controller = new AbortController();
    const guarded = executionContext(ctx, { claim, directory: ctx.root, signal: controller.signal, onSpawn: () => {} });
    guarded.store.immediate((db) => db.query('INSERT INTO sequences VALUES (?, ?)').run('result', 1));
    clock.advance(30);
    expect(() => guarded.store.immediate((db) => db.query('UPDATE sequences SET value = 2').run())).toThrow(
      'no longer current',
    );
    expect(ctx.store.db.query('SELECT value FROM sequences').get()).toEqual({ value: 1 });
    clock.advance(-30);
    controller.abort(new Error('cancelled execution'));
    expect(() => guarded.store.immediate((db) => db.query('UPDATE sequences SET value = 3').run())).toThrow(
      'cancelled execution',
    );
    expect(ctx.store.db.query('SELECT value FROM sequences').get()).toEqual({ value: 1 });
  } finally {
    ctx.cleanup();
  }
});
