import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerUnmanagedAgent } from '@crewyard/agents';
import {
  allocateTaskWorkspace,
  DEFAULT_EXECUTION_LIMITS,
  dispatchTask,
  reviewPullRequest,
  submitExecution,
} from '@crewyard/application';
import { nowIso } from '@crewyard/core';
import { listPullRequests, syncRepository } from '@crewyard/integration';
import { claimDueOutbox, completeOutbox, getExecutionClaim, releaseExecutionClaim } from '@crewyard/storage';
import { addTask, claimTask } from '@crewyard/tasks';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createGitHubFixture } from '../integration/github-fixture.ts';
import { fakeAgentSettings, seedAgent } from '../unit/agents/setup.ts';

const CLI = join(import.meta.dir, '../../apps/cli/src/main.ts');
const MCP = join(import.meta.dir, '../../apps/mcp/src/main.ts');
const actor = { kind: 'operator', id: 'direct-test' } as const;

test.skipIf(process.platform === 'win32')(
  'CLI and MCP defaults execute durable review, queue and workspace workers without a service',
  async () => {
    const f = await createGitHubFixture();
    const client = new Client({ name: 'direct-execution-test', version: '1' });
    let connected = false;
    try {
      await f.pushBranch('feature', { 'feature.ts': 'export const answer = 42;\n' });
      const pull = f.mock.addPull({ headRef: 'feature' });
      f.mock.passChecks(pull.number);
      await syncRepository(f.ctx, f.repositoryId, f.env);
      mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
      writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
      const bin = join(f.ctx.root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf %s "$GH_TOKEN"\n', { mode: 0o755 });
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CREW_DATA_DIR: f.ctx.dirs.data,
        CREW_CONFIG_DIR: f.ctx.dirs.config,
        CREW_GITHUB_API_URL: f.mock.url,
        GH_TOKEN: f.mock.token,
      };
      for (const args of [
        ['review', 'request', String(pull.number), '--type', 'code', '--force'],
        ['queue', 'tick'],
      ]) {
        const child = Bun.spawn([process.execPath, CLI, '--project', f.projectId, '--json', ...args], {
          cwd: f.repo,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exit, stderr, ok: JSON.parse(stdout).ok }).toEqual({ exit: 0, stderr: '', ok: true });
      }
      const agent = registerUnmanagedAgent(f.ctx, {
        name: 'external',
        projects: [f.projectId],
        allowedTools: ['crew_claim_task', 'crew_request_review'],
      });
      const task = addTask(f.ctx, {
        projectId: f.projectId,
        repositoryId: f.repositoryId,
        title: 'Review change',
        objective: 'Check the change',
        acceptanceCriteria: ['reviewed'],
        scopeHints: ['feature.ts'],
        risk: 'low',
        initialState: 'READY',
        origin: 'manual',
        actor,
      });
      const pr = listPullRequests(f.ctx, { repositoryId: f.repositoryId })[0]!;
      f.ctx.store.db.query('UPDATE pull_requests SET task_id = ? WHERE id = ?').run(task.id, pr.id);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [MCP],
          cwd: f.repo,
          env: Object.fromEntries(
            Object.entries({ ...env, CREW_AGENT: agent.name }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stderr: 'ignore',
        }),
      );
      connected = true;
      for (const name of ['crew_claim_task', 'crew_request_review']) {
        const result = await client.callTool({ name, arguments: { taskId: task.id } });
        expect(result.structuredContent).toMatchObject({ ok: true });
      }
      const launches = f.ctx.store.db
        .query("SELECT operation_id, status, intent FROM outbox WHERE kind = 'execution.launch'")
        .all() as { operation_id: string; status: string; intent: string }[];
      expect(launches.map((row) => JSON.parse(row.intent).operation.kind).sort()).toEqual([
        'queue',
        'review',
        'review',
        'workspace',
      ]);
      expect(launches.every((row) => row.status === 'succeeded')).toBe(true);
      for (const row of launches) {
        const intent = JSON.parse(row.intent);
        const claim = getExecutionClaim(f.ctx.store.db, intent.claim.scope)!;
        expect(claim.process?.pid).not.toBe(process.pid);
        expect(claim.releasedAt).not.toBeNull();
        expect(row.intent).not.toContain('claimToken');
      }
      expect(f.ctx.store.db.query("SELECT COUNT(*) AS n FROM worker_heartbeats WHERE kind = 'service'").get()).toEqual({
        n: 0,
      });
      await reviewPullRequest(f.ctx, { prId: pr.id, types: ['code'], force: true }, f.env);
      expect(f.ctx.store.db.query("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'execution.launch'").get()).toEqual({
        n: launches.length,
      });
    } finally {
      if (connected) await client.close();
      f.cleanup();
    }
  },
  30_000,
);

