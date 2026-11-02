import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { addProfile, createAccountPolicy, createAgent } from '@agent-rail/agents';
import { initRepository, RailService } from '@agent-rail/application';
import { git } from '@agent-rail/core';
import { listEvents } from '@agent-rail/storage';
import { addTask, showTask } from '@agent-rail/tasks';
import { createTempGitRepo, createTestContext, type TestContext } from '../helpers/index.ts';

const AGENT = join(import.meta.dir, '../../fixtures/providers/committing-agent.ts');
let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(100);
  }
}

describe('service dispatch', () => {
  test('three tasks are dispatched to managed sessions in isolated worktrees and handed off', async () => {
    ctx = createTestContext();
    const c = ctx;
    const repo = await createTempGitRepo({
      'a/x.ts': 'export const x = 1;\n',
      'b/y.ts': 'export const y = 1;\n',
      'c/z.ts': 'export const z = 1;\n',
    });
    const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const { project, repository } = await initRepository(c, { repoPath: repo, actor: { kind: 'operator', id: 'op' } });
    await addProfile(c, {
      providerId: 'generic',
      name: 'committer',
      settings: { command: process.execPath, args: [AGENT, 'NOTES.md'], codingAgent: true },
      maxConcurrency: 3,
    });
    createAccountPolicy(c, { name: 'committer-policy', profiles: ['generic/committer'] });
    createAgent(c, {
      name: 'worker',
      role: 'engineer',
      accountPolicy: 'committer-policy',
      maxParallel: 3,
      projects: [project.id],
    });
    const ids = ['a', 'b', 'c'].map(
      (dir) =>
        addTask(c, {
          projectId: project.id,
          repositoryId: repository.id,
          title: `Change ${dir}`,
          objective: `change ${dir}`,
          acceptanceCriteria: ['done'],
          scopeHints: [`${dir}/`],
          risk: 'low',
          initialState: 'READY',
          origin: 'manual',
          actor: { kind: 'operator', id: 'op' },
        }).id,
    );
    const service = new RailService(c, { cycles: [] });
    await service.tick();
    await waitFor(() => ids.every((id) => showTask(c, id).task.state === 'SUBMITTED'));
    await service.stop();
    for (const id of ids) {
      const task = showTask(c, id).task;
      expect(task.handoff?.commits?.length).toBe(1);
    }
    const dispatched = listEvents(c.store, { types: ['service.dispatched'] });
    expect(new Set(dispatched.map((e) => e.payload.sessionId)).size).toBe(3);
    expect((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('?? .agent-rail/');
  }, 60_000);
});
