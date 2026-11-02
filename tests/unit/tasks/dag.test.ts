import { afterEach, describe, expect, test } from 'bun:test';
import { RailError } from '@agent-rail/core';
import { listEvents } from '@agent-rail/storage';
import { addTask, findCycle, listTasks, transitionTask, updateTask, validatePlan } from '@agent-rail/tasks';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { driveToState, operator, seedProject, testConfig } from './fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const config = testConfig();

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof RailError ? error.code : 'NOT_RAIL_ERROR';
  }
  return undefined;
}

describe('dependency DAG', () => {
  test('findCycle reports direct and indirect cycles deterministically', () => {
    expect(findCycle(new Map([['a', ['a']]]))).toEqual(['a', 'a']);
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', ['a']],
        ]),
      ),
    ).toEqual(['a', 'b', 'c', 'a']);
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', []],
        ]),
      ),
    ).toBeNull();
  });

  test('task updates reject indirect cycles and unknown dependencies', () => {
    ctx = createTestContext();
    const { projectId } = seedProject(ctx);
    const a = addTask(ctx, { projectId, title: 'A', actor: operator }, { config });
    const b = addTask(ctx, { projectId, title: 'B', dependencies: [a.id], actor: operator }, { config });
    const c = addTask(ctx, { projectId, title: 'C', dependencies: [b.id], actor: operator }, { config });
    const c2 = ctx;
    expect(
      code(() =>
        updateTask(c2, a.id, {
          patch: { dependencies: [c.id] },
          expectedRevision: a.revision,
          actor: operator,
          config,
        }),
      ),
    ).toBe('CYCLE_DETECTED');
    expect(
      code(() => addTask(c2, { projectId, title: 'D', dependencies: ['TASK-999'], actor: operator }, { config })),
    ).toBe('NOT_FOUND');
    expect(
      code(() =>
        updateTask(c2, a.id, { patch: { title: 'A2' }, expectedRevision: a.revision - 1, actor: operator, config }),
      ),
    ).toBe('CONFLICT');
  });

  test('plan validation reports every structural problem', () => {
    const result = validatePlan(
      {
        tasks: [
          { key: 'a', title: 'A', acceptanceCriteria: ['ok'], scopeHints: ['src/a/**'], dependencies: ['c'] },
          { key: 'a', title: 'dup', acceptanceCriteria: ['ok'], scopeHints: ['src/x'] },
          { key: 'b', title: 'B', acceptanceCriteria: [], dependencies: ['missing'] },
          {
            key: 'c',
            title: 'C',
            acceptanceCriteria: ['ok'],
            scopeReason: 'docs only',
            dependencies: ['a'],
            repositoryId: 'repo_x',
          },
        ],
      },
      { existingTaskIds: new Set(['TASK-1']), allowedRepositoryIds: new Set(['repo_main']) },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code).sort()).toEqual([
      'CYCLE',
      'DUPLICATE_KEY',
      'MISSING_ACCEPTANCE_CRITERIA',
      'REPOSITORY_NOT_ALLOWED',
      'SCOPE_UNSUITABLE',
      'UNKNOWN_DEPENDENCY',
    ]);
  });

  test('dependency release is emitted once and is stable under retries', () => {
    ctx = createTestContext();
    const c = ctx;
    const { projectId } = seedProject(ctx);
    const a = addTask(ctx, { projectId, title: 'A', actor: operator }, { config });
    const b = addTask(ctx, { projectId, title: 'B', actor: operator }, { config });
    const child = addTask(ctx, { projectId, title: 'child', dependencies: [b.id, a.id], actor: operator }, { config });
    const dispatchable = () => listTasks(c, { projectId, dispatchable: true }).items.map((t) => t.id);

    expect(listTasks(ctx, { projectId }).items.find((t) => t.id === child.id)?.blockedByDependencies).toEqual([
      a.id,
      b.id,
    ]);
    expect(dispatchable()).toEqual([a.id, b.id]);

    driveToState(ctx, a.id, 'MERGED', config);
    expect(code(() => transitionTask(c, { taskId: a.id, to: 'MERGED', actor: operator }))).toBe('INVALID_TRANSITION');
    driveToState(ctx, b.id, 'MERGED', config);
    transitionTask(ctx, { taskId: b.id, to: 'DONE', actor: operator });

    const released = listEvents(ctx.store, { types: ['task.dependencies_satisfied'] });
    expect(released.map((e) => [e.taskId, e.payload.releasedBy])).toEqual([[child.id, b.id]]);
    expect(dispatchable()).toEqual([child.id]);
  });
});
