import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountProfile, AgentEvent, AgentLaunch } from '@crewyard/core';
import {
  buildClaudeInvocation,
  CLAUDE_API_KEY_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  createClaudeDecoder,
} from '@crewyard/provider-claude';
import { buildCodexInvocation, CODEX_API_KEY_ENV, CODEX_HOME_ENV, createCodexDecoder } from '@crewyard/provider-codex';
import {
  classifyFailureText,
  createGenericDecoder,
  expandArgs,
  parseRetryAfterSeconds,
  type StreamDecoder,
} from '@crewyard/provider-generic';
import { buildOllamaRequest, ollamaUsage } from '@crewyard/provider-ollama';
import { buildOpencodeInvocation, createOpencodeDecoder } from '@crewyard/provider-opencode';

const FIXTURES = join(import.meta.dir, '../../fixtures/providers');
const AT = '2026-11-02T12:00:00Z';

function decode(decoder: StreamDecoder, file: string): AgentEvent[] {
  return readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => decoder.line(line, AT));
}

function profile(overrides: Partial<AccountProfile>): AccountProfile {
  return {
    id: 'prof_1',
    providerId: 'codex',
    name: 'work',
    displayName: 'work',
    authMechanism: 'cli-login',
    authRef: null,
    configRoot: '/data/profiles/codex/work',
    permittedModels: [],
    maxConcurrency: 1,
    settings: {},
    ...overrides,
  };
}

function launch(p: AccountProfile, overrides: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    sessionId: 'ses_1',
    profile: p,
    model: 'model-x',
    prompt: 'Fix the bug',
    systemInstructions: 'Be careful',
    cwd: '/work/repo',
    env: { CREW_SESSION_TOKEN: 'crew_token', CREW_TASK_ID: 'tsk_1' },
    timeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
    logPath: '/data/logs/ses_1/session.log',
    mode: 'execute',
    ...overrides,
  };
}

const baseEnv = { PATH: '/usr/bin', HOME: '/home/u', CODEX_HOME: '/home/u/.codex', OPENAI_API_KEY: 'sk-leak' };

describe('codex adapter contract', () => {
  test('normalizes codex exec --json events and measured usage', () => {
    const decoder = createCodexDecoder();
    const events = decode(decoder, 'codex/exec-success.jsonl');
    expect(events[0]).toEqual({
      type: 'started',
      at: AT,
      pid: null,
      providerSessionId: '01a19e1a-3a3a-70e1-a644-2c3b2d183aeb',
    });
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ['command', 'started'],
      ['command', 'completed'],
      ['file_change', 'completed'],
      ['mcp:crewyard.task_get', 'started'],
      ['mcp:crewyard.task_get', 'completed'],
    ]);
    const summary = decoder.summary();
    expect(summary.result).toBe("The output of the shell command 'cat a.txt' is:\n\nhi");
    expect(summary.failure).toBeNull();
    expect(summary.usage).toMatchObject({
      inputTokens: 4105,
      outputTokens: 97,
      cachedTokens: 56,
      costUsd: null,
      usageSource: 'measured',
      costSource: 'unknown',
    });
  });

  test('classifies turn failures as rate limits', () => {
    const decoder = createCodexDecoder();
    const errors = decode(decoder, 'codex/exec-rate-limited.jsonl').filter((e) => e.type === 'error');
    expect(errors.every((e) => e.type === 'error' && e.classification === 'rate_limited')).toBe(true);
    expect(decoder.summary().usage.usageSource).toBe('unknown');
    expect(parseRetryAfterSeconds(decoder.summary().failure!.message)).toBe(42 * 60);
  });

  test('isolates profiles through CODEX_HOME and passes the API key only for api-key profiles', () => {
    const cli = buildCodexInvocation(launch(profile({})), {
      executable: '/bin/codex',
      apiKey: null,
      options: { baseEnv },
    });
    expect(cli.argv).toEqual([
      '/bin/codex',
      'exec',
      '--json',
      '--cd',
      '/work/repo',
      '--sandbox',
      'workspace-write',
      '--model',
      'model-x',
      '-',
    ]);
    expect(cli.env[CODEX_HOME_ENV]).toBe('/data/profiles/codex/work');
    expect(cli.env[CODEX_API_KEY_ENV]).toBeUndefined();
    expect(cli.env.OPENAI_API_KEY).toBeUndefined();
    expect(cli.env.CREW_TASK_ID).toBe('tsk_1');
    expect(cli.stdin).toContain('Be careful');

    const review = buildCodexInvocation(
      launch(profile({ authMechanism: 'api-key', configRoot: null }), {
        mode: 'review',
        outputSchema: { type: 'object' },
      }),
      { executable: '/bin/codex', apiKey: 'sk-test-key-1234567890', options: { baseEnv } },
    );
    expect(review.argv).toContain('read-only');
    expect(review.argv).toContain('--output-schema');
    expect(review.outputSchemaPath).toBe(join('/data/logs/ses_1', 'output-schema.json'));
    expect(review.env[CODEX_API_KEY_ENV]).toBe('sk-test-key-1234567890');
    expect(review.env[CODEX_HOME_ENV]).toBe('/home/u/.codex');
  });
});

