import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AccountProfile,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  type Capabilities,
  CrewError,
  type CrewMcpLaunch,
  type ProfileHealth,
  type ProviderAdapter,
  run,
} from '@crewyard/core';
import {
  type AdapterOptions,
  arr,
  CREW_MCP_SERVER_NAME,
  childEnv,
  classifyFailureText,
  createUsageAccumulator,
  crewSkillsSource,
  type DecoderSummary,
  health,
  num,
  obj,
  ProcessSessions,
  parseJsonLine,
  probeVersion,
  promptWithInstructions,
  resolveApiKey,
  resolveExecutable,
  type StreamDecoder,
  settingBool,
  settingString,
  str,
  syncCrewSkills,
  truncate,
} from '@crewyard/provider-generic';

export const CODEX_API_KEY_ENV = 'CODEX_API_KEY';
export const CODEX_HOME_ENV = 'CODEX_HOME';

export const CODEX_EXECUTE_SANDBOXES = ['workspace-write', 'read-only', 'danger-full-access'] as const;
type Sandbox = (typeof CODEX_EXECUTE_SANDBOXES)[number];

export function codexBinary(profile: AccountProfile): string {
  return settingString(profile, 'binary') ?? 'codex';
}

export function codexIsolationEnv(profile: AccountProfile): Record<string, string> {
  return profile.configRoot ? { [CODEX_HOME_ENV]: profile.configRoot } : {};
}

export function codexLoginCommand(profile: AccountProfile): { argv: string[]; env: Record<string, string> } {
  return { argv: [codexBinary(profile), 'login'], env: codexIsolationEnv(profile) };
}

