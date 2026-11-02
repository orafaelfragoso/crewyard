import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { addProfile, createAccountPolicy, createAgent } from '@crewyard/agents';
import { CrewService, integrationCycles, taskHooks } from '@crewyard/application';
import { gitText } from '@crewyard/core';
import { listPullRequests } from '@crewyard/integration';
import { listEvents } from '@crewyard/storage';
import { addTask, showTask } from '@crewyard/tasks';
import { createGitHubFixture, type GitHubFixture } from '../integration/github-fixture.ts';

const AGENT = join(import.meta.dir, '../../fixtures/providers/committing-agent.ts');
let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

describe('autonomous pipeline', () => {
  test('J-02: dispatch → commit → push → PR → review → queue → merge → DONE, dependents unblocked', async () => {
    fx = await createGitHubFixture({ autonomy: 'autopilot' });
    const f = fx;
    const ctx = f.ctx;
    const envFor = () => ({ ...f.env, hooks: taskHooks(ctx) });
    await addProfile(ctx, {
      providerId: 'generic',
      name: 'committer',
      settings: { command: process.execPath, args: [AGENT, 'NOTES.md'] },
      maxConcurrency: 2,
    });
    createAccountPolicy(ctx, { name: 'p', profiles: ['generic/committer'] });
    createAgent(ctx, { name: 'worker', role: 'engineer', accountPolicy: 'p', maxParallel: 2, projects: [f.projectId] });
    const first = addTask(ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Write notes',
      objective: 'append notes',
      acceptanceCriteria: ['notes exist'],
      scopeHints: ['NOTES.md'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor: { kind: 'operator', id: 'op' },
    });
    const second = addTask(ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Follow-up',
      objective: 'depends on notes',
      acceptanceCriteria: ['done'],
      scopeHints: ['FOLLOWUP.md'],
      dependencies: [first.id],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor: { kind: 'operator', id: 'op' },
    });
    const cycles = integrationCycles(envFor).map((c) => ({ ...c, intervalSeconds: () => 0 }));
    const service = new CrewService(ctx, { cycles });
    const deadline = Date.now() + 45_000;
    while (showTask(ctx, first.id).task.state !== 'DONE' && Date.now() < deadline) {
      await service.tick();
      await Bun.sleep(150);
    }
    const done = showTask(ctx, first.id).task;
    if (done.state !== 'DONE') {
      console.log(
        done.state,
        done.blockerReason,
        listEvents(ctx.store, {
          types: [
            'service.publish',
            'service.queue',
            'service.outbox',
            'service.publish_failed',
            'service.queue_failed',
            'integration.task_transition_skipped',
          ],
          limit: 20,
          order: 'desc',
        }).map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 400)}`),
      );
    }
    expect(done.state).toBe('DONE');
    const pr = listPullRequests(ctx, { repositoryId: f.repositoryId, taskId: first.id })[0]!;
    expect(pr.state).toBe('merged');
    expect(pr.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitText(f.bare, ['cat-file', '-t', pr.mergeCommitSha!])).toBe('commit');
    expect(listEvents(ctx.store, { types: ['task.published'] }).length).toBeGreaterThanOrEqual(1);
    const deadline2 = Date.now() + 15_000;
    while (showTask(ctx, second.id).task.state === 'READY' && Date.now() < deadline2) {
      await service.tick();
      await Bun.sleep(150);
    }
    expect(showTask(ctx, second.id).task.state).not.toBe('READY');
    await service.stop();
  }, 90_000);
});
