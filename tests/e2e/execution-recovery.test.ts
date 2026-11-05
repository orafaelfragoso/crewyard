import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cancelExecution,
  DEFAULT_EXECUTION_LIMITS,
  driveExecution,
  ExecutionSupervisor,
  prepareDispatchExecution,
  prepareQueueExecution,
  startExecution,
  submitExecution,
} from '@crewyard/application';
import { gitText, isProcessAlive } from '@crewyard/core';
import { requestIntegration, syncRepository } from '@crewyard/integration';
import { recordPolicyRevision } from '@crewyard/projects';
import { getExecutionClaim, getOutbox, registerExecutionWorktree } from '@crewyard/storage';
import { addTask, claimTask, showTask } from '@crewyard/tasks';
import { createGitHubFixture } from '../integration/github-fixture.ts';
import { fakeAgentSettings, seedAgent } from '../unit/agents/setup.ts';

const actor = { kind: 'operator', id: 'execution-recovery-test' } as const;
const limits = { ...DEFAULT_EXECUTION_LIMITS, leaseSeconds: 30, timeoutSeconds: 30, shutdownGraceSeconds: 1 };

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Execution recovery barrier timed out');
    await Bun.sleep(25);
  }
}

for (const restarted of [false, true]) {
  test.skipIf(process.platform === 'win32')(
    `forced cancellation ${restarted ? 'after supervisor replacement' : 'from a direct caller'} preserves work and settles exact domain state`,
    async () => {
      const f = await createGitHubFixture();
      const replacement = new ExecutionSupervisor(f.ctx, 'replacement', limits);
      let workerPid = 0;
      let controller: Bun.Subprocess | null = null;
      let result: Promise<Record<string, unknown>> | null = null;
      try {
        f.config.agents.cancel_grace_seconds = 1;
        mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
        writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
        const { agentId } = await seedAgent(f.ctx, {
          profiles: [
            { name: 'held', settings: fakeAgentSettings(['--write', 'draft.txt=preserved', '--sleep', '30000']) },
          ],
        });
        const task = addTask(f.ctx, {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          title: 'Recover cancelled dispatch',
          objective: 'Preserve draft',
          acceptanceCriteria: ['draft saved'],
          scopeHints: ['draft.txt'],
          risk: 'low',
          initialState: 'READY',
          origin: 'manual',
          actor,
        });
        const request = {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          actor,
          leaderId: actor.id,
          operation: prepareDispatchExecution(f.ctx, { taskId: task.id, agent: agentId, actor }),
        };
        const handle = restarted
          ? submitExecution(f.ctx, request, limits)!
          : await startExecution(f.ctx, request, limits);
        if ('result' in handle) result = handle.result;
        else {
          controller = Bun.spawn(
            [
              process.execPath,
              '--eval',
              `
            import { createCrewContext, ExecutionSupervisor } from ${JSON.stringify(join(import.meta.dir, '../../packages/application/src/index.ts'))};
            const ctx = createCrewContext({});
            const supervisor = new ExecutionSupervisor(ctx, 'restarted-controller', ${JSON.stringify(limits)});
            supervisor.pump(${JSON.stringify(handle.operationId)});
            await new Promise(() => setInterval(() => {}, 1000));
          `,
            ],
            {
              env: { ...process.env, CREW_DATA_DIR: f.ctx.dirs.data, CREW_CONFIG_DIR: f.ctx.dirs.config },
              stdout: 'ignore',
              stderr: 'inherit',
            },
          );
        }
        const operationId = handle.operationId;
        await waitFor(() => !!getOutbox(f.ctx.store.db, operationId)?.remoteCorrelation?.progress, 10_000);
        const op = getOutbox(f.ctx.store.db, operationId)!;
        const progress = op.remoteCorrelation!.progress as {
          claim: { worktreePath: string };
          session: { sessionId: string; pid: number };
        };
        await waitFor(() => existsSync(join(progress.claim.worktreePath, 'draft.txt')), 5_000);
        const claim = getExecutionClaim(f.ctx.store.db, (op.intent.claim as { scope: string }).scope)!;
        workerPid = claim.process!.pid;
        f.ctx.store.immediate(() => process.kill(workerPid, 'SIGSTOP'));
        cancelExecution(f.ctx, operationId, 'operator requested cancellation');
        if (controller) {
          controller.kill('SIGKILL');
          await controller.exited;
        }
        const started = performance.now();
        if (result) {
          const output = await result;
          expect(output.outcome).toMatchObject({ kind: 'interrupted', commits: [expect.any(String)] });
        } else {
          await waitFor(() => {
            replacement.pump(operationId);
            return (
              getOutbox(f.ctx.store.db, operationId)!.status === 'cancelled' &&
              (
                f.ctx.store.db.query("SELECT status FROM outbox WHERE kind = 'execution.cancel'").get() as {
                  status: string;
                } | null
              )?.status === 'succeeded'
            );
          }, 8_000);
        }
        expect(performance.now() - started).toBeLessThan(8_000);
        expect(isProcessAlive(workerPid)).toBe(false);
        expect(isProcessAlive(progress.session.pid)).toBe(false);
        expect(getOutbox(f.ctx.store.db, operationId)!.status).toBe('cancelled');
        expect(f.ctx.store.db.query("SELECT status FROM outbox WHERE kind = 'execution.cancel'").get()).toEqual({
          status: 'succeeded',
        });
        expect(showTask(f.ctx, task.id).task.state).toBe('READY');
        expect(f.ctx.store.db.query('SELECT state FROM sessions WHERE id = ?').get(progress.session.sessionId)).toEqual(
          { state: 'cancelled' },
        );
        expect(
          f.ctx.store.db
            .query('SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND released_at IS NULL')
            .get(task.id),
        ).toEqual({ n: 0 });
        expect(getExecutionClaim(f.ctx.store.db, claim.scope)!.releasedAt).not.toBeNull();
        expect(await gitText(progress.claim.worktreePath, ['show', 'HEAD:draft.txt'])).toBe('preserved');
        expect(await gitText(progress.claim.worktreePath, ['status', '--porcelain'])).toBe('');
      } finally {
        if (workerPid && isProcessAlive(workerPid)) process.kill(workerPid, 'SIGCONT');
        if (controller && controller.exitCode === null) {
          controller.kill('SIGKILL');
          await controller.exited;
        }
        await replacement.stop();
        if (result) await result;
        f.cleanup();
      }
    },
    25_000,
  );
}

