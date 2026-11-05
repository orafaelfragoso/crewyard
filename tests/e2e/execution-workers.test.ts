import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildIndex,
  cancelExecution,
  DEFAULT_EXECUTION_LIMITS,
  ExecutionSupervisor,
  initRepository,
  prepareDispatchExecution,
  prepareIndexExecution,
  submitExecution,
} from '@crewyard/application';
import { git, gitText, isProcessAlive } from '@crewyard/core';
import { claimDueOutbox, getExecutionClaim, getOutbox, listEvents } from '@crewyard/storage';
import { addTask, showTask } from '@crewyard/tasks';
import { commitFiles, createTempGitRepo, createTestContext, type TestContext } from '../helpers/index.ts';
import { seedAgent } from '../unit/agents/setup.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());
const actor = { kind: 'operator', id: 'execution-test' } as const;

async function fixture() {
  ctx = createTestContext({ durability: 'full' });
  const repo = await createTempGitRepo({ 'src/index.ts': 'export const answer = 42;\n' });
  const initialized = await initRepository(ctx, { repoPath: repo, actor, index: false });
  return { ctx, ...initialized };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for execution');
    await Bun.sleep(25);
  }
}

test('direct index callers join one durable source worker and both receive its result', async () => {
  const { ctx: c, project } = await fixture();
  const results = await Promise.all([
    buildIndex(c, { projectId: project.id, actor }),
    buildIndex(c, { projectId: project.id, actor }),
  ]);
  expect(results[0]).toEqual(results[1]);
  const launches = c.store.db
    .query(`SELECT operation_id, status FROM outbox WHERE kind = 'execution.launch'`)
    .all() as { operation_id: string; status: string }[];
  expect(launches).toHaveLength(1);
  expect(launches[0]!.status).toBe('succeeded');
  const op = getOutbox(c.store.db, launches[0]!.operation_id)!;
  const claim = getExecutionClaim(c.store.db, (op.intent.claim as { scope: string }).scope)!;
  expect(claim.process?.pid).not.toBe(process.pid);
  expect(claim.releasedAt).not.toBeNull();
  expect(listEvents(c.store, { types: ['index.snapshot_available'] })).toHaveLength(1);
}, 30_000);

test('direct index execution accepts an exact SHA-256 repository commit', async () => {
  ctx = createTestContext();
  const repo = join(ctx.root, 'sha256');
  mkdirSync(repo);
  await git(repo, ['init', '--object-format=sha256', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'index.ts'), 'export const sha256 = true;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Initial']);
  const { project } = await initRepository(ctx, { repoPath: repo, actor, index: false });
  const result = await buildIndex(ctx, { projectId: project.id, actor });
  expect(result.snapshot.commitSha).toBe(await gitText(repo, ['rev-parse', 'HEAD']));
  expect(result.snapshot.commitSha).toHaveLength(64);
}, 30_000);

test('durable capacity admits distinct domains without duplicate scopes', async () => {
  const { ctx: c, project, repository } = await fixture();
  const limits = { ...DEFAULT_EXECUTION_LIMITS, global: 2, perProject: 2 };
  const request = {
    projectId: project.id,
    repositoryId: repository.id,
    actor,
    leaderId: actor.id,
    operation: await prepareIndexExecution(c, { projectId: project.id }),
  };
  const first = submitExecution(c, request, limits)!;
  expect(submitExecution(c, request, limits)?.operationId).toBe(first.operationId);
  expect(submitExecution(c, { ...request, operation: { kind: 'cleanup' } }, limits)).not.toBeNull();
  expect(submitExecution(c, { ...request, operation: { kind: 'health' } }, limits)).toBeNull();
  expect(c.store.db.query('SELECT COUNT(*) AS n FROM execution_claims WHERE released_at IS NULL').get()).toEqual({
    n: 2,
  });
}, 30_000);

test('source worker claims its immutable attempt before writing a domain result', async () => {
  const { ctx: c, project, repository } = await fixture();
  const op = submitExecution(
    c,
    {
      projectId: project.id,
      repositoryId: repository.id,
      actor,
      leaderId: actor.id,
      operation: await prepareIndexExecution(c, { projectId: project.id }),
    },
    { ...DEFAULT_EXECUTION_LIMITS },
  )!;
  const supervisor = new ExecutionSupervisor(c, 'test-supervisor', { ...DEFAULT_EXECUTION_LIMITS });
  try {
    supervisor.pump();
    await waitFor(() => ['succeeded', 'failed'].includes(getOutbox(c.store.db, op.operationId)!.status), 15_000);
    const result = getOutbox(c.store.db, op.operationId)!;
    if (result.status !== 'succeeded')
      throw new Error(`${result.lastError}\n${readFileSync(join(op.intent.directory, 'worker.log'), 'utf8')}`);
    expect(result.status).toBe('succeeded');
    expect(getExecutionClaim(c.store.db, op.intent.claim.scope)?.process?.startIdentity).toBeTruthy();
    expect(
      claimDueOutbox(c.store, { ownerId: 'other', kinds: ['execution.launch'], limit: 1, ttlSeconds: 30 }),
    ).toEqual([]);
  } finally {
    await supervisor.stop();
  }
}, 30_000);