function sandboxFor(launch: AgentLaunch): Sandbox {
  if (launch.mode !== 'execute') return 'read-only';
  const configured = settingString(launch.profile, 'sandbox') ?? 'workspace-write';
  if ((CODEX_EXECUTE_SANDBOXES as readonly string[]).includes(configured)) return configured as Sandbox;
  throw new CrewError('POLICY_DENIED', `Codex sandbox ${configured} is not permitted for managed sessions`, {
    suggestion: `Use ${CODEX_EXECUTE_SANDBOXES.join(', ')}.`,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexMcpOverrides(server: CrewMcpLaunch): string[] {
  const key = `mcp_servers.${CREW_MCP_SERVER_NAME}`;
  const env = Object.entries(server.env)
    .map(([name, value]) => `${name}=${tomlString(value)}`)
    .join(',');
  return [
    '-c',
    `${key}.command=${tomlString(server.command)}`,
    '-c',
    `${key}.args=[${server.args.map(tomlString).join(',')}]`,
    '-c',
    `${key}.env={${env}}`,
    '-c',
    `${key}.env_vars=[${server.forwardEnv.map(tomlString).join(',')}]`,
  ];
}

export interface CodexInvocation {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  outputSchemaPath: string | null;
}

export function buildCodexInvocation(
  launch: AgentLaunch,
  input: { executable: string; apiKey: string | null; options?: AdapterOptions },
): CodexInvocation {
  const outputSchemaPath = launch.outputSchema ? join(dirname(launch.logPath), 'output-schema.json') : null;
  const sandbox = sandboxFor(launch);
  const argv = [input.executable, 'exec', '--json', '--cd', launch.cwd, '--sandbox', sandbox];
  if (sandbox === 'workspace-write' && settingBool(launch.profile, 'networkAccess') !== false) {
    argv.push('-c', 'sandbox_workspace_write.network_access=true');
  }
  if (launch.model) argv.push('--model', launch.model);
  if (outputSchemaPath) argv.push('--output-schema', outputSchemaPath);
  if (settingBool(launch.profile, 'skipGitRepoCheck')) argv.push('--skip-git-repo-check');
  if (launch.crewMcp) argv.push(...codexMcpOverrides(launch.crewMcp));
  argv.push('-');
  const env = childEnv(input.options ?? {}, launch.profile.configRoot ? [] : [CODEX_HOME_ENV], {
    ...codexIsolationEnv(launch.profile),
    ...launch.env,
    ...(input.apiKey ? { [CODEX_API_KEY_ENV]: input.apiKey } : {}),
  });
  return { argv, env, stdin: promptWithInstructions(launch), outputSchemaPath };
}

function itemEvents(phase: 'started' | 'completed', item: Record<string, unknown>, at: string): AgentEvent[] {
  switch (item.type) {
    case 'command_execution': {
      const exitCode = num(item.exit_code);
      const failed = item.status === 'failed' || (exitCode !== null && exitCode !== 0);
      return [
        {
          type: 'tool',
          at,
          name: 'command',
          status: phase === 'started' ? 'started' : failed ? 'failed' : 'completed',
          detail: truncate(str(item.command) ?? ''),
        },
      ];
    }
    case 'file_change': {
      const paths = arr(item.changes)
        .map((c) => `${str(obj(c).kind) ?? 'update'} ${str(obj(c).path) ?? '?'}`)
        .join(', ');
      return [
        {
          type: 'tool',
          at,
          name: 'file_change',
          status: phase === 'started' ? 'started' : item.status === 'failed' ? 'failed' : 'completed',
          detail: truncate(paths),
        },
      ];
    }
    case 'mcp_tool_call':
      return [
        {
          type: 'tool',
          at,
          name: `mcp:${str(item.server) ?? '?'}.${str(item.tool) ?? '?'}`,
          status: phase === 'started' ? 'started' : item.status === 'failed' ? 'failed' : 'completed',
        },
      ];
    case 'web_search':
      return [
        {
          type: 'tool',
          at,
          name: 'web_search',
          status: phase === 'started' ? 'started' : 'completed',
          detail: truncate(str(item.query) ?? ''),
        },
      ];
    default:
      return [];
  }
}

export function createCodexDecoder(): StreamDecoder {
  const usage = createUsageAccumulator();
  let result: string | null = null;
  let failure: DecoderSummary['failure'] = null;
  return {
    line(text, at) {
      const event = parseJsonLine(text);
      if (!event) return [{ type: 'log', at, stream: 'stdout', text }];
      switch (event.type) {
        case 'thread.started':
          return [{ type: 'started', at, pid: null, providerSessionId: str(event.thread_id) }];
        case 'turn.completed': {
          const u = obj(event.usage);
          usage.add({ input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cached_input_tokens) });
          failure = null;
          return [{ type: 'usage', at, usage: usage.report() }];
        }
        case 'turn.failed':
        case 'error': {
          const message =
            str(obj(event.error).message) ?? str(event.message) ?? 'Codex reported an error without a message';
          const classification = classifyFailureText(message);
          failure = { message, classification };
          return [{ type: 'error', at, message, classification }];
        }
        case 'item.started':
          return itemEvents('started', obj(event.item), at);
        case 'item.completed': {
          const item = obj(event.item);
          if (item.type === 'agent_message') {
            const body = str(item.text) ?? '';
            result = body;
            return [{ type: 'message', at, role: 'assistant', text: body }];
          }
          if (item.type === 'error') return [{ type: 'log', at, stream: 'stdout', text: str(item.message) ?? '' }];
          return itemEvents('completed', item, at);
        }
        default:
          return [];
      }
    },
    summary: () => ({ usage: usage.report(), result, failure }),
  };
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  private readonly sessions: ProcessSessions;

  constructor(private readonly options: AdapterOptions = {}) {
    this.sessions = new ProcessSessions(options);
  }

  async capabilities(profile: AccountProfile): Promise<Capabilities> {
    const probe = await probeVersion([codexBinary(profile), '--version'], childEnv(this.options, [], {}));
    return {
      providerId: 'codex',
      version: probe.version,
      available: probe.available,
      structuredEvents: true,
      usageReporting: 'measured',
      resume: true,
      cancel: true,
      modelSelection: true,
      profileIsolation: profile.configRoot ? 'config-root' : 'none',
      codingAgent: true,
      planningReview: true,
      notes: [
        'codex exec --json emits JSONL thread/turn/item events; token usage arrives on turn.completed.',
        'Codex does not report cost; cost comes only from configured rates.',
        ...(probe.available ? [] : [probe.detail]),
      ],
    };
  }

  async validateProfile(profile: AccountProfile): Promise<ProfileHealth> {
    const executable = resolveExecutable(codexBinary(profile));
    if (!executable) return health('unavailable', `${codexBinary(profile)} not found on PATH`);
    if (profile.authMechanism === 'api-key') {
      try {
        await resolveApiKey(profile, this.options.resolveSecret);
      } catch (error) {
        return health('unauthenticated', (error as Error).message);
      }
      return health(
        'unknown',
        `API key present; Codex reads ${CODEX_API_KEY_ENV} per exec run and has no offline check`,
      );
    }
    if (profile.configRoot) mkdirSync(profile.configRoot, { recursive: true, mode: 0o700 });
    const env = childEnv(this.options, profile.configRoot ? [] : [CODEX_HOME_ENV], codexIsolationEnv(profile));
    const result = await run([executable, 'login', 'status'], {
      env,
      timeoutMs: this.options.probeTimeoutMs ?? 15_000,
      allowFailure: true,
    });
    const detail = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0] ?? '';
    if (result.exitCode === 0) return health('healthy', detail || 'codex login status succeeded');
    if (result.timedOut) return health('unknown', 'codex login status timed out');
    return health('unauthenticated', detail || `codex login status exited ${result.exitCode}`);
  }

  async launch(input: AgentLaunch): Promise<AgentSessionHandle> {
    const executable = resolveExecutable(codexBinary(input.profile));
    if (!executable) throw new CrewError('UNAVAILABLE', `${codexBinary(input.profile)} not found on PATH`);
    const apiKey = await resolveApiKey(input.profile, this.options.resolveSecret);
    if (input.profile.configRoot) mkdirSync(input.profile.configRoot, { recursive: true, mode: 0o700 });
    const skills = crewSkillsSource(input);
    if (skills && input.profile.configRoot) syncCrewSkills(skills, join(input.profile.configRoot, 'skills'));
    const invocation = buildCodexInvocation(input, { executable, apiKey, options: this.options });
    if (invocation.outputSchemaPath) {
      mkdirSync(dirname(invocation.outputSchemaPath), { recursive: true, mode: 0o700 });
      writeFileSync(invocation.outputSchemaPath, JSON.stringify(input.outputSchema), { mode: 0o600 });
    }
    return this.sessions.launch(input, {
      argv: invocation.argv,
      env: invocation.env,
      stdin: invocation.stdin,
      decoder: createCodexDecoder(),
      secretValues: apiKey ? [apiKey] : [],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sessions.cancel(sessionId);
  }
}

export function createCodexAdapter(options: AdapterOptions = {}): ProviderAdapter {
  return new CodexAdapter(options);
}