test.skipIf(process.platform === 'win32')(
  'cancelled validation removes only its attempt worktree after child exit',
  async () => {
    const f = await createGitHubFixture({
      config: {
        review: { enabled: false, require_review_for_high_risk: false },
        integration: { mode: 'crew-managed' },
      },
    });
    const ready = join(f.ctx.root, 'ready');
    const release = join(f.ctx.root, 'release');
    const previous = {
      PATH: process.env.PATH,
      CREW_GITHUB_API_URL: process.env.CREW_GITHUB_API_URL,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    const supervisor = new ExecutionSupervisor(f.ctx, actor.id, limits);
    try {
      f.config.validation.broad = [
        {
          name: 'barrier',
          command: [
            process.execPath,
            join(import.meta.dir, '../../fixtures/processes/execution-barrier.ts'),
            ready,
            release,
          ]
            .map((value) => JSON.stringify(value))
            .join(' '),
          timeout_seconds: 30,
          paths: [],
        },
      ];
      recordPolicyRevision(f.ctx, f.projectId, f.config, actor.id);
      const bin = join(f.ctx.root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf %s "$GH_TOKEN"\n', { mode: 0o755 });
      Object.assign(process.env, {
        PATH: `${bin}:${previous.PATH}`,
        CREW_GITHUB_API_URL: f.mock.url,
        GH_TOKEN: f.mock.token,
      });
      await f.pushBranch('change', { 'change.ts': 'export const change = 1;\n' });
      const pull = f.mock.addPull({ headRef: 'change' });
      f.mock.passChecks(pull.number);
      await syncRepository(f.ctx, f.repositoryId, f.env);
      await requestIntegration(f.ctx, { repositoryId: f.repositoryId, number: pull.number, requestedBy: actor }, f.env);
      mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
      writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
      const op = submitExecution(
        f.ctx,
        {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          actor,
          leaderId: actor.id,
          operation: prepareQueueExecution(f.ctx, f.repositoryId, {
            sync: false,
            maxCandidates: 3,
            processOutbox: false,
          }),
        },
        limits,
      )!;
      supervisor.pump(op.operationId);
      await waitFor(() => existsSync(ready), 12_000);
      const pid = Number(readFileSync(ready, 'utf8'));
      expect(readdirSync(join(op.intent.directory, 'worktrees'))).toHaveLength(1);
      expect(readdirSync(join(f.ctx.dirs.worktrees, 'candidates'))).toHaveLength(1);
      await supervisor.stop();
      expect(isProcessAlive(pid)).toBe(false);
      expect(getExecutionClaim(f.ctx.store.db, op.intent.claim.scope)!.releasedAt).not.toBeNull();
      expect(readdirSync(join(f.ctx.dirs.worktrees, 'candidates'))).toEqual([]);
      expect((await gitText(f.repo, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
    } finally {
      writeFileSync(release, 'release');
      await supervisor.stop();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      f.cleanup();
    }
  },
  25_000,
);

test('recovery preserves unregistered attempt paths and alerts instead of releasing their capacity', async () => {
  const f = await createGitHubFixture();
  const supervisor = new ExecutionSupervisor(f.ctx, actor.id, limits);
  try {
    const op = submitExecution(
      f.ctx,
      {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        actor,
        leaderId: actor.id,
        operation: { kind: 'cleanup' },
      },
      limits,
    )!;
    const path = join(f.ctx.dirs.worktrees, 'reviews', 'partial-attempt');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'preserved.txt'), 'partial Git creation');
    expect(
      registerExecutionWorktree(
        {
          ...f.ctx,
          execution: {
            claim: op.intent.claim,
            directory: op.intent.directory,
            signal: new AbortController().signal,
            onSpawn() {},
          },
        },
        { kind: 'review', repositoryPath: f.repo, path },
      ),
    ).toBe(true);
    f.ctx.store.db
      .query("UPDATE execution_claims SET expires_at = '2000-01-01T00:00:00Z' WHERE attempt_id = ?")
      .run(op.intent.claim.attemptId);
    await supervisor.recover();
    expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('ambiguous');
    expect(getExecutionClaim(f.ctx.store.db, op.intent.claim.scope)!.releasedAt).toBeNull();
    expect(readFileSync(join(path, 'preserved.txt'), 'utf8')).toBe('partial Git creation');
    expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });
    await supervisor.recover();
    expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });
  } finally {
    await supervisor.stop();
    f.cleanup();
  }
});