test('compiled CLI executes the same private worker protocol', async () => {
  const { run } = await import('@crewyard/core');
  const { ctx: c, project, repository } = await fixture();
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const output = join(c.root, 'compiled');
  const build = await run(
    [
      process.execPath,
      join(import.meta.dir, '../../scripts/build-binaries.ts'),
      '--targets',
      `bun-${platform}-${process.arch}`,
      '--outdir',
      output,
      '--strict',
    ],
    { timeoutMs: 60_000 },
  );
  expect(build.exitCode).toBe(0);
  const op = submitExecution(
    c,
    {
      projectId: project.id,
      repositoryId: repository.id,
      actor,
      leaderId: actor.id,
      operation: await prepareIndexExecution(c, { projectId: project.id }),
    },
    { ...DEFAULT_EXECUTION_LIMITS },
  )!;
  const [delivery] = claimDueOutbox(c.store, {
    ownerId: 'compiled-test',
    kinds: ['execution.launch'],
    limit: 1,
    ttlSeconds: 120,
    operationIds: [op.operationId],
  });
  const binary = join(output, `crew-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
  const result = await run([binary, '__worker', op.operationId, delivery!.claim.attemptId], {
    timeoutMs: 20_000,
    env: { ...process.env, CREW_DATA_DIR: c.dirs.data, CREW_CONFIG_DIR: c.dirs.config },
  });
  expect(result.exitCode).toBe(0);
  expect(getOutbox(c.store.db, op.operationId)?.status).toBe('succeeded');
  const cli = await run([binary, '--project', project.id, '--json', 'index', 'update', '--force'], {
    timeoutMs: 20_000,
    env: { ...process.env, CREW_DATA_DIR: c.dirs.data, CREW_CONFIG_DIR: c.dirs.config },
  });
  expect(cli.exitCode).toBe(0);
  expect(
    c.store.db.query("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'execution.launch' AND status = 'succeeded'").get(),
  ).toEqual({ n: 2 });
}, 90_000);

for (const failure of ['crash', 'deadline'] as const) {
  test.skipIf(process.platform === 'win32')(
    `supervisor verifies Git child exit after worker ${failure} before releasing capacity`,
    async () => {
      const { ctx: c, project, repository } = await fixture();
      const ready = join(c.root, 'git-ready');
      const release = join(c.root, 'git-release');
      const realGit = Bun.which('git')!;
      const previousPath = process.env.PATH;
      const bin = join(c.root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$*" in\n *ls-tree*) echo $$ > '${ready}'; while [ ! -e '${release}' ]; do sleep 0.1; done;;\nesac\nexec '${realGit}' "$@"\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}:${previousPath}`;
      const limits = {
        ...DEFAULT_EXECUTION_LIMITS,
        global: 1,
        perProject: 1,
        leaseSeconds: 4,
        timeoutSeconds: failure === 'deadline' ? 4 : 30,
        shutdownGraceSeconds: 1,
      };
      const supervisor = new ExecutionSupervisor(c, 'process-test', limits);
      const request = {
        projectId: project.id,
        repositoryId: repository.id,
        actor,
        leaderId: 'process-test',
        operation: await prepareIndexExecution(c, { projectId: project.id }),
      };
      try {
        const op = submitExecution(c, request, limits)!;
        supervisor.pump();
        await waitFor(() => existsSync(ready), 10_000);
        const childPid = Number(readFileSync(ready, 'utf8'));
        const claim = getExecutionClaim(c.store.db, op.intent.claim.scope)!;
        expect(readdirSync(join(op.intent.directory, 'processes')).length).toBeGreaterThan(0);
        process.kill(claim.process!.pid, failure === 'crash' ? 'SIGKILL' : 'SIGSTOP');
        await waitFor(() => {
          supervisor.pump();
          return ['failed', 'cancelled'].includes(getOutbox(c.store.db, op.operationId)!.status);
        }, 12_000);
        expect(isProcessAlive(claim.process!.pid)).toBe(false);
        expect(isProcessAlive(childPid)).toBe(false);
        expect(getExecutionClaim(c.store.db, claim.scope)!.releasedAt).not.toBeNull();
        expect(submitExecution(c, request, limits)).not.toBeNull();
      } finally {
        writeFileSync(release, 'release');
        await supervisor.stop();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
    20_000,
  );
}

test('production dispatch worker tracks the provider through handoff without duplicate registration', async () => {
  const { ctx: c, project, repository } = await fixture();
  const { agentId } = await seedAgent(c, {
    profiles: [
      {
        name: 'committer',
        settings: {
          command: process.execPath,
          args: [join(import.meta.dir, '../../fixtures/providers/committing-agent.ts'), 'NOTES.md'],
          codingAgent: true,
        },
      },
    ],
  });
  const task = addTask(c, {
    projectId: project.id,
    repositoryId: repository.id,
    title: 'Write notes',
    objective: 'write notes',
    acceptanceCriteria: ['notes committed'],
    scopeHints: ['src/'],
    risk: 'low',
    initialState: 'READY',
    origin: 'manual',
    actor,
  });
  const limits = { ...DEFAULT_EXECUTION_LIMITS, shutdownGraceSeconds: 2 };
  const op = submitExecution(
    c,
    {
      projectId: project.id,
      repositoryId: repository.id,
      actor,
      leaderId: 'dispatch-test',
      operation: prepareDispatchExecution(c, { taskId: task.id, agent: agentId, actor }),
    },
    limits,
  )!;
  const supervisor = new ExecutionSupervisor(c, 'dispatch-test', limits);
  try {
    supervisor.pump();
    await waitFor(() => ['succeeded', 'failed'].includes(getOutbox(c.store.db, op.operationId)!.status), 15_000);
    const result = getOutbox(c.store.db, op.operationId)!;
    if (result.status !== 'succeeded')
      throw new Error(`${result.lastError}\n${readFileSync(join(op.intent.directory, 'worker.log'), 'utf8')}`);
    expect(showTask(c, task.id).task.state).toBe('SUBMITTED');
    expect(readdirSync(join(op.intent.directory, 'processes')).length).toBeGreaterThan(0);
  } finally {
    await supervisor.stop();
  }
}, 20_000);

test('durable cancellation prevents a pending launch without spawning a process', async () => {
  const { ctx: c, project, repository } = await fixture();
  const limits = { ...DEFAULT_EXECUTION_LIMITS };
  const op = submitExecution(
    c,
    {
      projectId: project.id,
      repositoryId: repository.id,
      actor,
      leaderId: actor.id,
      operation: await prepareIndexExecution(c, { projectId: project.id }),
    },
    limits,
  )!;
  cancelExecution(c, op.operationId, 'operator cancelled pending work');
  const supervisor = new ExecutionSupervisor(c, 'cancel-test', limits);
  try {
    supervisor.pump();
    expect(getOutbox(c.store.db, op.operationId)!.status).toBe('cancelled');
    const claim = getExecutionClaim(c.store.db, op.intent.claim.scope)!;
    expect(claim.process).toBeNull();
    expect(claim.releasedAt).not.toBeNull();
  } finally {
    await supervisor.stop();
  }
});

test.skipIf(process.platform === 'win32')(
  'direct ref callers pin distinct commits before joining a running index',
  async () => {
    const { ctx: c, project, repository } = await fixture();
    const ready = join(c.root, 'index-ready');
    const release = join(c.root, 'index-release');
    const realGit = Bun.which('git')!;
    const bin = join(c.root, 'bin');
    const previousPath = process.env.PATH;
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase "$*" in\n *ls-tree*) echo ready > '${ready}'; while [ ! -e '${release}' ]; do sleep 0.05; done;;\nesac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${previousPath}`;
    const pending: ReturnType<typeof buildIndex>[] = [];
    try {
      pending.push(buildIndex(c, { projectId: project.id, actor }));
      await waitFor(() => existsSync(ready), 10_000);
      const next = await commitFiles(repository.canonicalPath, { 'src/index.ts': 'export const answer = 43;\n' });
      pending.push(buildIndex(c, { projectId: project.id, actor }));
      writeFileSync(release, 'release');
      const [first, second] = await Promise.all(pending);
      expect(first!.snapshot.commitSha).not.toBe(next);
      expect(second!.snapshot.commitSha).toBe(next);
      expect(second!.snapshot.id).not.toBe(first!.snapshot.id);
    } finally {
      writeFileSync(release, 'release');
      await Promise.allSettled(pending);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
  20_000,
);
