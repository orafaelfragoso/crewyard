import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EXECUTION_LIMITS,
  driveExecution,
  ExecutionSupervisor,
  initRepository,
  prepareDispatchExecution,
  submitExecution,
} from '@crewyard/application';
import { git, isProcessAlive, killTree, nowIso, processIdentity } from '@crewyard/core';
import {
  bindExecutionProcess,
  claimDueOutbox,
  getExecutionClaim,
  getOutbox,
  registerExecutionWorktree,
} from '@crewyard/storage';
import { addTask, showTask } from '@crewyard/tasks';
import { createTempGitRepo, createTestContext } from '../helpers/index.ts';
import { createGitHubFixture } from '../integration/github-fixture.ts';
import { fakeAgentSettings, seedAgent } from '../unit/agents/setup.ts';

const actor = { kind: 'operator', id: 'cleanup-lease-test' } as const;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Cleanup lease barrier timed out');
    await Bun.sleep(25);
  }
}

for (const loseLease of [false, true]) {
  test.skipIf(process.platform === 'win32')(
    `cleanup ${loseLease ? 'relinquishes lost ownership for reconciliation' : 'renews a short delivery lease'} without another supervisor stealing live work`,
    async () => {
      const ctx = createTestContext();
      const repo = await createTempGitRepo({ 'a.ts': 'export const alpha = 1;\n' });
      const { project, repository } = await initRepository(ctx, { repoPath: repo, actor, index: false });
      const limits = { ...DEFAULT_EXECUTION_LIMITS, leaseSeconds: 1 };
      const first = new ExecutionSupervisor(ctx, 'first-recovery', limits);
      const second = new ExecutionSupervisor(ctx, 'second-recovery', limits);
      const previousPath = process.env.PATH;
      const release = join(ctx.root, 'release');
      let recovering: Promise<void> | null = null;
      let child: Bun.Subprocess | null = null;
      try {
        const op = submitExecution(
          ctx,
          {
            projectId: project.id,
            repositoryId: repository.id,
            actor,
            leaderId: actor.id,
            operation: { kind: 'cleanup' },
          },
          limits,
        )!;
        child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 30_000)'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        ctx.store.immediate((db) =>
          bindExecutionProcess(
            db,
            op.intent.claim,
            {
              host: hostname(),
              pid: child!.pid,
              startIdentity: processIdentity(child!.pid)!,
            },
            nowIso(ctx.clock),
          ),
        );
        const path = join(ctx.dirs.worktrees, 'candidates', op.intent.claim.attemptId);
        mkdirSync(join(ctx.dirs.worktrees, 'candidates'), { recursive: true });
        registerExecutionWorktree(
          {
            ...ctx,
            execution: {
              claim: op.intent.claim,
              directory: op.intent.directory,
              signal: new AbortController().signal,
              onSpawn: () => {},
            },
          },
          { kind: 'candidate', repositoryPath: repo, path },
        );
        await git(repo, ['worktree', 'add', '--detach', path, 'HEAD']);
        child.kill('SIGKILL');
        await child.exited;
        const gitPath = Bun.which('git')!;
        const bin = join(ctx.root, 'bin');
        const ready = join(ctx.root, 'ready');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'git'),
          `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = remove ] && mkdir '${ctx.root}/once' 2>/dev/null; then
  printf %s $$ > '${ready}'
  while [ ! -e '${release}' ]; do sleep 0.02; done
fi
exec '${gitPath}' "$@"
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${bin}:${previousPath}`;
        recovering = first.recover();
        await waitFor(() => existsSync(ready), 5_000);
        const initial = getExecutionClaim(ctx.store.db, `outbox:${op.operationId}`)!;
        await Bun.sleep(1_200);
        const renewed = getExecutionClaim(ctx.store.db, initial.scope)!;
        expect(renewed.expiresAt > initial.expiresAt).toBe(true);
        if (loseLease)
          ctx.store.immediate((db) => {
            db.query('UPDATE execution_claims SET expires_at = ? WHERE attempt_id = ?').run(
              nowIso(ctx.clock),
              initial.attemptId,
            );
          });
        second.pump(op.operationId);
        await second.recover();
        expect(getExecutionClaim(ctx.store.db, initial.scope)!.attemptId).toBe(initial.attemptId);
        expect(isProcessAlive(Number(readFileSync(ready, 'utf8')))).toBe(true);
        writeFileSync(release, 'release');
        await recovering;
        await second.recover();
        expect(existsSync(path)).toBe(false);
        expect(getOutbox(ctx.store.db, op.operationId)!.status).toBe('failed');
        expect(getExecutionClaim(ctx.store.db, op.intent.claim.scope)!.releasedAt).not.toBeNull();
        expect(getExecutionClaim(ctx.store.db, initial.scope)!.releasedAt).not.toBeNull();
      } finally {
        writeFileSync(release, 'release');
        if (child?.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
        if (recovering) await recovering;
        await first.stop();
        await second.stop();
        process.env.PATH = previousPath;
        ctx.cleanup();
      }
    },
    15_000,
  );
}