test('direct admission recovers expired capacity without launching unrelated pending work', async () => {
  const f = await createGitHubFixture();
  try {
    const occupied = (['sync', 'publish', 'outbox', 'health'] as const).map(
      (kind) =>
        submitExecution(
          f.ctx,
          { projectId: f.projectId, repositoryId: f.repositoryId, actor, leaderId: actor.id, operation: { kind } },
          limits,
        )!,
    );
    f.ctx.store.db.query("UPDATE execution_claims SET expires_at = '2000-01-01T00:00:00Z'").run();
    const result = await driveExecution(
      f.ctx,
      {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        actor,
        leaderId: actor.id,
        operation: { kind: 'cleanup' },
      },
      { ...limits, timeoutSeconds: 10 },
    );
    expect(result).toHaveProperty('reconciled');
    for (const op of occupied) {
      expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('failed');
      expect(getExecutionClaim(f.ctx.store.db, op.intent.claim.scope)).toMatchObject({
        process: null,
        releasedAt: expect.any(String),
      });
      expect(existsSync(join(op.intent.directory, 'worker.log'))).toBe(false);
    }
  } finally {
    f.cleanup();
  }
}, 15_000);

test('admission keeps repository identity and honors the strictest active pool limit', async () => {
  const f = await createGitHubFixture();
  try {
    f.ctx.store.db
      .query(
        "INSERT INTO repositories (id,project_id,canonical_path,default_base,created_at,updated_at) SELECT 'repo-other',project_id,canonical_path || '-other',default_base,created_at,updated_at FROM repositories WHERE id = ?",
      )
      .run(f.repositoryId);
    const request = {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      actor,
      leaderId: actor.id,
      operation: { kind: 'sync' as const },
    };
    expect(submitExecution(f.ctx, request, { ...limits, global: 1 })).not.toBeNull();
    expect(submitExecution(f.ctx, { ...request, repositoryId: 'repo-other' }, limits)).toBeNull();
    expect(submitExecution(f.ctx, { ...request, operation: { kind: 'cleanup' } }, limits)).toBeNull();
  } finally {
    f.cleanup();
  }
});

