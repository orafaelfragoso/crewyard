import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimAndPrepare, publishTask, reconcileMergedTasks, taskHooks } from '@crewyard/application';
import {
  type IntegrationEnv,
  queueTick,
  requestIntegration,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { addTask, showTask, submitWork } from '@crewyard/tasks';
import { commitWorkspaceChanges } from '@crewyard/workspaces';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

const operator = { kind: 'operator' as const, id: 'op' };
let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

async function queuedTask(f: GitHubFixture, env: IntegrationEnv): Promise<{ taskId: string; prId: string }> {
  const task = addTask(f.ctx, {
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
  const claim = await claimAndPrepare(f.ctx, {
    taskId: task.id,
    holder: { kind: 'agent', id: 'agent-1' },
    actor: operator,
  });
  writeFileSync(join(claim.worktreePath!, 'NOTES.md'), 'notes\n');
  await commitWorkspaceChanges(f.ctx, claim.workspaceId!, { message: 'notes', actor: operator });
  submitWork(f.ctx, {
    taskId: task.id,
    generation: claim.leaseGeneration,
    token: claim.claimToken,
    handoff: { summary: 'notes' },
  });
  const published = await publishTask(f.ctx, {
    taskId: task.id,
    actor: operator,
    leaderId: 'leader-1',
    env,
    review: false,
    enqueue: false,
  });
  const pr = published.pullRequest!;
  f.mock.passChecks(pr.number);
  await syncRepository(f.ctx, f.repositoryId, env);
  await requestIntegration(f.ctx, { prId: pr.id, requestedBy: operator }, env);
  expect(showTask(f.ctx, task.id).task.state).toBe('QUEUED');
  return { taskId: task.id, prId: pr.id };
}

describe('merged pull requests finish their task', () => {
  test('the merge response sha completes the task while GitHub still reports no merge commit', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const env = { ...f.env, hooks: taskHooks(f.ctx) };
    const { taskId, prId } = await queuedTask(f, env);
    f.mock.pendingMergeCommits.add(1);
    for (let i = 0; i < 4 && showTask(f.ctx, taskId).task.state !== 'DONE'; i++) {
      await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env });
    }
    expect(showTask(f.ctx, taskId).task.state).toBe('DONE');
    expect(showPullRequest(f.ctx, { prId }).mergeCommitSha).toBe(f.mock.pull(1).mergeCommitSha);
  }, 60_000);

  test('a merge commit that appears after the merge was observed completes the task', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const env = { ...f.env, hooks: taskHooks(f.ctx) };
    const { taskId, prId } = await queuedTask(f, env);
    f.mock.pendingMergeCommits.add(1);
    f.mock.mergeExternally(1);
    await syncRepository(f.ctx, f.repositoryId, env);
    expect(showPullRequest(f.ctx, { prId })).toMatchObject({ state: 'merged', mergeCommitSha: null });
    expect(showTask(f.ctx, taskId).task.state).toBe('QUEUED');
    f.mock.pendingMergeCommits.clear();
    await syncRepository(f.ctx, f.repositoryId, env);
    expect(showTask(f.ctx, taskId).task.state).toBe('DONE');
  }, 60_000);

  test('reconciliation advances a task whose merged pull request was recorded without it', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const env = { ...f.env, hooks: taskHooks(f.ctx) };
    const { taskId } = await queuedTask(f, env);
    f.mock.mergeExternally(1);
    await syncRepository(f.ctx, f.repositoryId, f.env);
    expect(showTask(f.ctx, taskId).task.state).toBe('QUEUED');
    expect(await reconcileMergedTasks(f.ctx, f.repositoryId, env)).toEqual([taskId]);
    expect(showTask(f.ctx, taskId).task.state).toBe('DONE');
    expect(await reconcileMergedTasks(f.ctx, f.repositoryId, env)).toEqual([]);
  }, 60_000);
});

describe('queue entries drive their task', () => {
  test('a blocked entry that becomes eligible returns its task to QUEUED', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const env = { ...f.env, hooks: taskHooks(f.ctx) };
    const { taskId } = await queuedTask(f, env);
    const tick = () => queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env, maxCandidates: 0 });
    f.mock.requireChecks('main', ['ci', 'security-scan']);
    await tick();
    expect(showTask(f.ctx, taskId).task.state).toBe('BLOCKED');
    f.mock.passChecks(1, ['ci', 'security-scan']);
    await tick();
    expect(showTask(f.ctx, taskId).task.state).toBe('QUEUED');
  }, 60_000);
});
