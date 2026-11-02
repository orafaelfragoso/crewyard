import { afterEach, describe, expect, test } from 'bun:test';
import { admitTasks, explainDispatch, type SchedulerSnapshot, type SchedulerTask } from '@agent-rail/scheduler';
import { addTask, claimTask, setTaskPaused } from '@agent-rail/tasks';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { agent, operator, seedProject, testConfig } from '../tasks/fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const AT = '2026-11-02T12:00:00Z';

function task(id: string, extra: Partial<SchedulerTask> = {}): SchedulerTask {
  return {
    id,
    projectId: 'prj_1',
    repositoryId: 'repo_1',
    state: 'READY',
    title: id,
    risk: 'medium',
    priority: 50,
    priorityOverride: null,
    effectivePriority: extra.priorityOverride ?? extra.priority ?? 50,
    createdAt: AT,
    stateChangedAt: AT,
    deadline: null,
    paused: false,
    assignedAgentId: null,
    selectedProfileId: null,
    budgetTokens: null,
    scopes: [],
    blockedByDependencies: [],
    approvalSatisfied: true,
    hasActiveLease: false,
    transitiveDependents: 0,
    ...extra,
  };
}

function snapshot(tasks: SchedulerTask[], extra: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot {
  return {
    projectId: 'prj_1',
    at: AT,
    autonomy: 'guarded',
    intakePaused: false,
    workersPaused: false,
    tasks,
    reservations: [],
    running: { global: 0, project: 0, byRepository: {}, byAgent: {}, byAccount: {} },
    integration: { openPrs: 0, queueDepth: 0, oldestQueueAgeMinutes: null },
    recoveryDemand: tasks.filter((t) => t.state === 'REVISION').length,
    budgets: [],
    providerCapacity: null,
    projectShare: 0,
    ...extra,
  };
}

describe('scheduler admission', () => {
  test('ordering: override wins, unblock potential lifts score, ties break on task id', () => {
    const config = testConfig();
    const result = admitTasks(
      snapshot([
        task('TASK-10'),
        task('TASK-2'),
        task('TASK-3', { transitiveDependents: 3 }),
        task('TASK-4', { priority: 10, priorityOverride: 5 }),
      ]),
      config,
    );
    expect(result.admitted.map((a) => a.taskId)).toEqual(['TASK-4', 'TASK-3', 'TASK-2', 'TASK-10']);
    expect(result.admitted[1]?.score.unblock).toBe(15);

    const strict = admitTasks(
      snapshot([task('TASK-2', { priority: 40, effectivePriority: 40 }), task('TASK-1', { transitiveDependents: 5 })]),
      testConfig({ scheduler: { fairness: 'strict-priority' } }),
    );
    expect(strict.admitted.map((a) => a.taskId)).toEqual(['TASK-1', 'TASK-2']);
  });

  test('backpressure stops new implementation but keeps recovery capacity, deterministically', () => {
    const config = testConfig({ scheduler: { max_open_prs: 3 }, agents: { max_parallel: 3 } });
    const snap = snapshot([task('TASK-1'), task('TASK-2', { state: 'REVISION' })], {
      integration: { openPrs: 3, queueDepth: 3, oldestQueueAgeMinutes: 10 },
    });
    const first = admitTasks(snap, config);
    expect(first.admitted.map((a) => [a.taskId, a.workClass])).toEqual([['TASK-2', 'recovery']]);
    expect(first.deferred.map((d) => [d.taskId, d.code])).toEqual([['TASK-1', 'BACKPRESSURE_OPEN_PRS']]);
    expect(admitTasks(snap, config)).toEqual(first);
  });

  test('WIP, capacity reservation, exclusive scopes and budgets produce exact reason codes', () => {
    const config = testConfig({
      agents: { max_parallel: 4 },
      scheduler: { reserve_recovery_capacity: 1, wip: { agent: 1 } },
    });
    const result = admitTasks(
      snapshot(
        [
          task('TASK-1', { scopes: [{ scope: 'schema:db', mode: 'exclusive', source: 'explicit' }] }),
          task('TASK-2', { scopes: [{ scope: 'schema:db', mode: 'exclusive', source: 'explicit' }] }),
          task('TASK-3', { assignedAgentId: 'busy' }),
          task('TASK-4', { scopes: [{ scope: 'src/api/**', mode: 'advisory', source: 'explicit' }] }),
          task('TASK-5'),
          task('TASK-6', { state: 'REVISION' }),
          task('TASK-7', { budgetTokens: 900_000 }),
        ],
        {
          running: { global: 1, project: 1, byRepository: { repo_1: 1 }, byAgent: { busy: 1 }, byAccount: {} },
          reservations: [{ taskId: 'TASK-9', scope: 'src/api/users.ts', mode: 'advisory' }],
          budgets: [
            {
              scopeKind: 'project',
              scopeId: 'prj_1',
              period: 'day',
              tokenLimit: 1_000_000,
              tokensUsed: 500_000,
              costLimitUsd: null,
              costUsedUsd: 0,
              usageComplete: true,
            },
          ],
        },
      ),
      config,
    );
    expect(result.capacity).toMatchObject({ total: 3, implementation: 2, recovery: 3, reservedForRecovery: 1 });
    expect(result.admitted.map((a) => a.taskId)).toEqual(['TASK-6', 'TASK-1', 'TASK-5']);
    expect(Object.fromEntries(result.deferred.map((d) => [d.taskId, d.code]))).toEqual({
      'TASK-2': 'EXCLUSIVE_SCOPE_CONFLICT',
      'TASK-3': 'WIP_AGENT',
      'TASK-4': 'CAPACITY_EXHAUSTED',
      'TASK-7': 'TASK_BUDGET_EXCEEDS_REMAINING',
    });
  });

  test('explainDispatch reports policy reasons from the live database', () => {
    ctx = createTestContext();
    const c = ctx;
    const config = testConfig();
    const { projectId } = seedProject(c);
    const add = (title: string, extra: Partial<Parameters<typeof addTask>[1]> = {}) =>
      addTask(c, { projectId, title, actor: operator, ...extra }, { config });
    const holder = add('holder', { exclusiveResources: ['lock:search'] });
    const waiting = add('waiting', { exclusiveResources: ['lock:search'] });
    const child = add('child', { dependencies: [holder.id] });
    const risky = add('risky', { scopeHints: ['infra/terraform/main.tf'] });
    const paused = add('paused');
    setTaskPaused(c, paused.id, true, operator);
    claimTask(c, { taskId: holder.id, holder: agent('a'), config });

    const code = (id: string) => {
      const explanation = explainDispatch(c, id, { config });
      return explanation.admitted ? 'ADMITTED' : explanation.deferral.code;
    };
    expect(code(holder.id)).toBe('NOT_DISPATCHABLE_STATE');
    expect(code(waiting.id)).toBe('EXCLUSIVE_SCOPE_CONFLICT');
    expect(code(child.id)).toBe('DEPENDENCIES_UNSATISFIED');
    expect(code(risky.id)).toBe('APPROVAL_PENDING');
    expect(code(paused.id)).toBe('TASK_PAUSED');
  });
});