test('recovery rechecks process binding made after its delivery observation', async () => {
  const ctx = createTestContext();
  const repo = await createTempGitRepo({ 'a.ts': 'export const alpha = 1;\n' });
  const { project, repository } = await initRepository(ctx, { repoPath: repo, actor, index: false });
  const limits = { ...DEFAULT_EXECUTION_LIMITS };
  try {
    const op = submitExecution(
      ctx,
      {
        projectId: project.id,
        repositoryId: repository.id,
        actor,
        leaderId: actor.id,
        operation: { kind: 'cleanup' },
      },
      limits,
    )!;
    ctx.store.immediate((db) =>
      db
        .query('UPDATE execution_claims SET expires_at = ? WHERE attempt_id = ?')
        .run(nowIso(ctx.clock), op.intent.claim.attemptId),
    );
    const delivery = claimDueOutbox(ctx.store, {
      ownerId: 'original',
      kinds: ['execution.launch'],
      limit: 1,
      ttlSeconds: 30,
    })[0]!;
    let transactions = 0;
    const concurrent = new ExecutionSupervisor(
      {
        ...ctx,
        store: {
          ...ctx.store,
          immediate(fn) {
            // Cancellation reconciliation and claiming run before the observed launch recovery transaction.
            transactions++;
            if (transactions === 3)
              ctx.store.immediate((db) => {
                bindExecutionProcess(
                  db,
                  delivery.claim,
                  { host: hostname(), pid: process.pid, startIdentity: processIdentity(process.pid)! },
                  nowIso(ctx.clock),
                );
              });
            return ctx.store.immediate(fn);
          },
        },
      },
      'racing-recovery',
      limits,
    );
    await concurrent.recover();
    expect(transactions).toBe(3);
    expect(getExecutionClaim(ctx.store.db, delivery.claim.scope)!.attemptId).toBe(delivery.claim.attemptId);
    expect(getExecutionClaim(ctx.store.db, delivery.claim.scope)!.releasedAt).toBeNull();
    expect(getOutbox(ctx.store.db, op.operationId)!.status).toBe('attempted');
    await concurrent.stop();
  } finally {
    ctx.cleanup();
  }
});

test.skipIf(process.platform === 'win32')(
  'direct admission recovers a frozen expired worker after its controller dies',
  async () => {
    const f = await createGitHubFixture();
    const limits = {
      ...DEFAULT_EXECUTION_LIMITS,
      global: 1,
      perProject: 1,
      leaseSeconds: 2,
      timeoutSeconds: 30,
      shutdownGraceSeconds: 1,
    };
    let controller: Bun.Subprocess | null = null;
    let workerPid = 0;
    const cleanup = new ExecutionSupervisor(f.ctx, 'final-cleanup', limits);
    try {
      mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
      writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
      const { agentId } = await seedAgent(f.ctx, {
        profiles: [{ name: 'held', settings: fakeAgentSettings(['--sleep', '30000']) }],
      });
      const task = addTask(f.ctx, {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        title: 'Recover orphan capacity',
        objective: 'Recover',
        acceptanceCriteria: ['capacity reclaimed'],
        scopeHints: [],
        risk: 'low',
        initialState: 'READY',
        origin: 'manual',
        actor,
      });
      const op = submitExecution(
        f.ctx,
        {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          actor,
          leaderId: actor.id,
          operation: prepareDispatchExecution(f.ctx, { taskId: task.id, agent: agentId, actor }),
        },
        limits,
      )!;
      controller = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
      import { createCrewContext, ExecutionSupervisor } from ${JSON.stringify(join(import.meta.dir, '../../packages/application/src/index.ts'))};
      const ctx = createCrewContext({});
      new ExecutionSupervisor(ctx, 'departed-controller', ${JSON.stringify(limits)}).pump(${JSON.stringify(op.operationId)});
      await new Promise(() => setInterval(() => {}, 1000));
    `,
        ],
        {
          env: { ...process.env, CREW_DATA_DIR: f.ctx.dirs.data, CREW_CONFIG_DIR: f.ctx.dirs.config },
          stdout: 'ignore',
          stderr: 'inherit',
        },
      );
      await waitFor(() => !!getOutbox(f.ctx.store.db, op.operationId)?.remoteCorrelation?.progress, 15_000);
      workerPid = getExecutionClaim(f.ctx.store.db, op.intent.claim.scope)!.process!.pid;
      f.ctx.store.immediate(() => process.kill(workerPid, 'SIGSTOP'));
      controller.kill('SIGKILL');
      await controller.exited;
      await Bun.sleep(2_100);
      const result = await driveExecution(
        f.ctx,
        {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          actor,
          leaderId: actor.id,
          operation: { kind: 'health' },
        },
        { ...limits, leaseSeconds: 10, timeoutSeconds: 8 },
      );
      expect(result).toEqual({ health: [] });
      expect(isProcessAlive(workerPid)).toBe(false);
      expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('cancelled');
      expect(getExecutionClaim(f.ctx.store.db, op.intent.claim.scope)!.releasedAt).not.toBeNull();
      expect(showTask(f.ctx, task.id).task.state).toBe('READY');
      expect(f.ctx.store.db.query("SELECT status FROM outbox WHERE kind = 'execution.cancel'").get()).toEqual({
        status: 'succeeded',
      });
      expect(
        f.ctx.store.db
          .query("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'execution.launch' AND status = 'succeeded'")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      if (workerPid && isProcessAlive(workerPid)) killTree(workerPid, 'SIGKILL');
      if (controller?.exitCode === null) {
        controller.kill('SIGKILL');
        await controller.exited;
      }
      await cleanup.recover();
      await cleanup.stop();
      f.cleanup();
    }
  },
  30_000,
);
