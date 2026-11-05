import { afterEach, describe, expect, test } from 'bun:test';
import { addProfile, createAccountPolicy, createAgent } from '@crewyard/agents';
import { dispatchTask, initRepository, resumeSessionRetries } from '@crewyard/application';
import { all } from '@crewyard/storage';
import { addTask, showTask } from '@crewyard/tasks';
import { createTempGitRepo, createTestContext, ManualClock, type TestContext } from '../helpers/index.ts';
import { fakeAgentSettings } from '../unit/agents/setup.ts';

const operator = { kind: 'operator' as const, id: 'op' };
let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function setup(args: string[]) {
  const clock = new ManualClock();
  ctx = createTestContext({ clock });
  const c = ctx;
  const repo = await createTempGitRepo({ 'a/x.ts': 'export const x = 1;\n' });
  const { project, repository } = await initRepository(c, { repoPath: repo, actor: operator });
  await addProfile(c, { providerId: 'generic', name: 'flaky', settings: fakeAgentSettings(args) });
  createAccountPolicy(c, { name: 'flaky-policy', profiles: ['generic/flaky'] });
  const agent = createAgent(c, {
    name: 'worker',
    role: 'engineer',
    accountPolicy: 'flaky-policy',
    projects: [project.id],
  });
  const task = addTask(c, {
    projectId: project.id,
    repositoryId: repository.id,
    title: 'Change a',
    objective: 'change a',
    acceptanceCriteria: ['done'],
    risk: 'low',
    initialState: 'READY',
    origin: 'manual',
    actor: operator,
  });
  const dispatch = async () =>
    (await dispatchTask(c, { taskId: task.id, agent: agent.id, actor: operator, inProcess: true })).done;
  const notifications = () => all(c.store.db, 'SELECT title FROM notifications WHERE task_id = ?', task.id);
  return { c, clock, projectId: project.id, taskId: task.id, dispatch, notifications };
}

describe('failed agent sessions', () => {
  test('a crashed session returns the task to READY after a backoff, until the retry limit', async () => {
    const s = await setup(['--exit', '1']);
    for (const attempt of [1, 2]) {
      expect(await s.dispatch()).toMatchObject({ kind: 'blocked', retry: true });
      expect(showTask(s.c, s.taskId).task.state).toBe('BLOCKED');
      expect(resumeSessionRetries(s.c, s.projectId, operator)).toEqual([]);
      s.clock.advance(60 * 2 ** (attempt - 1));
      expect(resumeSessionRetries(s.c, s.projectId, operator)).toEqual([s.taskId]);
      expect(showTask(s.c, s.taskId).task.state).toBe('READY');
    }
    expect(s.notifications()).toEqual([]);
    expect(await s.dispatch()).toMatchObject({ kind: 'blocked', retry: false });
    s.clock.advance(3_600);
    expect(resumeSessionRetries(s.c, s.projectId, operator)).toEqual([]);
    expect(showTask(s.c, s.taskId).task.state).toBe('BLOCKED');
    expect(s.notifications()).toHaveLength(1);
  }, 60_000);

  test('an authentication failure stays BLOCKED with an intervention', async () => {
    const s = await setup(['--error', 'invalid api key', '--error-class', 'authentication', '--exit', '1']);
    expect(await s.dispatch()).toMatchObject({ kind: 'blocked', retry: false });
    s.clock.advance(3_600);
    expect(resumeSessionRetries(s.c, s.projectId, operator)).toEqual([]);
    expect(showTask(s.c, s.taskId).task.state).toBe('BLOCKED');
    expect(s.notifications()).toEqual([{ title: `${s.taskId} is blocked after a failed agent session` }]);
  }, 60_000);
});
