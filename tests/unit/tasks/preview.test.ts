import { afterEach, describe, expect, test } from 'bun:test';
import { previewStore } from '@crewyard/storage';
import { addTask, claimTask, forceReleaseLease, showTask, transitionTask } from '@crewyard/tasks';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { agent, operator, seedProject, testConfig } from './fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const config = testConfig();

describe('preview store', () => {
  test('returns the result of a transition and a forced lease release without keeping either', () => {
    ctx = createTestContext();
    const { projectId } = seedProject(ctx);
    const preview = { ...ctx, store: previewStore(ctx.store) };
    const idle = addTask(ctx, { projectId, title: 'idle', actor: operator }, { config });
    const held = addTask(ctx, { projectId, title: 'held', actor: operator }, { config });
    claimTask(ctx, { taskId: held.id, holder: agent('a1'), config });
    const before = { idle: showTask(ctx, idle.id), held: showTask(ctx, held.id) };

    expect(transitionTask(preview, { taskId: idle.id, to: 'CANCELLED', actor: operator, reason: 'x' })).toMatchObject({
      to: 'CANCELLED',
    });
    expect(forceReleaseLease(preview, held.id, { reason: 'x', actor: operator, to: 'READY' })).toMatchObject({
      to: 'READY',
    });

    expect(showTask(ctx, idle.id)).toEqual(before.idle);
    expect(showTask(ctx, held.id)).toEqual(before.held);
  });
});
