import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimAndPrepare,
  publishTask,
  revisionBrief,
  taskHooks,
  tasksAwaitingPublication,
} from '@crewyard/application';
import { queueTick, requestIntegration, syncRepository } from '@crewyard/integration';
import { addTask, showTask, submitWork } from '@crewyard/tasks';
import { commitWorkspaceChanges } from '@crewyard/workspaces';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

const operator = { kind: 'operator' as const, id: 'op' };
let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

describe('republishing a revised task', () => {
  test('new commits after a revision go to the existing pull request and the brief lists failing checks', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const ctx = f.ctx;
    const task = addTask(ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Write notes',
      objective: 'append notes',
      acceptanceCriteria: ['notes exist'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor: operator,
    });
    const claim = await claimAndPrepare(ctx, {
      taskId: task.id,
      holder: { kind: 'agent', id: 'agent-1' },
      actor: operator,
    });
    const credentials = { taskId: task.id, generation: claim.leaseGeneration, token: claim.claimToken };
    writeFileSync(join(claim.worktreePath!, 'NOTES.md'), 'first\n');
    await commitWorkspaceChanges(ctx, claim.workspaceId!, { message: 'first', actor: operator });
    submitWork(ctx, { ...credentials, handoff: { summary: 'first pass' } });
    expect(tasksAwaitingPublication(ctx, f.projectId)).toEqual([task.id]);

    const publish = () =>
      publishTask(ctx, {
        taskId: task.id,
        actor: operator,
        leaderId: 'leader-1',
        env: f.env,
        review: false,
        enqueue: false,
      });
    const first = await publish();
    expect(first.pullRequest?.number).toBe(1);
    expect(tasksAwaitingPublication(ctx, f.projectId)).toEqual([]);

    writeFileSync(join(claim.worktreePath!, 'NOTES.md'), 'second\n');
    const revised = await commitWorkspaceChanges(ctx, claim.workspaceId!, { message: 'second', actor: operator });
    expect(tasksAwaitingPublication(ctx, f.projectId)).toEqual([task.id]);
    const second = await publish();
    expect(second).toMatchObject({ pushed: true, operationStatus: 'reused', headSha: revised.sha });
    expect(second.pullRequest).toMatchObject({ number: 1, headSha: revised.sha });
    expect(f.mock.countCalls('POST', /\/pulls$/)).toBe(1);
    expect(tasksAwaitingPublication(ctx, f.projectId)).toEqual([]);

    f.mock.setCheck(revised.sha!, 'fmt', 'failure');
    const env = { ...f.env, hooks: taskHooks(ctx) };
    await syncRepository(ctx, f.repositoryId, env);
    await requestIntegration(ctx, { repositoryId: f.repositoryId, number: 1, requestedBy: operator }, env);
    expect(showTask(ctx, task.id).task.state).toBe('QUEUED');
    await queueTick(ctx, f.repositoryId, { leaderId: 'leader-1', env });
    expect(showTask(ctx, task.id).task.state).toBe('REVISION');
    const brief = revisionBrief(ctx, task.id)!;
    expect(brief).toContain('Pull request #1');
    expect(brief).toContain('### Failing checks');
    expect(brief).toContain('- fmt');
  }, 60_000);
});
