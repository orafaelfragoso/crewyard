import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  addProfile,
  awaitSession,
  createAccountPolicy,
  createAgent,
  getProfile,
  getSessionUsage,
  listSessionEvents,
  processIdentity,
  readSessionLog,
  reapOrphans,
  SessionSupervisor,
  stopSession,
  verifySessionToken,
} from '@agent-rail/agents';
import { isProcessAlive, nowIso, RailError } from '@agent-rail/core';
import { createTestContext, ManualClock, type TestContext, tempDir } from '../helpers/index.ts';
import { seedAgent, seedLeasedTask, testConfig } from '../unit/agents/setup.ts';

let ctx: TestContext | undefined;
const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  ctx?.cleanup();
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(20);
  }
}

describe('managed session supervision', () => {
  test('runs three concurrent managed sessions with normalized events, usage provenance and isolated cwd', async () => {
    ctx = createTestContext();
    const config = testConfig();
    config.observability = {
      ...config.observability,
      rates: [{ provider: 'generic', model: 'rated', input_per_mtok_usd: 2, output_per_mtok_usd: 10 }],
    };
    const { agentId } = await seedAgent(ctx, { maxParallel: 3 });
    const supervisor = new SessionSupervisor(ctx, { config });
    const prompts = [
      'FAKE:["--events","3","--delay","50","--usage","1000,500,0.75","--write","a.txt=1"]',
      'FAKE:["--events","3","--delay","50","--write","b.txt=2"]',
      'FAKE:["--events","3","--delay","50","--usage","1000000,100000","--write","c.txt=3"]',
    ];
    const runs = await Promise.all(
      prompts.map(async (prompt, i) => {
        const task = seedLeasedTask(ctx!);
        const cwd = tempDir('rail-wt-');
        const started = await supervisor.start({
          agentId,
          taskId: task.taskId,
          cwd,
          prompt,
          mode: 'execute',
          ...(i === 2 ? { model: 'rated' } : {}),
        });
        return { started, cwd, task };
      }),
    );
    expect(new Set(runs.map((r) => r.started.pid)).size).toBe(3);
    const records = await Promise.all(runs.map((r) => supervisor.wait(r.started.sessionId)));
    expect(records.map((r) => r.state)).toEqual(['completed', 'completed', 'completed']);
    for (const [i, file] of ['a.txt', 'b.txt', 'c.txt'].entries()) {
      expect(readFileSync(join(runs[i]!.cwd, file), 'utf8')).toBe(String(i + 1));
    }

    const events = listSessionEvents(ctx, runs[0]!.started.sessionId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['session.routed', 'token.issued', 'agent.started', 'agent.message', 'agent.tool']),
    );
    expect(records[0]!.providerSessionId).toStartWith('fake-');

    const [reported] = getSessionUsage(ctx, runs[0]!.started.sessionId);
    expect(reported).toMatchObject({ inputTokens: 1000, outputTokens: 500, costUsd: 0.75, costSource: 'reported' });
    const [unknown] = getSessionUsage(ctx, runs[1]!.started.sessionId);
    expect(unknown).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageSource: 'unknown',
      costSource: 'unknown',
    });
    const [rated] = getSessionUsage(ctx, runs[2]!.started.sessionId);
    expect(rated).toMatchObject({ usageSource: 'measured', costUsd: 3, costSource: 'configured_rate' });

    const task = ctx.store.db
      .query('SELECT selected_profile_id, routing_explanation FROM tasks WHERE id = ?')
      .get(runs[0]!.task.taskId) as { selected_profile_id: string; routing_explanation: string };
    expect(task.selected_profile_id).toBe(runs[0]!.started.profileId);
    expect(JSON.parse(task.routing_explanation)).toEqual(runs[0]!.started.routing);
  });

  test('session tokens are bound to lease generation, expire and never reach events or logs', async () => {
    const clock = new ManualClock(new Date());
    ctx = createTestContext({ clock });
    const { agentId } = await seedAgent(ctx);
    const task = seedLeasedTask(ctx, { leaseSeconds: 7200 });
    const supervisor = new SessionSupervisor(ctx, { config: testConfig() });
    const cwd = tempDir('rail-wt-');
    const tokenFile = join(cwd, 'token');
    const ready = join(cwd, 'ready');
    const started = await supervisor.start({
      agentId,
      taskId: task.taskId,
      cwd,
      mode: 'execute',
      timeoutMinutes: 5,
      prompt: `FAKE:${JSON.stringify(['--echo-env', 'RAIL_SESSION_TOKEN', '--dump-env', `RAIL_SESSION_TOKEN=${tokenFile}`, '--ready', ready, '--sleep', '1500'])}`,
    });
    const echoedMessage = () =>
      listSessionEvents(ctx!, started.sessionId, { types: ['agent.message'] })
        .map((m) => String(m.payload.text))
        .find((t) => t.startsWith('RAIL_SESSION_TOKEN='));
    await waitFor(async () => (await Bun.file(ready).exists()) && echoedMessage() !== undefined);
    const echoed = echoedMessage();
    expect(echoed).toBe('RAIL_SESSION_TOKEN=[REDACTED]');

    const token = readFileSync(tokenFile, 'utf8');
    expect(token).toStartWith('rail_');
    expect(verifySessionToken(ctx, token)).toMatchObject({
      sessionId: started.sessionId,
      agentId,
      projectId: task.projectId,
      taskId: task.taskId,
      leaseGeneration: 1,
    });
    expect(() => verifySessionToken(ctx!, agentId)).toThrow(RailError);
    expect(() => verifySessionToken(ctx!, 'rail_forged-token-value-0000000000000000000000')).toThrow('invalid');

    clock.advance(5 * 60 + 120);
    expect(() => verifySessionToken(ctx!, token)).toThrow(expect.objectContaining({ code: 'NOT_AUTHORIZED' }));
    clock.advance(-(5 * 60 + 120));
    ctx.store.db.query('UPDATE leases SET released_at = ? WHERE task_id = ?').run(nowIso(clock), task.taskId);
    expect(() => verifySessionToken(ctx!, token)).toThrow(expect.objectContaining({ code: 'NOT_AUTHORIZED' }));

    await supervisor.wait(started.sessionId);
    const all = JSON.stringify(listSessionEvents(ctx, started.sessionId, { limit: 1000 }));
    expect(all).not.toContain(token);
    expect(readFileSync(started.logPath, 'utf8')).not.toContain(token);
    expect(JSON.stringify(ctx.store.db.query('SELECT * FROM events').all())).not.toContain(token);
    expect(JSON.stringify(ctx.store.db.query('SELECT * FROM sessions').all())).not.toContain(token);
    expect(readSessionLog(ctx, started.sessionId).content).toContain('RAIL_SESSION_TOKEN=[REDACTED]');
    expect(() => verifySessionToken(ctx!, token)).toThrow(expect.objectContaining({ code: 'NOT_AUTHORIZED' }));
  });

  test('cancellation terminates the process tree within the configured grace', async () => {
    ctx = createTestContext();
    const { agentId } = await seedAgent(ctx);
    const supervisor = new SessionSupervisor(ctx, { config: testConfig({ cancel_grace_seconds: 1 }) });
    const cwd = tempDir('rail-wt-');
    const pidFile = join(cwd, 'child.pid');
    const ready = join(cwd, 'ready');
    const started = await supervisor.start({
      agentId,
      cwd,
      mode: 'execute',
      prompt: `FAKE:${JSON.stringify(['--spawn-child', pidFile, '--ready', ready, '--ignore-sigterm', '--sleep', '60000'])}`,
    });
    await waitFor(() => Bun.file(ready).exists());
    const child = Number(readFileSync(pidFile, 'utf8'));
    const before = Date.now();
    const record = await stopSession(ctx, started.sessionId, { reason: 'test' });
    expect(Date.now() - before).toBeLessThan(3_000);
    expect(record).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
    expect(isProcessAlive(started.pid)).toBe(false);
    expect(isProcessAlive(child)).toBe(false);
    expect((await awaitSession(ctx, started.sessionId)).state).toBe('cancelled');
  });

  test('provider rate limits update health and pause further routing (AT-17 end to end)', async () => {
    ctx = createTestContext();
    const { agentId, profiles } = await seedAgent(ctx);
    const supervisor = new SessionSupervisor(ctx, { config: testConfig() });
    const started = await supervisor.start({
      agentId,
      cwd: tempDir('rail-wt-'),
      mode: 'execute',
      prompt: 'FAKE:["--error","Rate limit exceeded, retry after 120 seconds","--exit","1"]',
    });
    const record = await supervisor.wait(started.sessionId);
    expect(record.state).toBe('failed');
    expect(record.errorReason).toStartWith('rate_limited:');
    const health = getProfile(ctx, profiles[0]!.id).health;
    expect(health.status).toBe('rate_limited');
    expect(Date.parse(health.rateLimitedUntil!) - Date.now()).toBeGreaterThan(100_000);
    await expect(
      supervisor.start({ agentId, cwd: tempDir('rail-wt-'), mode: 'execute', prompt: 'again' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('launch failures fail the session and mark the profile unavailable', async () => {
    ctx = createTestContext();
    await addProfile(ctx, { providerId: 'generic', name: 'broken', settings: { command: '/nonexistent/agent' } });
    createAccountPolicy(ctx, { name: 'broken-policy', profiles: ['generic/broken'] });
    const agent = createAgent(ctx, { name: 'broken-agent', accountPolicy: 'broken-policy' });
    const supervisor = new SessionSupervisor(ctx, { config: testConfig() });
    await expect(
      supervisor.start({ agentId: agent.id, cwd: tempDir('rail-wt-'), mode: 'execute', prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(getProfile(ctx, 'generic/broken').health.status).toBe('unavailable');
  });
});

describe('orphan reaping', () => {
  function insertSession(
    c: TestContext,
    input: { id: string; pid: number; supervisorPid: number; identity: string | null },
  ) {
    const at = nowIso(c.clock);
    c.store.immediate((db) => {
      db.query(
        `INSERT INTO sessions (id, provider_id, managed, pid, host, state, started_at, last_heartbeat_at) VALUES (?, 'generic', 1, ?, ?, 'running', ?, ?)`,
      ).run(input.id, input.pid, hostname(), at, at);
      db.query(
        `INSERT INTO session_events (session_id, seq, type, payload, at) VALUES (?, 1, 'session.supervised', ?, ?)`,
      ).run(input.id, JSON.stringify({ supervisorPid: input.supervisorPid, processIdentity: input.identity }), at);
    });
  }

  async function deadPid(): Promise<number> {
    const proc = Bun.spawn([process.execPath, '-e', '0']);
    await proc.exited;
    return proc.pid;
  }

  test('marks dead sessions lost and live unsupervised ones orphaned, idempotently, killing only on request', async () => {
    ctx = createTestContext();
    const deadSupervisor = await deadPid();
    insertSession(ctx, { id: 'ses_dead', pid: await deadPid(), supervisorPid: deadSupervisor, identity: null });
    const live = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { detached: true });
    spawned.push(live.pid);
    await waitFor(() => processIdentity(live.pid) !== null);
    insertSession(ctx, {
      id: 'ses_live',
      pid: live.pid,
      supervisorPid: deadSupervisor,
      identity: processIdentity(live.pid),
    });

    const first = await reapOrphans(ctx, { config: testConfig() });
    expect(first).toEqual({ lost: ['ses_dead'], orphaned: ['ses_live'], killed: [], skippedUnverifiable: [] });
    expect(getSessionUsage(ctx, 'ses_dead')[0]).toMatchObject({ usageSource: 'unknown', inputTokens: null });
    expect(isProcessAlive(live.pid)).toBe(true);

    const second = await reapOrphans(ctx, { config: testConfig() });
    expect(second).toEqual({ lost: [], orphaned: [], killed: [], skippedUnverifiable: [] });

    const killed = await reapOrphans(ctx, { config: testConfig(), killLiveOrphans: true, graceMs: 500 });
    expect(killed.killed).toEqual(['ses_live']);
    await live.exited;
    expect(isProcessAlive(live.pid)).toBe(false);
    expect((await reapOrphans(ctx, { config: testConfig(), killLiveOrphans: true })).killed).toEqual([]);
  });

  test('does not reap sessions owned by a live supervisor in this process', async () => {
    ctx = createTestContext();
    const { agentId } = await seedAgent(ctx);
    const supervisor = new SessionSupervisor(ctx, { config: testConfig() });
    const started = await supervisor.start({
      agentId,
      cwd: tempDir('rail-wt-'),
      mode: 'execute',
      prompt: 'FAKE: --sleep 500',
    });
    const result = await reapOrphans(ctx, { config: testConfig(), killLiveOrphans: true });
    expect(result.killed).toEqual([]);
    expect((await supervisor.wait(started.sessionId)).state).toBe('completed');
  });
});
