import { afterEach, describe, expect, test } from 'bun:test';
import { addProfile, createAccountPolicy, createAgent, routeAgent, setProfileHealth } from '@crewyard/agents';
import { addSeconds, CrewError, nowIso } from '@crewyard/core';
import { createTestContext, ManualClock, type TestContext } from '../../helpers/index.ts';
import { seedAgent, testConfig } from './setup.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function routeError(fn: () => unknown): CrewError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CrewError) return error;
    throw error;
  }
  throw new Error('expected routing to fail');
}

function insertRunningSession(c: TestContext, profileId: string, agentId: string): void {
  c.store.db
    .query(
      `INSERT INTO sessions (id, agent_id, profile_id, provider_id, state, started_at) VALUES (?, ?, ?, 'generic', 'running', ?)`,
    )
    .run(`ses_${crypto.randomUUID()}`, agentId, profileId, nowIso(c.clock));
}

describe('routing', () => {
  test('skips profiles whose provider lacks the capability without treating it as fallback', async () => {
    ctx = createTestContext();
    const local = await addProfile(ctx, { providerId: 'ollama', name: 'local', permittedModels: ['qwen3'] });
    const { profiles } = await seedAgent(ctx, { profiles: [{ name: 'fake' }] });
    const policy = createAccountPolicy(ctx, { name: 'mixed', profiles: [local.id, profiles[0]!.id] });
    const agent = createAgent(ctx, { name: 'mixed-agent', accountPolicy: policy.name });

    const execute = routeAgent(ctx, { agentId: agent.id, requiredCapability: 'execute' }, { config: testConfig() });
    expect(execute).toMatchObject({ profileId: profiles[0]!.id, fallback: false });
    expect(
      execute.explanation.some((l) => l.includes('ollama/local: skipped, provider does not support execute')),
    ).toBe(true);
    const review = routeAgent(ctx, { agentId: agent.id, requiredCapability: 'review' }, { config: testConfig() });
    expect(review).toMatchObject({ profileId: local.id, model: 'qwen3' });
  });

  test('AT-17: a rate-limited account pauses work unless fallback is explicitly authorized', async () => {
    const clock = new ManualClock();
    ctx = createTestContext({ clock });
    const { agentId, profiles } = await seedAgent(ctx, { profiles: [{ name: 'primary' }, { name: 'secondary' }] });
    const until = addSeconds(nowIso(clock), 600);
    setProfileHealth(ctx, profiles[0]!.id, { status: 'rate_limited', detail: '429', rateLimitedUntil: until });

    const paused = routeError(() =>
      routeAgent(ctx!, { agentId, requiredCapability: 'execute' }, { config: testConfig() }),
    );
    expect(paused.code).toBe('RATE_LIMITED');
    expect(paused.details).toMatchObject({ retryAt: until });
    expect(String(paused.details?.explanation)).toContain('fallback is not authorized');

    const fallback = routeAgent(
      ctx,
      { agentId, requiredCapability: 'execute' },
      { config: testConfig({ allow_profile_fallback: true }) },
    );
    expect(fallback).toMatchObject({ profileId: profiles[1]!.id, fallback: true });
    expect(fallback.explanation.at(-1)).toContain('explicitly authorized fallback');

    clock.advance(601);
    expect(routeAgent(ctx, { agentId, requiredCapability: 'execute' }, { config: testConfig() }).profileId).toBe(
      profiles[0]!.id,
    );
  });

  test('policy-level allow_fallback opts in and still honours health of every candidate', async () => {
    ctx = createTestContext();
    const { agentId, profiles } = await seedAgent(ctx, {
      profiles: [{ name: 'primary' }, { name: 'secondary' }],
      allowFallback: true,
    });
    setProfileHealth(ctx, profiles[0]!.id, { status: 'unauthenticated', detail: 'logged out' });
    setProfileHealth(ctx, profiles[1]!.id, { status: 'unavailable', detail: 'binary missing' });
    const error = routeError(() =>
      routeAgent(ctx!, { agentId, requiredCapability: 'execute' }, { config: testConfig() }),
    );
    expect(error.code).toBe('UNAVAILABLE');
  });

  test('capacity counts live sessions against max_concurrency', async () => {
    ctx = createTestContext();
    const { agentId, profiles } = await seedAgent(ctx, { profiles: [{ name: 'solo', maxConcurrency: 1 }] });
    insertRunningSession(ctx, profiles[0]!.id, agentId);
    const error = routeError(() =>
      routeAgent(ctx!, { agentId, requiredCapability: 'execute' }, { config: testConfig() }),
    );
    expect(error.code).toBe('BUSY');
    expect(String(error.details?.explanation)).toContain('at capacity (1/1');
  });

  test('model must be permitted by both the profile and the account policy', async () => {
    ctx = createTestContext();
    const { agentId } = await seedAgent(ctx, {
      profiles: [{ name: 'models', permittedModels: ['small', 'large'] }],
      models: ['large'],
    });
    const config = testConfig();
    expect(routeAgent(ctx, { agentId, requiredCapability: 'plan' }, { config }).model).toBe('large');
    expect(
      routeError(() => routeAgent(ctx!, { agentId, requiredCapability: 'plan', model: 'small' }, { config })).code,
    ).toBe('POLICY_DENIED');
    expect(
      routeError(() => routeAgent(ctx!, { agentId, requiredCapability: 'plan', model: 'huge' }, { config })).code,
    ).toBe('POLICY_DENIED');
  });

  test('budgets block routing on measured usage; unknown usage is never counted as zero spend', async () => {
    ctx = createTestContext();
    const { agentId, profiles } = await seedAgent(ctx, { profiles: [{ name: 'budgeted' }] });
    const profileId = profiles[0]!.id;
    const at = nowIso(ctx.clock);
    ctx.store.db
      .query(
        `INSERT INTO budgets (id, scope_kind, scope_id, period, token_limit, created_at) VALUES ('bud_1', 'profile', ?, 'day', 100, ?)`,
      )
      .run(profileId, at);
    const session = (id: string) =>
      ctx!.store.db
        .query(
          `INSERT INTO sessions (id, agent_id, profile_id, provider_id, state, started_at) VALUES (?, ?, ?, 'generic', 'completed', ?)`,
        )
        .run(id, agentId, profileId, at);
    session('ses_a');
    ctx.store.db
      .query(
        `INSERT INTO session_usage (session_id, provider_id, profile_id, usage_source, cost_source, at) VALUES ('ses_a', 'generic', ?, 'unknown', 'unknown', ?)`,
      )
      .run(profileId, at);
    expect(routeAgent(ctx, { agentId, requiredCapability: 'execute' }, { config: testConfig() }).profileId).toBe(
      profileId,
    );
    session('ses_b');
    ctx.store.db
      .query(
        `INSERT INTO session_usage (session_id, provider_id, profile_id, input_tokens, output_tokens, usage_source, cost_source, at) VALUES ('ses_b', 'generic', ?, 80, 40, 'measured', 'unknown', ?)`,
      )
      .run(profileId, at);
    const error = routeError(() =>
      routeAgent(ctx!, { agentId, requiredCapability: 'execute' }, { config: testConfig() }),
    );
    expect(error.code).toBe('POLICY_DENIED');
    expect(String(error.details?.explanation)).toContain('budget exceeded (profile/day)');
  });

  test('data routing policy can deny a provider', async () => {
    ctx = createTestContext();
    const { agentId } = await seedAgent(ctx);
    const config = testConfig();
    config.security = { ...config.security, data_routing: { generic: 'deny' } };
    const error = routeError(() => routeAgent(ctx!, { agentId, requiredCapability: 'execute' }, { config }));
    expect(error.code).toBe('POLICY_DENIED');
    expect(String(error.details?.explanation)).toContain('data routing denied');
  });
});
