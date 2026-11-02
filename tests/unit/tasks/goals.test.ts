import { afterEach, describe, expect, test } from 'bun:test';
import {
  approvePlan,
  cancelGoal,
  claimTask,
  createGoal,
  goalStatus,
  heartbeat,
  listApprovals,
  type PlanProposal,
  proposePlan,
  showTask,
} from '@crewyard/tasks';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { agent, operator, seedProject, testConfig } from './fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const config = testConfig();

const plan: PlanProposal = {
  summary: 'Add search',
  tasks: [
    { key: 'api', title: 'Search API', acceptanceCriteria: ['returns hits'], scopeHints: ['src/search/**'] },
    {
      key: 'ui',
      title: 'Search UI',
      acceptanceCriteria: ['renders hits'],
      scopeHints: ['src/ui/search/**'],
      dependencies: ['api'],
    },
    { key: 'docs', title: 'Docs', acceptanceCriteria: ['documented'], scopeReason: 'docs only', dependencies: ['ui'] },
  ],
};

describe('goals and plans', () => {
  test('AI plans wait for approval, then materialise READY tasks with mapped dependencies', () => {
    ctx = createTestContext();
    const { projectId } = seedProject(ctx);
    const goal = createGoal(ctx, { projectId, title: 'Search', actor: operator });
    expect(goal.id).toBe('GOAL-1');

    const proposed = proposePlan(ctx, goal.id, { plan, source: 'ai', actor: agent('planner'), config });
    expect(proposed.goal.state).toBe('awaiting_approval');
    expect(proposed.tasks).toEqual([]);
    expect(listApprovals(ctx, { subjectKind: 'goal_plan', status: 'pending' }).map((a) => a.subjectId)).toEqual([
      goal.id,
    ]);

    const approved = approvePlan(ctx, goal.id, operator, { config });
    expect(approved.goal.state).toBe('active');
    expect(approved.tasks.map((t) => [t.id, t.state, t.dependencies])).toEqual([
      ['TASK-1', 'READY', []],
      ['TASK-2', 'READY', ['TASK-1']],
      ['TASK-3', 'READY', ['TASK-2']],
    ]);
    const status = goalStatus(ctx, goal.id);
    expect(status.total).toBe(3);
    expect(status.awaitingDependencies).toEqual(['TASK-2', 'TASK-3']);
  });

  test('invalid plans are stored with errors and never materialise', () => {
    ctx = createTestContext();
    const { projectId } = seedProject(ctx);
    const goal = createGoal(ctx, { projectId, title: 'Bad', actor: operator });
    const result = proposePlan(ctx, goal.id, {
      plan: { tasks: [{ key: 'a', title: 'A', acceptanceCriteria: ['x'], scopeHints: ['s/**'], dependencies: ['a'] }] },
      source: 'human',
      actor: operator,
      config,
    });
    expect(result.validation.valid).toBe(false);
    expect(result.goal).toMatchObject({ state: 'planning' });
    expect(result.goal.planErrors.map((e) => e.code)).toContain('CYCLE');
  });

  test('cancelling a goal cancels idle tasks and requests cancellation of active ones', () => {
    ctx = createTestContext();
    const { projectId } = seedProject(ctx);
    const goal = createGoal(ctx, { projectId, title: 'Search', actor: operator });
    const { tasks } = proposePlan(ctx, goal.id, { plan, source: 'human', actor: operator, config });
    expect(tasks).toHaveLength(3);
    const claim = claimTask(ctx, { taskId: 'TASK-1', holder: agent('a'), config });

    const result = cancelGoal(ctx, goal.id, { actor: operator, reason: 'deprioritised' });
    expect(result.cancelRequested).toEqual(['TASK-1']);
    expect(result.cancelled).toEqual(['TASK-2', 'TASK-3']);
    expect(heartbeat(ctx, claim, { config }).cancelRequested).toBe(true);
    expect(showTask(ctx, 'TASK-1').lease?.generation).toBe(1);
  });
});
