import { afterEach, describe, expect, test } from 'bun:test';
import { addTask, claimTask, listTasks } from '@crewyard/tasks';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { agent, operator, seedProject, testConfig } from './fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe('listTasks', () => {
  test('reports who holds each task lease', () => {
    ctx = createTestContext();
    const config = testConfig();
    const { projectId } = seedProject(ctx);
    const held = addTask(ctx, { projectId, title: 'held', actor: operator }, { config });
    const idle = addTask(ctx, { projectId, title: 'idle', actor: operator }, { config });
    claimTask(ctx, { taskId: held.id, holder: agent('a1'), config });
    const items = listTasks(ctx, { projectId }).items;
    expect(items.find((t) => t.id === held.id)?.leaseHolder).toEqual(agent('a1'));
    expect(items.find((t) => t.id === idle.id)?.leaseHolder).toBeNull();
  });
});