test('direct dispatch callers join one worker and interruption preserves its task work', async () => {
  const f = await createGitHubFixture();
  try {
    f.config.agents.cancel_grace_seconds = 1;
    mkdirSync(join(f.repo, '.crewyard'), { recursive: true });
    writeFileSync(join(f.repo, '.crewyard/config.yaml'), JSON.stringify(f.config));
    const { agentId } = await seedAgent(f.ctx, {
      profiles: [{ name: 'held', settings: fakeAgentSettings(['--write', 'draft.txt=preserved', '--sleep', '30000']) }],
    });
    const task = addTask(f.ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Preserve direct work',
      objective: 'Leave a draft',
      acceptanceCriteria: ['draft preserved'],
      scopeHints: ['draft.txt'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor,
    });
    const [first, joined] = await Promise.all([
      dispatchTask(f.ctx, { taskId: task.id, agent: agentId, actor }),
      dispatchTask(f.ctx, { taskId: task.id, agent: agentId, actor }),
    ]);
    expect(joined.session.sessionId).toBe(first.session.sessionId);
    expect(first.claim).not.toHaveProperty('claimToken');
    const deadline = performance.now() + 5_000;
    while (!existsSync(join(first.claim.worktreePath!, 'draft.txt'))) {
      if (performance.now() >= deadline) throw new Error('provider did not write its draft');
      await Bun.sleep(25);
    }
    const interrupted = await first.interrupt('operator stopped direct work');
    expect(interrupted).toMatchObject({ kind: 'interrupted', commits: [expect.any(String)] });
    expect(await joined.done).toEqual(interrupted);
    expect(
      f.ctx.store.db
        .query(
          "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'execution.launch' AND json_extract(intent, '$.operation.kind') = 'dispatch'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      f.ctx.store.db.query('SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND released_at IS NULL').get(task.id),
    ).toEqual({ n: 0 });
  } finally {
    f.cleanup();
  }
}, 30_000);

test('workspace callers waiting for pool capacity cannot allocate after their original task lease expires', async () => {
  const f = await createGitHubFixture();
  try {
    const task = addTask(f.ctx, {
      projectId: f.projectId,
      repositoryId: f.repositoryId,
      title: 'Waiting workspace',
      objective: 'Allocate safely',
      acceptanceCriteria: ['lease stays current'],
      scopeHints: ['feature.ts'],
      risk: 'low',
      initialState: 'READY',
      origin: 'manual',
      actor,
    });
    const holder = { kind: 'operator', id: actor.id } as const;
    const lease = claimTask(f.ctx, { taskId: task.id, holder });
    const occupied = (['sync', 'publish', 'cleanup', 'health'] as const).map(
      (kind) =>
        submitExecution(
          f.ctx,
          {
            projectId: f.projectId,
            repositoryId: f.repositoryId,
            actor,
            leaderId: actor.id,
            operation: { kind },
          },
          { ...DEFAULT_EXECUTION_LIMITS },
        )!,
    );
    let settled = false;
    const waiting = allocateTaskWorkspace(f.ctx, {
      taskId: task.id,
      actor,
      expectedLease: { id: lease.leaseId, generation: lease.generation, holder },
    }).then(
      (value) => {
        settled = true;
        return { value, error: null };
      },
      (error: unknown) => {
        settled = true;
        return { value: null, error };
      },
    );
    await Bun.sleep(100);
    expect(settled).toBe(false);
    f.ctx.store.db.query("UPDATE leases SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(lease.leaseId);
    const deliveries = claimDueOutbox(f.ctx.store, {
      ownerId: actor.id,
      kinds: ['execution.launch'],
      operationIds: occupied.map((op) => op.operationId),
      limit: 4,
      ttlSeconds: 30,
    });
    f.ctx.store.immediate((db) => {
      const at = nowIso(f.ctx.clock);
      for (const op of occupied) releaseExecutionClaim(db, op.intent.claim, at);
      for (const op of deliveries)
        completeOutbox(db, op, { status: 'cancelled', error: 'fixture released capacity' }, at);
    });
    const result = await waiting;
    expect(result.value).toBeNull();
    expect(String(result.error)).toContain('lease');
    expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM workspaces WHERE task_id = ?').get(task.id)).toEqual({
      n: 0,
    });
  } finally {
    f.cleanup();
  }
}, 30_000);
