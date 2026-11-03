import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimAndPrepare,
  integrationCycles,
  publishTask,
  revisionBrief,
  taskHooks,
  tasksAwaitingPublication,
} from '@crewyard/application';
import { git, gitText } from '@crewyard/core';
import {
  acknowledgeDivergence,
  queueTick,
  requestIntegration,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { all } from '@crewyard/storage';
import { addTask, showTask, submitWork, transitionTask } from '@crewyard/tasks';
import { commitWorkspaceChanges, getWorkspace, mergeRemoteBranch } from '@crewyard/workspaces';
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

  test('a branch changed outside Crewyard blocks publication once, and acknowledging lets the revision merge it', async () => {
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
    writeFileSync(join(claim.worktreePath!, 'NOTES.md'), 'first\n');
    await commitWorkspaceChanges(ctx, claim.workspaceId!, { message: 'first', actor: operator });
    submitWork(ctx, {
      taskId: task.id,
      generation: claim.leaseGeneration,
      token: claim.claimToken,
      handoff: { summary: 'first' },
    });
    const env = { ...f.env, hooks: taskHooks(ctx) };
    await publishTask(ctx, {
      taskId: task.id,
      actor: operator,
      leaderId: 'leader-1',
      env,
      review: false,
      enqueue: false,
    });

    await git(f.repo, ['fetch', '-q', 'origin']);
    await git(f.repo, ['checkout', '-q', '-B', 'outside', `origin/${claim.branch}`]);
    writeFileSync(join(f.repo, 'OUTSIDE.md'), 'outside\n');
    await git(f.repo, ['add', '-A']);
    await git(f.repo, ['commit', '-q', '-m', 'outside change']);
    await git(f.repo, ['push', '-q', 'origin', `outside:${claim.branch}`]);
    const outside = await gitText(f.repo, ['rev-parse', 'HEAD']);
    await git(f.repo, ['checkout', '-q', 'main']);
    await syncRepository(ctx, f.repositoryId, env);

    writeFileSync(join(claim.worktreePath!, 'NOTES.md'), 'stale revision\n');
    await commitWorkspaceChanges(ctx, claim.workspaceId!, { message: 'stale', actor: operator });
    const publish = integrationCycles(() => env).find((c) => c.name === 'publish')!;
    const cycle = await publish.run(ctx, { projectId: f.projectId, leaderId: 'leader-1', leaderGeneration: 1 });
    expect(JSON.stringify(cycle)).toContain('outside Crewyard');
    expect(showTask(ctx, task.id).task.state).toBe('BLOCKED');
    expect(tasksAwaitingPublication(ctx, f.projectId)).toEqual([]);
    expect(all<{ title: string }>(ctx.store.db, 'SELECT title FROM notifications WHERE task_id = ?', task.id)).toEqual([
      { title: `${task.id} cannot publish: its branch moved outside Crewyard` },
    ]);

    const pr = showPullRequest(ctx, { repositoryId: f.repositoryId, number: 1 });
    await acknowledgeDivergence(ctx, pr.id, operator, env);
    expect(getWorkspace(ctx, claim.workspaceId!).expectedRemoteHead).toBe(outside);

    transitionTask(ctx, { taskId: task.id, to: 'READY', actor: operator, reason: 'retry after acknowledging' });
    const retry = await claimAndPrepare(ctx, {
      taskId: task.id,
      holder: { kind: 'agent', id: 'agent-1' },
      actor: operator,
    });
    const update = await mergeRemoteBranch(ctx, retry.workspaceId!, { actor: operator });
    expect(update).toMatchObject({ status: 'merged', remoteHead: outside });
    submitWork(ctx, {
      taskId: task.id,
      generation: retry.leaseGeneration,
      token: retry.claimToken,
      handoff: { summary: 'retried' },
    });
    const republished = await publishTask(ctx, {
      taskId: task.id,
      actor: operator,
      leaderId: 'leader-1',
      env,
      review: false,
      enqueue: false,
    });
    expect(republished).toMatchObject({ pushed: true, headSha: update.headSha });
  }, 60_000);
});
