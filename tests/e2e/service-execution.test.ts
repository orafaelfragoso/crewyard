import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CrewService,
  claimAndPrepare,
  DEFAULT_EXECUTION_LIMITS,
  initRepository,
  submitExecution,
} from '@crewyard/application';
import { git, gitText, isProcessAlive } from '@crewyard/core';
import { requestIntegration, syncRepository } from '@crewyard/integration';
import { getLeadership, getOutbox, listEvents } from '@crewyard/storage';
import { addTask, submitWork } from '@crewyard/tasks';
import { createTempGitRepo } from '../helpers/index.ts';
import { createGitHubFixture } from '../integration/github-fixture.ts';

const actor = { kind: 'operator', id: 'worker-test' } as const;
const BARRIER = join(import.meta.dir, '../../fixtures/processes/execution-barrier.ts');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for execution barrier');
    await Bun.sleep(25);
  }
}

test('validation held at a process barrier does not block same-branch publication, sync or another project', async () => {
  const f = await createGitHubFixture({
    config: {
      review: { enabled: false, require_review_for_high_risk: false },
      integration: { mode: 'crew-managed' },
    },
  });
  const ready = join(f.ctx.root, 'validation-ready');
  const release = join(f.ctx.root, 'release-validation');
  f.config.validation.broad = [
    {
      name: 'barrier',
      command: [process.execPath, BARRIER, ready, release].map(quote).join(' '),
      timeout_seconds: 30,
      paths: [],
    },
  ];
  mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
  const previousUrl = process.env.CREW_GITHUB_API_URL;
  const previousToken = process.env.GH_TOKEN;
  const previousPath = process.env.PATH;
  const bin = join(f.ctx.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf %s "$GH_TOKEN"\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.CREW_GITHUB_API_URL = f.mock.url;
  process.env.GH_TOKEN = f.mock.token;
  const limits = { ...DEFAULT_EXECUTION_LIMITS, global: 6, perProject: 4, shutdownGraceSeconds: 2 };
  const service = new CrewService(f.ctx, { dispatch: false, execution: limits });
  let barrierPid = 0;
  try {
    await f.pushBranch('first-change', { 'first.ts': 'export const first = 1;\n' });
    mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
    writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
    const pull = f.mock.addPull({ headRef: 'first-change' });
    f.mock.passChecks(pull.number);
    await syncRepository(f.ctx, f.repositoryId, f.env);
    await requestIntegration(f.ctx, { repositoryId: f.repositoryId, number: pull.number, requestedBy: actor }, f.env);
    const otherRepo = await createTempGitRepo({ 'second.ts': 'export const second = 2;\n' });
    const other = await initRepository(f.ctx, { repoPath: otherRepo, actor, index: false });
    await service.tick();
    await waitFor(() => existsSync(ready), 15_000);
    barrierPid = Number(readFileSync(ready, 'utf8'));
    expect(isProcessAlive(barrierPid)).toBe(true);
    const leadershipScope = `integration:${f.repositoryId}:main`;
    const beforeLease = getLeadership(f.ctx.store, leadershipScope)!;
    const beforeSyncCalls = f.mock.countCalls('GET', /\/pulls(?:\?|$)/);

    const task = addTask(f.ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Publish while validation waits',
      objective: 'publish notes',
      acceptanceCriteria: ['notes published'],
      scopeHints: ['NOTES.md'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor,
    });
    const prepared = await claimAndPrepare(f.ctx, {
      taskId: task.id,
      holder: { kind: 'agent', id: 'direct-worker' },
      actor,
    });
    writeFileSync(join(prepared.worktreePath!, 'NOTES.md'), 'published during validation\n');
    await git(prepared.worktreePath!, ['add', 'NOTES.md']);
    await git(prepared.worktreePath!, ['commit', '-q', '-m', 'notes']);
    const head = await gitText(prepared.worktreePath!, ['rev-parse', 'HEAD']);
    submitWork(f.ctx, {
      taskId: task.id,
      generation: prepared.leaseGeneration,
      token: prepared.claimToken,
      handoff: { summary: 'notes', commits: [head] },
    });
    const sync = submitExecution(
      f.ctx,
      {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        actor,
        leaderId: service.workerId,
        operation: { kind: 'sync' },
      },
      limits,
    )!;
    const publish = submitExecution(
      f.ctx,
      {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        actor,
        leaderId: service.workerId,
        operation: { kind: 'publish' },
      },
      limits,
    )!;
    await waitFor(
      () =>
        getOutbox(f.ctx.store.db, sync.operationId)?.status === 'succeeded' &&
        getOutbox(f.ctx.store.db, publish.operationId)?.status === 'succeeded',
      15_000,
    );
    expect(f.mock.countCalls('GET', /\/pulls(?:\?|$)/)).toBeGreaterThan(beforeSyncCalls);
    expect(listEvents(f.ctx.store, { types: ['task.published'], taskId: task.id })).toHaveLength(1);
    await waitFor(
      () => listEvents(f.ctx.store, { types: ['index.snapshot_available'], projectId: other.project.id }).length > 0,
      10_000,
    );
    await waitFor(() => getLeadership(f.ctx.store, leadershipScope)!.expiresAt > beforeLease.expiresAt, 3_000);
    expect(isProcessAlive(barrierPid)).toBe(true);
    expect(existsSync(release)).toBe(false);
    const stoppedAt = performance.now();
    await service.stop();
    expect(performance.now() - stoppedAt).toBeLessThan(4_000);
    await waitFor(() => !isProcessAlive(barrierPid), 3_000);
    expect(
      f.ctx.store.db
        .query("SELECT intent FROM outbox WHERE kind = 'execution.launch'")
        .all()
        .some((row) => JSON.stringify(row).includes(f.mock.token)),
    ).toBe(false);
  } catch (error) {
    console.error(
      f.ctx.store.db
        .query(
          "SELECT json_extract(intent, '$.operation.kind') AS operation, status, last_error FROM outbox WHERE kind = 'execution.launch'",
        )
        .all(),
    );
    console.error(listEvents(f.ctx.store, { limit: 30, order: 'desc' }).map((event) => [event.type, event.payload]));
    throw error;
  } finally {
    writeFileSync(release, 'release');
    await service.stop();
    process.env.PATH = previousPath;
    if (previousUrl === undefined) delete process.env.CREW_GITHUB_API_URL;
    else process.env.CREW_GITHUB_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    f.cleanup();
  }
}, 60_000);
