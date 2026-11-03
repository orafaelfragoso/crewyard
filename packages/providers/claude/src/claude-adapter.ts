import { mkdirSync } from 'node:fs';
import {
  type AccountProfile,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  type Capabilities,
  CrewError,
  type FailureClass,
  type ProfileHealth,
  type ProviderAdapter,
  run,
} from '@crewyard/core';
import {
  type AdapterOptions,
  arr,
  childEnv,
  classifyFailureText,
  classifyHttpStatus,
  compareVersions,
  createUsageAccumulator,
  type DecoderSummary,
  health,
  isObject,
  num,
  obj,
  ProcessSessions,
  parseJsonLine,
  probeVersion,
  resolveApiKey,
  resolveExecutable,
  type StreamDecoder,
  settingBool,
  settingString,
  settingStrings,
  str,
  truncate,
} from '@crewyard/provider-generic';

export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_MIN_VERSION = '2.1.259';

const EXECUTE_PERMISSION_MODES: ReadonlySet<string> = new Set(['acceptEdits', 'auto', 'dontAsk']);

export function claudeBinary(profile: AccountProfile): string {
  return settingString(profile, 'binary') ?? 'claude';
}

export function claudeIsolationEnv(profile: AccountProfile): Record<string, string> {
  return profile.configRoot ? { [CLAUDE_CONFIG_DIR_ENV]: profile.configRoot } : {};
}

export function claudeLoginCommand(profile: AccountProfile): { argv: string[]; env: Record<string, string> } {
  return { argv: [claudeBinary(profile), 'auth', 'login'], env: claudeIsolationEnv(profile) };
}

function permissionMode(launch: AgentLaunch): string {
  if (launch.mode !== 'execute') return 'plan';
  const configured = settingString(launch.profile, 'permissionMode') ?? 'acceptEdits';
  if (!EXECUTE_PERMISSION_MODES.has(configured)) {
    throw new CrewError('POLICY_DENIED', `Claude permission mode ${configured} is not permitted for managed sessions`, {
      suggestion: 'Use acceptEdits, auto or dontAsk.',
    });
  }
  return configured;
}

export interface ClaudeInvocation {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
}

export function buildClaudeInvocation(
  launch: AgentLaunch,
  input: { executable: string; apiKey: string | null; options?: AdapterOptions },
): ClaudeInvocation {
  const argv = [
    input.executable,
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompts',
    'none',
    '--permission-mode',
    permissionMode(launch),
  ];
  if (launch.model) argv.push('--model', launch.model);
  if (launch.systemInstructions) argv.push('--append-system-prompt', launch.systemInstructions);
  if (launch.outputSchema) argv.push('--json-schema', JSON.stringify(launch.outputSchema));
  if (settingBool(launch.profile, 'bare')) argv.push('--bare');
  const allowedTools = settingStrings(launch.profile, 'allowedTools');
  if (allowedTools.length > 0) argv.push('--allowedTools', allowedTools.join(','));
  const env = childEnv(input.options ?? {}, launch.profile.configRoot ? [] : [CLAUDE_CONFIG_DIR_ENV], {
    ...claudeIsolationEnv(launch.profile),
    ...launch.env,
    ...(input.apiKey ? { [CLAUDE_API_KEY_ENV]: input.apiKey } : {}),
  });
  return { argv, env, stdin: launch.prompt };
}

const ASSISTANT_ERROR_CLASSES: Record<string, FailureClass> = {
  rate_limit: 'rate_limited',
  authentication_failed: 'authentication',
  oauth_org_not_allowed: 'authentication',
  account_on_hold: 'authentication',
  billing_error: 'authentication',
  cloud_credential_error: 'authentication',
  overloaded: 'transient_provider',
  server_error: 'transient_provider',
};

function withCache(input: number | null, read: number, write: number): number | null {
  return input === null ? null : input + read + write;
}

