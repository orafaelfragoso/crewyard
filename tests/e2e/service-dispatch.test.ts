import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { addProfile, createAccountPolicy, createAgent, getSession, listSessions } from '@crewyard/agents';
import { CrewService, initRepository, type ProjectCycle } from '@crewyard/application';
import { git } from '@crewyard/core';
import { all, listEvents } from '@crewyard/storage';
import { addTask, showTask } from '@crewyard/tasks';
import { createTempGitRepo, createTestContext, type TestContext } from '../helpers/index.ts';
import { fakeAgentSettings } from '../unit/agents/setup.ts';

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
    const service = new CrewService(c, { cycles: [], freeDiskBytes: () => Number.POSITIVE_INFINITY });
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
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('?? .crewyard/');
  }, 60_000);

  test('stopping the service interrupts running sessions, saves their work and requeues the task', async () => {
    ctx = createTestContext();
    const c = ctx;
    const repo = await createTempGitRepo({ 'a/x.ts': 'export const x = 1;\n' });
    const { project, repository } = await initRepository(c, { repoPath: repo, actor: { kind: 'operator', id: 'op' } });
    await addProfile(c, {
      providerId: 'generic',
      name: 'slow',
      settings: {
        ...fakeAgentSettings(['--write', 'a/wip.ts=export const wip = 1;\n', '--sleep', '60000']),
        codingAgent: true,
      },
    });
    createAccountPolicy(c, { name: 'slow-policy', profiles: ['generic/slow'] });
    createAgent(c, { name: 'worker', role: 'engineer', accountPolicy: 'slow-policy', projects: [project.id] });
    const { id } = addTask(c, {
      projectId: project.id,
      repositoryId: repository.id,
      title: 'Change a',
      objective: 'change a',
      acceptanceCriteria: ['done'],
      scopeHints: ['a/'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor: { kind: 'operator', id: 'op' },
    });
    const service = new CrewService(c, {
      cycles: [],
      tickSeconds: 3600,
      freeDiskBytes: () => Number.POSITIVE_INFINITY,
    });
    const running = service.start();
    await waitFor(() => showTask(c, id).task.state === 'RUNNING');
    const [session] = listSessions(c, { taskId: id });
    const wip = new Bun.Glob('*/a/wip.ts');
    await waitFor(() => [...wip.scanSync({ cwd: join(c.dirs.data, 'worktrees'), onlyFiles: true })].length === 1);

    await service.stop();
    await running;

    expect(showTask(c, id).task.state).toBe('READY');
    expect(showTask(c, id).lease).toBeNull();
    expect(getSession(c, session!.id).state).toBe('cancelled');
    const finished = listEvents(c.store, { types: ['service.dispatch_finished'] });
    expect(finished.at(-1)?.payload.outcome).toMatchObject({ kind: 'interrupted', commits: [expect.any(String)] });
  }, 60_000);

  test('low disk space starts no session and raises one intervention across repeated ticks', async () => {
    ctx = createTestContext();
    const c = ctx;
    const repo = await createTempGitRepo({ 'a/x.ts': 'export const x = 1;\n' });
    const { project, repository } = await initRepository(c, { repoPath: repo, actor: { kind: 'operator', id: 'op' } });
    await addProfile(c, {
      providerId: 'generic',
      name: 'idle',
      settings: { ...fakeAgentSettings(['--sleep', '60000']), codingAgent: true },
    });
    createAccountPolicy(c, { name: 'idle-policy', profiles: ['generic/idle'] });
    createAgent(c, { name: 'worker', role: 'engineer', accountPolicy: 'idle-policy', projects: [project.id] });
    const { id } = addTask(c, {
      projectId: project.id,
      repositoryId: repository.id,
      title: 'Change a',
      objective: 'change a',
      acceptanceCriteria: ['done'],
      scopeHints: ['a/'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor: { kind: 'operator', id: 'op' },
    });
    const service = new CrewService(c, { cycles: [], freeDiskBytes: () => 2 * 1024 ** 3 });
    await service.tick();
    await service.tick();
    await service.stop();

    expect(listSessions(c, { taskId: id })).toEqual([]);
    expect(all(c.store.db, 'SELECT title FROM notifications WHERE project_id = ?', project.id)).toEqual([
      { title: `Disk space low for ${project.name}` },
    ]);
  }, 30_000);

  test('cycles hand long work to the background without blocking later ticks or shutdown', async () => {
    ctx = createTestContext();
    const c = ctx;
    const repo = await createTempGitRepo({ 'a.ts': 'export const a = 1;\n' });
    await initRepository(c, { repoPath: repo, actor: { kind: 'operator', id: 'op' } });
    const { promise: slow, resolve: release } = Promise.withResolvers<void>();
    let runs = 0;
    const cycle: ProjectCycle = {
      name: 'slow',
      intervalSeconds: () => 0,
      async run(_ctx, input) {
        runs++;
        input.background(slow);
        return {};
      },
    };
    const service = new CrewService(c, { cycles: [cycle], dispatch: false });
    await service.tick();
    await service.tick();
    expect(runs).toBe(2);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  }, 30_000);
});