test.skipIf(process.platform === 'win32')(
  'forced cancellation before session progress preserves bootstrap changes and releases only the bound task lease',
  async () => {
    const f = await createGitHubFixture();
    const ready = join(f.ctx.root, 'bootstrap-ready');
    const release = join(f.ctx.root, 'bootstrap-release');
    let workerPid = 0;
    let result: Promise<Record<string, unknown>> | null = null;
    try {
      f.config.workspace.setup_commands = [
        [process.execPath, '--eval', "await Bun.write('bootstrap.txt', 'saved before provider launch')"]
          .map((part) => JSON.stringify(part))
          .join(' '),
        [process.execPath, join(import.meta.dir, '../../fixtures/processes/execution-barrier.ts'), ready, release]
          .map((part) => JSON.stringify(part))
          .join(' '),
      ];
      f.ctx.store.db.query('UPDATE repositories SET trusted = 1 WHERE id = ?').run(f.repositoryId);
      mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
      writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
      const { agentId } = await seedAgent(f.ctx, {
        profiles: [{ name: 'unused', settings: fakeAgentSettings(['--sleep', '30000']) }],
      });
      const createTask = (title: string) =>
        addTask(f.ctx, {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          title,
          objective: title,
          acceptanceCriteria: ['preserve work'],
          scopeHints: [],
          risk: 'low',
          initialState: 'READY',
          origin: 'manual',
          actor,
        });
      const unrelated = createTask('Unrelated active lease');
      claimTask(f.ctx, { taskId: unrelated.id, holder: { kind: 'operator', id: actor.id } });
      const task = createTask('Held bootstrap');
      const handle = await startExecution(
        f.ctx,
        {
          projectId: f.projectId,
          repositoryId: f.repositoryId,
          actor,
          leaderId: actor.id,
          operation: prepareDispatchExecution(f.ctx, { taskId: task.id, agent: agentId, actor }),
        },
        limits,
      );
      result = handle.result;
      await waitFor(() => existsSync(ready), 10_000);
      const op = getOutbox(f.ctx.store.db, handle.operationId)!;
      expect(op.remoteCorrelation?.progress).toBeUndefined();
      const domain = getExecutionClaim(f.ctx.store.db, (op.intent.claim as { scope: string }).scope)!;
      const binding = f.ctx.store.db
        .query("SELECT payload FROM events WHERE type = 'lease.execution_bound' AND correlation_id = ?")
        .get(domain.attemptId) as { payload: string };
      expect(JSON.parse(binding.payload)).toMatchObject({ leaseId: showTask(f.ctx, task.id).lease!.id, generation: 1 });
      workerPid = domain.process!.pid;
      f.ctx.store.immediate(() => process.kill(workerPid, 'SIGSTOP'));
      cancelExecution(f.ctx, handle.operationId, 'cancel bootstrap');
      expect((await result).outcome).toMatchObject({ kind: 'interrupted', commits: [expect.any(String)] });
      expect(isProcessAlive(workerPid)).toBe(false);
      expect(isProcessAlive(Number(readFileSync(ready, 'utf8')))).toBe(false);
      expect(showTask(f.ctx, task.id).task.state).toBe('READY');
      expect(showTask(f.ctx, task.id).lease).toBeNull();
      expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(task.id)).toEqual({
        n: 0,
      });
      expect(showTask(f.ctx, unrelated.id).task.state).toBe('CLAIMED');
      expect(showTask(f.ctx, unrelated.id).lease!.releasedAt).toBeNull();
      const workspace = f.ctx.store.db.query('SELECT path FROM workspaces WHERE task_id = ?').get(task.id) as {
        path: string;
      };
      expect(await gitText(workspace.path, ['show', 'HEAD:bootstrap.txt'])).toBe('saved before provider launch');
      expect(f.ctx.store.db.query("SELECT status FROM outbox WHERE kind = 'execution.cancel'").get()).toEqual({
        status: 'succeeded',
      });
    } finally {
      writeFileSync(release, 'release');
      if (workerPid && isProcessAlive(workerPid)) process.kill(workerPid, 'SIGCONT');
      if (result) await result;
      f.cleanup();
    }
  },
  20_000,
);
