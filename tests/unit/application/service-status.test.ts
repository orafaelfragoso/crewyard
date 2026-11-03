import { afterEach, describe, expect, test } from 'bun:test';
import { serviceStatus } from '@crewyard/application';
import { heartbeatWorker, registerWorker } from '@crewyard/storage';
import { createTestContext, ManualClock, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe('serviceStatus', () => {
  test('ignores a worker that stopped sending heartbeats, so stop never signals a reused pid', () => {
    const clock = new ManualClock();
    ctx = createTestContext({ clock });
    const workerId = registerWorker(ctx.store, 'service', { pid: process.pid });
    expect(serviceStatus(ctx).workers.map((w) => w.workerId)).toEqual([workerId]);

    clock.advance(11 * 60);
    expect(serviceStatus(ctx)).toMatchObject({ running: false, workers: [] });

    heartbeatWorker(ctx.store, workerId, 'running', {});
    expect(serviceStatus(ctx).running).toBe(true);
  });
});
