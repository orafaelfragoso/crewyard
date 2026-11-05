import { afterEach, describe, expect, test } from 'bun:test';
import { claimAndPrepare, initRepository } from '@crewyard/application';
import { git } from '@crewyard/core';
import { reconcileLeases, runRecovery } from '@crewyard/recovery';
import { addTask, heartbeat, showTask } from '@crewyard/tasks';
import { collectCommits, listWorkspaces } from '@crewyard/workspaces';
import { commitFiles, createTempGitRepo, createTestContext, ManualClock, type TestContext } from '../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function setup(clock: ManualClock) {
  ctx = createTestContext({ clock });
  const repo = await createTempGitRepo({ 'src/a.ts': 'export const a = 1;\n' });
  const init = await initRepository(ctx, { repoPath: repo, index: false, actor: { kind: 'operator', id: 'op' } });
  const task = addTask(ctx, {
    projectId: init.project.id,
    repositoryId: init.repository.id,
    title: 'Change a',
    objective: 'change a',
    acceptanceCriteria: ['done'],
    scopeHints: ['src/a.ts'],
    risk: 'low',
    initialState: 'READY',
    origin: 'manual',
    actor: { kind: 'operator', id: 'op' },
  });
  const claim = await claimAndPrepare(ctx, {
    inProcess: true,
    taskId: task.id,
    holder: { kind: 'agent', id: 'agt_x' },
    actor: { kind: 'agent', id: 'agt_x' },
  });
  return { ctx, repo, claim, taskId: task.id };
}

describe('crash recovery', () => {
  test('AT-02: agent crash after committing preserves the worktree and attributes commits to the task', async () => {
    const clock = new ManualClock();
    const { ctx: c, repo, claim, taskId } = await setup(clock);
    const sha = await commitFiles(claim.worktreePath!, { 'src/a.ts': 'export const a = 2;\n' }, 'agent work');
    clock.advance(3600);
    const report = await runRecovery(c);
    expect(report.ok).toBe(true);
    const detail = showTask(c, taskId);
    expect(detail.lease).toBeNull();
    expect(detail.task.state).toBe('BLOCKED');
    expect(detail.task.blockerReason).toBeTruthy();
    const ws = listWorkspaces(c, { taskId });
    expect(ws.length).toBe(1);
    expect(ws[0]!.state).not.toBe('cleaned');
    const commits = await collectCommits(c, ws[0]!.id);
    expect(commits.taskId).toBe(taskId);
    expect(commits.commits.map((x) => x.sha)).toContain(sha);
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('?? .crewyard/');
  });

  test('AT-14: expired generation is fenced out after reconciliation and re-claim', async () => {
    const clock = new ManualClock();
    const { ctx: c, claim, taskId } = await setup(clock);
    clock.advance(3600);
    await reconcileLeases(c);
    const old = { taskId, generation: claim.leaseGeneration, token: claim.claimToken };
    expect(() => heartbeat(c, old)).toThrow();
    const state = showTask(c, taskId).task.state;
    if (state === 'READY') {
      const second = await claimAndPrepare(c, {
        inProcess: true,
        taskId,
        holder: { kind: 'agent', id: 'agt_y' },
        actor: { kind: 'agent', id: 'agt_y' },
      });
      expect(second.leaseGeneration).toBe(claim.leaseGeneration + 1);
      expect(() => heartbeat(c, old)).toThrow();
    }
  });
});
