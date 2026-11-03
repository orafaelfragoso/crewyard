import { afterEach, describe, expect, test } from 'bun:test';
import {
  addProfile,
  createAccountPolicy,
  createAgent,
  getAgent,
  listAccountPolicies,
  listAgents,
  removeAccountPolicy,
  removeAgent,
  updateAccountPolicy,
  updateAgent,
} from '@crewyard/agents';
import { nowIso } from '@crewyard/core';
import { createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function setup(): Promise<TestContext> {
  ctx = createTestContext();
  await addProfile(ctx, { providerId: 'claude', name: 'work' });
  await addProfile(ctx, { providerId: 'claude', name: 'work-2' });
  return ctx;
}

function seedTask(c: TestContext, taskId: string, agentId: string, lease: boolean): void {
  const at = nowIso(c.clock);
  c.store.immediate((db) => {
    db.query(`INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('prj_1', 'p', ?, ?)`).run(
      at,
      at,
    );
    db.query(
      `INSERT INTO tasks (id, project_id, title, state, assigned_agent_id, created_at, updated_at, state_changed_at)
       VALUES (?, 'prj_1', 't', 'READY', ?, ?, ?, ?)`,
    ).run(taskId, agentId, at, at, at);
    if (lease) {
      db.query(
        `INSERT INTO leases (id, task_id, generation, holder_kind, holder_id, token_hash, acquired_at, expires_at, heartbeat_at)
         VALUES (?, ?, 1, 'agent', ?, 'x', ?, ?, ?)`,
      ).run(`lease_${taskId}`, taskId, agentId, at, at, at);
    }
  });
}

describe('agent management', () => {
  test('a failed create does not leave the single-account policy behind', async () => {
    const c = await setup();
    createAgent(c, { name: 'engineer', account: 'claude/work' });
    expect(() => createAgent(c, { name: 'engineer', account: 'claude/work-2' })).toThrow(/already exists/);
    expect(listAccountPolicies(c).map((p) => p.name)).toEqual(['engineer-work']);
  });

  test('update switches accounts and reports the policy it no longer uses', async () => {
    const c = await setup();
    createAgent(c, { name: 'engineer', account: 'claude/work' });
    createAccountPolicy(c, { name: 'pool', profiles: ['claude/work', 'claude/work-2'], allowFallback: true });
    const changed = updateAgent(c, 'engineer', { accountPolicy: 'pool', role: 'reviewer', maxParallel: 2 });
    expect(changed.unusedPolicies).toEqual(['engineer-work']);
    expect(changed.agent).toMatchObject({ role: 'reviewer', maxParallel: 2 });
    expect(listAccountPolicies(c).find((p) => p.name === 'pool')?.agents).toEqual(['engineer']);
    expect(updateAgent(c, 'engineer', { account: 'claude/work' }).agent.accountPolicyId).toBe(
      listAccountPolicies(c).find((p) => p.name === 'engineer-work')?.id ?? null,
    );
  });

  test('remove refuses claimed work, unassigns idle tasks and supports a dry run', async () => {
    const c = await setup();
    const agent = createAgent(c, { name: 'engineer', account: 'claude/work' });
    seedTask(c, 'TASK-1', agent.id, true);
    expect(() => removeAgent(c, 'engineer')).toThrow(/claimed tasks: TASK-1/);

    c.store.db.query('UPDATE leases SET released_at = ?').run(nowIso(c.clock));
    seedTask(c, 'TASK-2', agent.id, false);
    const preview = removeAgent(c, 'engineer', { dryRun: true });
    expect(preview.unassignedTasks).toEqual(['TASK-1', 'TASK-2']);
    expect(getAgent(c, 'engineer').id).toBe(agent.id);

    const removed = removeAgent(c, 'engineer');
    expect(removed.unusedPolicies).toEqual(['engineer-work']);
    expect(listAgents(c)).toEqual([]);
    expect(c.store.db.query('SELECT COUNT(*) AS n FROM tasks WHERE assigned_agent_id IS NOT NULL').get()).toEqual({
      n: 0,
    });
  });

  test('remove refuses an agent with a running session', async () => {
    const c = await setup();
    const agent = createAgent(c, { name: 'engineer', account: 'claude/work' });
    c.store.db
      .query(
        `INSERT INTO sessions (id, agent_id, provider_id, state, started_at) VALUES ('ses_1', ?, 'claude', 'running', ?)`,
      )
      .run(agent.id, nowIso(c.clock));
    expect(() => removeAgent(c, 'engineer')).toThrow(/running sessions: ses_1/);
  });
});

describe('account policy management', () => {
  test('update changes accounts and fallback; remove refuses policies in use', async () => {
    const c = await setup();
    createAccountPolicy(c, { name: 'pool', profiles: ['claude/work'] });
    const updated = updateAccountPolicy(c, 'pool', { profiles: ['claude/work-2', 'claude/work'], allowFallback: true });
    expect(updated).toMatchObject({ profiles: ['claude/work-2', 'claude/work'], allowFallback: true, agents: [] });

    createAgent(c, { name: 'engineer', accountPolicy: 'pool' });
    expect(() => removeAccountPolicy(c, 'pool')).toThrow(/used by engineer/);
    removeAgent(c, 'engineer');
    removeAccountPolicy(c, 'pool', { dryRun: true });
    expect(listAccountPolicies(c).map((p) => p.name)).toEqual(['pool']);
    removeAccountPolicy(c, 'pool');
    expect(listAccountPolicies(c)).toEqual([]);
  });
});

describe('agent projects', () => {
  test('update limits an agent to projects or opens it to all of them', async () => {
    const c = await setup();
    const at = nowIso(c.clock);
    c.store.db.query(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_a', 'a', ?, ?)`).run(at, at);
    createAgent(c, { name: 'engineer', account: 'claude/work' });
    expect(updateAgent(c, 'engineer', { projects: ['a'] }).agent.projectIds).toEqual(['prj_a']);
    expect(updateAgent(c, 'engineer', { projects: null }).agent.projectIds).toEqual([]);
  });
});
