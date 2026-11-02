import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  addProfile,
  createAccountPolicy,
  createMemorySecretStore,
  dataRoutingDecision,
  defaultAgentRuntimeConfig,
  getAccountPolicy,
  listProfiles,
  registerUnmanagedAgent,
  removeProfile,
  routeAgent,
  setProfileHealth,
  testProfile,
} from '@crewyard/agents';
import { addSeconds, nowIso } from '@crewyard/core';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { fakeAgentSettings } from './setup.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const API_KEY = 'sk-ant-api03-secretvalue0123456789abcdef';

function dumpTables(c: TestContext): string {
  return ['provider_profiles', 'events', 'audit_events', 'provider_health']
    .map((t) => JSON.stringify(c.store.db.query(`SELECT * FROM ${t}`).all()))
    .join('\n');
}

describe('account profiles', () => {
  test('api-key credentials live only in the secret store and removal deletes them', async () => {
    ctx = createTestContext();
    const secrets = createMemorySecretStore();
    const profile = await addProfile(
      ctx,
      { providerId: 'claude', name: 'ci', authMechanism: 'api-key', apiKey: API_KEY, permittedModels: ['sonnet'] },
      { secrets },
    );
    expect(profile.authRef).toBe('profile.claude.ci');
    expect(await secrets.get('profile.claude.ci')).toBe(API_KEY);
    expect(profile.configRoot).toBe(join(ctx.dirs.data, 'profiles', 'claude', 'ci'));
    expect(existsSync(profile.configRoot!)).toBe(true);
    expect(dumpTables(ctx)).not.toContain(API_KEY);

    const policy = createAccountPolicy(ctx, { name: 'ci-policy', profiles: ['claude/ci'] });
    const removed = await removeProfile(ctx, 'claude/ci', { purgeConfigRoot: true }, { secrets });
    expect(removed.removedFromPolicies).toEqual(['ci-policy']);
    expect(removed.configRootPurged).toBe(true);
    expect(getAccountPolicy(ctx, policy.id).profileIds).toEqual([]);
    expect(secrets.names()).toEqual([]);
    expect(listProfiles(ctx)).toEqual([]);
  });

  test('rejects secrets in settings, unsupported auth and shared identities', async () => {
    ctx = createTestContext();
    const secrets = createMemorySecretStore();
    await expect(
      addProfile(ctx, { providerId: 'generic', name: 'bad', settings: { command: 'x', env: { API_TOKEN: API_KEY } } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      addProfile(ctx, { providerId: 'ollama', name: 'k', authMechanism: 'api-key', apiKey: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const root = join(ctx.root, 'shared-root');
    await addProfile(ctx, { providerId: 'codex', name: 'a', configRoot: root }, { secrets });
    await expect(
      addProfile(ctx, { providerId: 'codex', name: 'b', configRoot: root }, { secrets }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await addProfile(ctx, { providerId: 'codex', name: 'default', useProviderDefaultConfig: true });
    await expect(
      addProfile(ctx, { providerId: 'codex', name: 'default2', useProviderDefaultConfig: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(secrets.names()).toEqual([]);
  });

  test('test validates through the adapter and keeps an active rate limit', async () => {
    ctx = createTestContext();
    await addProfile(ctx, { providerId: 'generic', name: 'fake', settings: fakeAgentSettings() });
    await addProfile(ctx, { providerId: 'generic', name: 'missing', settings: { command: '/nonexistent/agent' } });
    expect((await testProfile(ctx, 'generic/fake')).profile.health.status).toBe('healthy');
    expect((await testProfile(ctx, 'generic/missing')).profile.health.status).toBe('unavailable');

    const until = addSeconds(nowIso(ctx.clock), 300);
    setProfileHealth(ctx, 'generic/fake', { status: 'rate_limited', detail: '429', rateLimitedUntil: until });
    const tested = await testProfile(ctx, 'generic/fake');
    expect(tested.profile.health).toMatchObject({ status: 'rate_limited', rateLimitedUntil: until });
  });
});

describe('unmanaged agents and data egress', () => {
  test('unmanaged agents expose limitations and are never routed', () => {
    ctx = createTestContext();
    const agent = registerUnmanagedAgent(ctx, { name: 'external-cursor', allowedTools: ['task_claim', 'task_submit'] });
    expect(agent.managed).toBe(false);
    expect(agent.allowedMcpTools).toEqual(['task_claim', 'task_submit']);
    expect(agent.limitations.join(' ')).toContain('No automatic cancellation');
    expect(() => routeAgent(ctx!, { agentId: agent.id, requiredCapability: 'execute' })).toThrow('unmanaged');
  });

  test('data routing honours profile, provider and wildcard rules plus offline mode', () => {
    const config = defaultAgentRuntimeConfig();
    expect(dataRoutingDecision(config, 'claude')).toMatchObject({ decision: 'allow', destination: 'remote' });
    expect(dataRoutingDecision(config, 'claude').disclosure).toContain('Anthropic');
    const denied = {
      security: { ...config.security, data_routing: { '*': 'deny' as const, ollama: 'allow' as const } },
    };
    expect(dataRoutingDecision(denied, 'codex').decision).toBe('deny');
    expect(dataRoutingDecision(denied, 'ollama').decision).toBe('allow');
    const offline = { security: { ...config.security, network: 'offline' as const } };
    expect(dataRoutingDecision(offline, 'codex').decision).toBe('deny');
    expect(dataRoutingDecision(offline, 'ollama')).toMatchObject({ decision: 'allow', destination: 'local' });
  });
});