describe('claude adapter contract', () => {
  test('normalizes stream-json and prefers modelUsage with reported cost', () => {
    const decoder = createClaudeDecoder();
    const events = decode(decoder, 'claude/stream-success.jsonl');
    expect(events[0]).toMatchObject({ type: 'started', providerSessionId: '5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f' });
    expect(events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && [e.name, e.status])).toEqual([
      ['Read', 'started'],
      ['Read', 'completed'],
      ['Edit', 'started'],
      ['Edit', 'failed'],
    ]);
    expect(decoder.summary()).toEqual({
      result: 'Updated a.txt to say hello.',
      failure: null,
      usage: {
        model: 'claude-sonnet-4-6',
        inputTokens: 3557,
        outputTokens: 82,
        cachedTokens: 3000,
        costUsd: 0.0421,
        usageSource: 'measured',
        costSource: 'reported',
      },
    });
  });

  test('classifies API errors from the result message', () => {
    const decoder = createClaudeDecoder();
    decode(decoder, 'claude/stream-rate-limited.jsonl');
    expect(decoder.summary().failure).toEqual({
      message: 'Rate limit reached; retry after 120 seconds',
      classification: 'rate_limited',
    });
  });

  test('isolates profiles through CLAUDE_CONFIG_DIR and maps modes to permission modes', () => {
    const p = profile({ providerId: 'claude', configRoot: '/data/profiles/claude/work' });
    const exec = buildClaudeInvocation(launch(p), { executable: '/bin/claude', apiKey: null, options: { baseEnv } });
    expect(exec.argv.slice(0, 9)).toEqual([
      '/bin/claude',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompts',
      'none',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(exec.argv).toContain('--append-system-prompt');
    expect(exec.env[CLAUDE_CONFIG_DIR_ENV]).toBe('/data/profiles/claude/work');
    expect(exec.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
    expect(exec.stdin).toBe('Fix the bug');

    const plan = buildClaudeInvocation(
      launch({ ...p, authMechanism: 'api-key' }, { mode: 'plan', outputSchema: { type: 'object' } }),
      { executable: '/bin/claude', apiKey: 'sk-ant-test-0123456789abcdef', options: { baseEnv } },
    );
    expect(plan.argv[plan.argv.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(plan.argv[plan.argv.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(plan.env[CLAUDE_API_KEY_ENV]).toBe('sk-ant-test-0123456789abcdef');
    expect(() =>
      buildClaudeInvocation(launch({ ...p, settings: { permissionMode: 'bypassPermissions' } }), {
        executable: '/bin/claude',
        apiKey: null,
      }),
    ).toThrow('not permitted');
  });
});

describe('opencode adapter contract', () => {
  test('sums per-step tokens and cost from step_finish events', () => {
    const decoder = createOpencodeDecoder();
    const events = decode(decoder, 'opencode/run-success.jsonl');
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.status)).toEqual([
      'failed',
      'completed',
    ]);
    const { usage, result } = decoder.summary();
    expect(result).toBe('The file a.txt contains: hi');
    expect(usage).toMatchObject({ inputTokens: 4100, outputTokens: 84, cachedTokens: 8, usageSource: 'measured' });
    expect(usage.costUsd).toBeCloseTo(0.002);
    expect(usage.costSource).toBe('reported');
  });

  test('normalizes both v2 and legacy error shapes', () => {
    const decoder = createOpencodeDecoder();
    const errors = decode(decoder, 'opencode/run-error.jsonl');
    expect(errors.map((e) => e.type === 'error' && [e.message, e.classification])).toEqual([
      ['Model unavailable: nope/none', 'unknown'],
      ['Rate limit exceeded', 'rate_limited'],
    ]);
  });

  test('isolates XDG roots, runs standalone and rejects output schemas', () => {
    const p = profile({ providerId: 'opencode', configRoot: '/data/profiles/opencode/work' });
    const exec = buildOpencodeInvocation(launch(p), {
      executable: '/bin/opencode',
      apiKey: null,
      options: { baseEnv },
    });
    expect(exec.argv.slice(0, 5)).toEqual(['/bin/opencode', 'run', '--standalone', '--format', 'json']);
    expect(exec.argv).toContain('--auto');
    expect(exec.argv.at(-2)).toBe('--');
    expect(exec.env.XDG_DATA_HOME).toBe(join('/data/profiles/opencode/work', 'data'));
    expect(exec.env.XDG_CONFIG_HOME).toBe(join('/data/profiles/opencode/work', 'config'));
    const plan = buildOpencodeInvocation(launch(p, { mode: 'plan' }), { executable: '/bin/opencode', apiKey: null });
    expect(plan.argv[plan.argv.indexOf('--agent') + 1]).toBe('plan');
    expect(plan.argv).not.toContain('--auto');
    expect(() =>
      buildOpencodeInvocation(launch(p, { outputSchema: { type: 'object' } }), {
        executable: '/bin/opencode',
        apiKey: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    const keyed = buildOpencodeInvocation(
      launch({ ...p, authMechanism: 'api-key', settings: { apiKeyEnv: 'ANTHROPIC_API_KEY' } }),
      { executable: '/bin/opencode', apiKey: 'sk-ant-key-0123456789abcdef' },
    );
    expect(keyed.env.ANTHROPIC_API_KEY).toBe('sk-ant-key-0123456789abcdef');
  });
});

describe('ollama and generic contracts', () => {
  test('ollama refuses coding execution unless explicitly enabled and maps output schemas to format', () => {
    const p = profile({ providerId: 'ollama', authMechanism: 'local', configRoot: null, permittedModels: ['qwen3'] });
    expect(() => buildOllamaRequest(launch(p))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    const request = buildOllamaRequest(launch(p, { mode: 'review', model: null, outputSchema: { type: 'object' } }));
    expect(request).toMatchObject({ model: 'qwen3', stream: true, format: { type: 'object' } });
    expect(request.messages[0]).toEqual({ role: 'system', content: 'Be careful' });
    expect(buildOllamaRequest(launch({ ...p, settings: { allowCodingExecution: true } })).model).toBe('model-x');
    expect(ollamaUsage({ prompt_eval_count: 12, eval_count: 30 }, 'qwen3')).toMatchObject({
      inputTokens: 12,
      outputTokens: 30,
      usageSource: 'measured',
      costSource: 'unknown',
    });
    expect(ollamaUsage({}, 'qwen3').usageSource).toBe('unknown');
  });

  test('generic decoder follows the documented JSONL schema and never invents usage', () => {
    const decoder = createGenericDecoder('jsonl');
    const lines = [
      '{"type":"session","id":"g-1"}',
      'plain text line',
      '{"type":"tool","name":"edit","status":"failed","detail":"x.ts"}',
      '{"type":"error","message":"quota exceeded","fatal":false}',
      '{"type":"result","text":"done"}',
    ];
    const events = lines.flatMap((l) => decoder.line(l, AT));
    expect(events.map((e) => e.type)).toEqual(['started', 'log', 'tool', 'error']);
    expect(events[3]).toMatchObject({ classification: 'rate_limited' });
    expect(decoder.summary()).toEqual({
      result: 'done',
      failure: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        costUsd: null,
        usageSource: 'unknown',
        costSource: 'unknown',
      },
    });
    const p = profile({ providerId: 'generic', configRoot: null });
    expect(expandArgs(['run', '--model={model}', '--mode', '{mode}'], launch(p, { model: null }))).toEqual([
      'run',
      '--mode',
      'execute',
    ]);
  });

  test('failure text classification', () => {
    expect(classifyFailureText('HTTP 429 Too Many Requests')).toBe('rate_limited');
    expect(classifyFailureText('Not logged in')).toBe('authentication');
    expect(classifyFailureText('connect ECONNREFUSED 127.0.0.1')).toBe('transient_network');
    expect(classifyFailureText('529 overloaded_error')).toBe('transient_provider');
    expect(classifyFailureText('tests failed')).toBe('unknown');
  });
});

describe('crew MCP server and Skills in managed sessions', () => {
  const crewMcp = {
    command: '/usr/local/bin/crew',
    args: ['mcp'],
    env: { CREW_DATA_DIR: '/data', CREW_CONFIG_DIR: '/data/config' },
    forwardEnv: ['CREW_SESSION_TOKEN', 'CREW_TASK_ID'],
  };
  const tooling = { crewMcp, skillsDir: '/data/runtime/agent-skills' };

  test('claude gets an inline MCP config and the Skills plugin, never the token in argv', () => {
    const { argv, env } = buildClaudeInvocation(launch(profile({ providerId: 'claude' }), tooling), {
      executable: '/bin/claude',
      apiKey: null,
    });
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!);
    expect(config).toEqual({
      mcpServers: {
        crewyard: { type: 'stdio', command: '/usr/local/bin/crew', args: ['mcp'], env: crewMcp.env },
      },
    });
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe('/data/runtime/agent-skills');
    expect(argv.join(' ')).not.toContain('crew_token');
    expect(env.CREW_SESSION_TOKEN).toBe('crew_token');
  });

  test('codex gets config overrides that forward the session variables by name', () => {
    const { argv } = buildCodexInvocation(launch(profile({}), tooling), { executable: '/bin/codex', apiKey: null });
    const overrides = argv.filter((_, i) => argv[i - 1] === '-c');
    expect(overrides).toEqual([
      'mcp_servers.crewyard.command="/usr/local/bin/crew"',
      'mcp_servers.crewyard.args=["mcp"]',
      'mcp_servers.crewyard.env={CREW_DATA_DIR="/data",CREW_CONFIG_DIR="/data/config"}',
      'mcp_servers.crewyard.env_vars=["CREW_SESSION_TOKEN","CREW_TASK_ID"]',
    ]);
    expect(argv.at(-1)).toBe('-');
    expect(argv.join(' ')).not.toContain('crew_token');
  });

  test('opencode gets the server through inline config in its environment', () => {
    const { env } = buildOpencodeInvocation(launch(profile({ providerId: 'opencode' }), tooling), {
      executable: '/bin/opencode',
      apiKey: null,
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { crewyard: { type: 'local', command: ['/usr/local/bin/crew', 'mcp'], environment: crewMcp.env } },
    });
  });

  test('sessions without crew tooling launch exactly as before', () => {
    const { argv } = buildClaudeInvocation(launch(profile({ providerId: 'claude' })), {
      executable: '/bin/claude',
      apiKey: null,
    });
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--plugin-dir');
  });
});

describe('codex git worktrees', () => {
  test('workspace-write sessions may write the repository git directory, read-only ones may not', () => {
    const p = profile({});
    const exec = buildCodexInvocation(launch(p), {
      executable: '/bin/codex',
      apiKey: null,
      writableDirs: ['/repo/.git'],
    });
    expect(exec.argv.slice(exec.argv.indexOf('--add-dir'), exec.argv.indexOf('--add-dir') + 2)).toEqual([
      '--add-dir',
      '/repo/.git',
    ]);
    const review = buildCodexInvocation(launch(p, { mode: 'review' }), {
      executable: '/bin/codex',
      apiKey: null,
      writableDirs: ['/repo/.git'],
    });
    expect(review.argv).not.toContain('--add-dir');
  });
});
