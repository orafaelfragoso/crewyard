import { expect, test } from 'bun:test';
import { nowIso } from '@crewyard/core';
import { syncStateCache } from '@crewyard/integration';
import { acquireExecutionClaim, executionContext } from '@crewyard/storage';
import { createTestContext, ManualClock } from '../../helpers/index.ts';

test('expired cache writer cannot replace the body associated with the current ETag', () => {
  const clock = new ManualClock();
  const ctx = createTestContext({ clock });
  try {
    const cache = syncStateCache(ctx, 'repository');
    cache.set('url', { etag: 'current', body: { state: 'current' } });
    const claim = ctx.store.immediate((db) =>
      acquireExecutionClaim(
        db,
        {
          scope: 'cache-test',
          attemptId: 'attempt-old',
          ownerId: 'owner-old',
          inputIdentity: 'old',
          ttlSeconds: 1,
        },
        nowIso(clock),
      ),
    )!;
    const stale = executionContext(ctx, {
      claim,
      directory: ctx.root,
      signal: new AbortController().signal,
      onSpawn: () => {},
    });
    clock.advance(2);
    expect(() => syncStateCache(stale, 'repository').set('url', { etag: 'stale', body: { state: 'stale' } })).toThrow(
      'no longer current',
    );
    expect(cache.get('url')).toEqual({ etag: 'current', body: { state: 'current' } });
  } finally {
    ctx.cleanup();
  }
});
