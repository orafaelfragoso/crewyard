import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountProfile,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  isProcessAlive,
  UNKNOWN_USAGE,
} from '@crewyard/core';
import { createGenericAdapter } from '@crewyard/provider-generic';
import { createOllamaAdapter } from '@crewyard/provider-ollama';
import { tempDir } from '../../helpers/index.ts';
import { fakeAgentSettings } from '../agents/setup.ts';

const TOKEN = 'crew_SuperSecretSessionToken0123456789abcdefghijkl';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function genericProfile(args: string[] = []): AccountProfile {
  return {
    id: 'prof_generic',
    providerId: 'generic',
    name: 'fake',
    displayName: 'fake',
    authMechanism: 'none',
    authRef: null,
    configRoot: null,
    permittedModels: [],
    maxConcurrency: 4,
    settings: fakeAgentSettings(args),
  };
}

function launchInput(profile: AccountProfile, prompt: string, overrides: Partial<AgentLaunch> = {}): AgentLaunch {
  const dir = tempDir('crew-adapter-');
  return {
    sessionId: `ses_${crypto.randomUUID()}`,
    profile,
    model: null,
    prompt,
    systemInstructions: null,
    cwd: dir,
    env: { CREW_SESSION_TOKEN: TOKEN },
    timeoutMs: 20_000,
    maxOutputBytes: 1_000_000,
    logPath: join(dir, 'logs', 'session.log'),
    mode: 'execute',
    ...overrides,
  };
}

async function drain(handle: AgentSessionHandle): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

describe('generic process adapter', () => {
  test('streams normalized events, measured usage and redacted logs', async () => {
    const adapter = createGenericAdapter({ cancelGraceMs: 500 });
    const input = launchInput(
      genericProfile(['--echo-env', 'CREW_SESSION_TOKEN']),
      'FAKE:["--events","2","--usage","100,40,0.25","--write","out.txt=done","--result","all good"]',
    );
    const handle = await adapter.launch(input);
    const [events, done] = await Promise.all([drain(handle), handle.done]);
    expect(events[0]).toMatchObject({ type: 'started', pid: handle.pid });
    expect(events[1]).toMatchObject({ type: 'started', pid: handle.pid, providerSessionId: expect.any(String) });
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'succeeded', exitCode: 0, result: 'all good' });
    expect(done.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.25,
      usageSource: 'measured',
      costSource: 'reported',
    });
    expect(readFileSync(join(input.cwd, 'out.txt'), 'utf8')).toBe('done');
    const log = readFileSync(input.logPath, 'utf8');
    expect(log).toContain('CREW_SESSION_TOKEN=[REDACTED]');
    expect(log).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  test('AT-20: missing usage stays unknown, never zero', async () => {
    const adapter = createGenericAdapter();
    const handle = await adapter.launch(launchInput(genericProfile(), 'no usage please'));
    const [events, done] = await Promise.all([drain(handle), handle.done]);
    expect(done.usage).toEqual(UNKNOWN_USAGE);
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  test('classifies failures from stderr and exit codes', async () => {
    const adapter = createGenericAdapter();
    const handle = await adapter.launch(
      launchInput(
        genericProfile(),
        'FAKE:["--stderr","HTTP 429 Too Many Requests; retry after 30 seconds","--exit","3"]',
      ),
    );
    const [events, done] = await Promise.all([drain(handle), handle.done]);
    expect(done).toMatchObject({ outcome: 'failed', exitCode: 3 });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ classification: 'rate_limited' });
  });

  test('enforces timeouts and output limits', async () => {
    const adapter = createGenericAdapter({ cancelGraceMs: 200 });
    const slow = await adapter.launch(launchInput(genericProfile(), 'FAKE: --sleep 10000', { timeoutMs: 300 }));
    expect((await slow.done).outcome).toBe('timed_out');
    const noisy = await adapter.launch(launchInput(genericProfile(), 'FAKE: --events 500', { maxOutputBytes: 2_000 }));
    const [events, done] = await Promise.all([drain(noisy), noisy.done]);
    expect(done.outcome).toBe('failed');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ classification: 'policy_violation' });
  });

  test('cancel terminates the whole process tree within the grace period', async () => {
    const adapter = createGenericAdapter({ cancelGraceMs: 300 });
    const input = launchInput(genericProfile(), 'x');
    const pidFile = join(input.cwd, 'child.pid');
    const ready = join(input.cwd, 'ready');
    const handle = await adapter.launch({
      ...input,
      prompt: `FAKE:${JSON.stringify(['--spawn-child', pidFile, '--ready', ready, '--ignore-sigterm', '--sleep', '30000'])}`,
    });
    const events = drain(handle);
    while (!(await Bun.file(ready).exists())) await Bun.sleep(20);
    const child = Number(readFileSync(pidFile, 'utf8'));
    expect(isProcessAlive(child)).toBe(true);
    const started = Date.now();
    await adapter.cancel(input.sessionId);
    const done = await handle.done;
    await events;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(done.outcome).toBe('cancelled');
    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(isProcessAlive(child)).toBe(false);
  });
});

describe('ollama adapter', () => {
  test('streams /api/chat with JSON schema format and reports eval counts as measured usage', async () => {
    let body: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        body = (await request.json()) as Record<string, unknown>;
        const lines = [
          { message: { role: 'assistant', content: '{"verdict":' } },
          { message: { role: 'assistant', content: '"approve"}' } },
          { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 21, eval_count: 7 },
        ];
        return new Response(lines.map((l) => JSON.stringify(l)).join('\n'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      },
    });
    cleanups.push(() => server.stop(true));
    const adapter = createOllamaAdapter();
    const profile: AccountProfile = {
      ...genericProfile(),
      providerId: 'ollama',
      authMechanism: 'local',
      permittedModels: ['qwen3'],
      settings: { endpoint: `http://127.0.0.1:${server.port}` },
    };
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    const handle = await adapter.launch(launchInput(profile, 'review this', { mode: 'review', outputSchema: schema }));
    const [events, done] = await Promise.all([drain(handle), handle.done]);
    expect(body).toMatchObject({ model: 'qwen3', stream: true, format: schema });
    expect(done).toMatchObject({ outcome: 'succeeded', result: '{"verdict":"approve"}' });
    expect(done.usage).toMatchObject({ inputTokens: 21, outputTokens: 7, usageSource: 'measured', costUsd: null });
    expect(events.map((e) => e.type)).toEqual(['started', 'message', 'usage', 'completed']);
    await expect(adapter.launch(launchInput(profile, 'code'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});