export function createClaudeDecoder(): StreamDecoder {
  const usage = createUsageAccumulator();
  const toolNames = new Map<string, string>();
  let result: string | null = null;
  let failure: DecoderSummary['failure'] = null;
  let lastErrorKind: string | null = null;

  const contentEvents = (role: 'assistant' | 'user', content: unknown, at: string): AgentEvent[] => {
    const events: AgentEvent[] = [];
    for (const raw of arr(content)) {
      const block = obj(raw);
      if (block.type === 'text' && role === 'assistant') {
        events.push({ type: 'message', at, role, text: str(block.text) ?? '' });
      } else if (block.type === 'tool_use') {
        const name = str(block.name) ?? 'tool';
        const id = str(block.id);
        if (id) toolNames.set(id, name);
        events.push({ type: 'tool', at, name, status: 'started', detail: truncate(JSON.stringify(block.input ?? {})) });
      } else if (block.type === 'tool_result') {
        const id = str(block.tool_use_id);
        events.push({
          type: 'tool',
          at,
          name: (id && toolNames.get(id)) || 'tool',
          status: block.is_error === true ? 'failed' : 'completed',
        });
      }
    }
    return events;
  };

  return {
    line(text, at) {
      const event = parseJsonLine(text);
      if (!event) return [{ type: 'log', at, stream: 'stdout', text }];
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init') {
            usage.setModel(str(event.model));
            return [{ type: 'started', at, pid: null, providerSessionId: str(event.session_id) }];
          }
          if (event.subtype === 'api_retry') {
            lastErrorKind = str(event.error) ?? lastErrorKind;
            return [
              {
                type: 'log',
                at,
                stream: 'stdout',
                text: `API retry ${num(event.attempt) ?? '?'}/${num(event.max_retries) ?? '?'}: ${str(event.error) ?? 'unknown'} (status ${num(event.error_status) ?? 'none'})`,
              },
            ];
          }
          return [];
        case 'assistant': {
          const kind = str(event.error);
          if (kind) lastErrorKind = kind;
          return contentEvents('assistant', obj(event.message).content, at);
        }
        case 'user':
          return contentEvents('user', obj(event.message).content, at);
        case 'result': {
          const models = obj(event.modelUsage);
          const entries = Object.entries(models).filter(([, v]) => isObject(v));
          if (entries.length > 0) {
            for (const [model, raw] of entries) {
              const m = obj(raw);
              const read = num(m.cacheReadInputTokens) ?? 0;
              const write = num(m.cacheCreationInputTokens) ?? 0;
              usage.add({
                input: withCache(num(m.inputTokens), read, write),
                output: num(m.outputTokens),
                cached: read,
                costUsd: num(m.costUSD),
              });
              if (entries.length === 1) usage.setModel(model);
            }
          } else {
            const u = obj(event.usage);
            const read = num(u.cache_read_input_tokens) ?? 0;
            const write = num(u.cache_creation_input_tokens) ?? 0;
            usage.add({
              input: withCache(num(u.input_tokens), read, write),
              output: num(u.output_tokens),
              cached: read,
              costUsd: num(event.total_cost_usd),
            });
          }
          result = event.structured_output !== undefined ? JSON.stringify(event.structured_output) : str(event.result);
          if (event.is_error === true || event.subtype !== 'success') {
            const errors = arr(event.errors).filter((e): e is string => typeof e === 'string');
            const message = errors.join('; ') || str(event.result) || String(event.subtype ?? 'error');
            const classification =
              classifyHttpStatus(num(event.api_error_status)) ??
              (lastErrorKind ? ASSISTANT_ERROR_CLASSES[lastErrorKind] : undefined) ??
              classifyFailureText(message);
            failure = { message, classification };
            return [{ type: 'error', at, message, classification }];
          }
          return [];
        }
        default:
          return [];
      }
    },
    summary: () => ({ usage: usage.report(), result, failure }),
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
  private readonly sessions: ProcessSessions;

  constructor(private readonly options: AdapterOptions = {}) {
    this.sessions = new ProcessSessions(options);
  }

  async capabilities(profile: AccountProfile): Promise<Capabilities> {
    const probe = await probeVersion([claudeBinary(profile), '--version'], childEnv(this.options, [], {}));
    const tooOld = probe.version !== null && compareVersions(probe.version, CLAUDE_MIN_VERSION) < 0;
    return {
      providerId: 'claude',
      version: probe.version,
      available: probe.available && !tooOld,
      structuredEvents: true,
      usageReporting: 'measured',
      resume: true,
      cancel: true,
      modelSelection: true,
      profileIsolation: profile.configRoot ? 'config-root' : 'none',
      codingAgent: true,
      planningReview: true,
      notes: [
        'claude -p --output-format stream-json --verbose; usage and total_cost_usd arrive on the result message.',
        'total_cost_usd is a client-side estimate reported by Claude Code.',
        ...(tooOld ? [`Claude Code ${CLAUDE_MIN_VERSION}+ is required for --permission-prompts`] : []),
        ...(probe.available ? [] : [probe.detail]),
      ],
    };
  }

  async validateProfile(profile: AccountProfile): Promise<ProfileHealth> {
    const executable = resolveExecutable(claudeBinary(profile));
    if (!executable) return health('unavailable', `${claudeBinary(profile)} not found on PATH`);
    if (profile.authMechanism === 'api-key') {
      try {
        await resolveApiKey(profile, this.options.resolveSecret);
      } catch (error) {
        return health('unauthenticated', (error as Error).message);
      }
      return health('unknown', `API key present; Claude Code reads ${CLAUDE_API_KEY_ENV} at launch`);
    }
    if (profile.configRoot) mkdirSync(profile.configRoot, { recursive: true, mode: 0o700 });
    const env = childEnv(this.options, profile.configRoot ? [] : [CLAUDE_CONFIG_DIR_ENV], claudeIsolationEnv(profile));
    const result = await run([executable, 'auth', 'status', '--json'], {
      env,
      timeoutMs: this.options.probeTimeoutMs ?? 15_000,
      allowFailure: true,
    });
    if (result.timedOut) return health('unknown', 'claude auth status timed out');
    const status = parseJsonLine(result.stdout.trim().replace(/\n/g, ' '));
    if (!status) return health('unknown', `claude auth status returned no JSON (exit ${result.exitCode})`);
    if (status.loggedIn === true) {
      return health('healthy', `logged in (${str(status.authMethod) ?? 'unknown method'})`);
    }
    return health('unauthenticated', 'not logged in');
  }

  async launch(input: AgentLaunch): Promise<AgentSessionHandle> {
    const executable = resolveExecutable(claudeBinary(input.profile));
    if (!executable) throw new CrewError('UNAVAILABLE', `${claudeBinary(input.profile)} not found on PATH`);
    const apiKey = await resolveApiKey(input.profile, this.options.resolveSecret);
    if (input.profile.configRoot) mkdirSync(input.profile.configRoot, { recursive: true, mode: 0o700 });
    const invocation = buildClaudeInvocation(input, { executable, apiKey, options: this.options });
    return this.sessions.launch(input, {
      argv: invocation.argv,
      env: invocation.env,
      stdin: invocation.stdin,
      decoder: createClaudeDecoder(),
      secretValues: apiKey ? [apiKey] : [],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sessions.cancel(sessionId);
  }
}

export function createClaudeAdapter(options: AdapterOptions = {}): ProviderAdapter {
  return new ClaudeAdapter(options);
}
