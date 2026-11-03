import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountProfile,
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
  unsupported,
} from '@crewyard/provider-generic';

const XDG_DIRS = {
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
} as const;

export function opencodeBinary(profile: AccountProfile): string {
  return settingString(profile, 'binary') ?? 'opencode';
}

export function opencodeIsolationEnv(profile: AccountProfile): Record<string, string> {
  const root = profile.configRoot;
  if (!root) return {};
  return Object.fromEntries(Object.entries(XDG_DIRS).map(([key, dir]) => [key, join(root, dir)]));
}

function ensureIsolationDirs(profile: AccountProfile): void {
  for (const dir of Object.values(opencodeIsolationEnv(profile))) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function opencodeLoginCommand(profile: AccountProfile): { argv: string[]; env: Record<string, string> } {
  return { argv: [opencodeBinary(profile), 'auth', 'login', '--standalone'], env: opencodeIsolationEnv(profile) };
}

function apiKeyEnvName(profile: AccountProfile): string {
  const name = settingString(profile, 'apiKeyEnv');
  if (!name) {
    throw new CrewError('CONFIG_INVALID', `OpenCode api-key profile ${profile.name} must set settings.apiKeyEnv`, {
      suggestion: 'Set settings.apiKeyEnv to the provider variable OpenCode reads, e.g. ANTHROPIC_API_KEY.',
    });
  }
  return name;
}

export function opencodeMcpConfig(server: CrewMcpLaunch): string {
  return JSON.stringify({
    mcp: {
      [CREW_MCP_SERVER_NAME]: { type: 'local', command: [server.command, ...server.args], environment: server.env },
    },
  });
}

export interface OpencodeInvocation {
  argv: string[];
  env: Record<string, string>;
}

export function buildOpencodeInvocation(
  launch: AgentLaunch,
  input: { executable: string; apiKey: string | null; options?: AdapterOptions },
): OpencodeInvocation {
  if (launch.outputSchema) {
    throw unsupported('opencode', 'structured output schemas', 'Use a codex, claude or ollama profile for this step.');
  }
  const argv = [input.executable, 'run', '--standalone', '--format', 'json'];
  if (launch.model) argv.push('--model', launch.model);
  const agent = launch.mode === 'execute' ? settingString(launch.profile, 'agent') : 'plan';
  if (agent) argv.push('--agent', agent);
  if (launch.mode === 'execute' && settingBool(launch.profile, 'autoApprove') !== false) argv.push('--auto');
  argv.push('--', promptWithInstructions(launch));
  const env = childEnv(input.options ?? {}, [], {
    ...opencodeIsolationEnv(launch.profile),
    ...launch.env,
    ...(launch.crewMcp ? { OPENCODE_CONFIG_CONTENT: opencodeMcpConfig(launch.crewMcp) } : {}),
    ...(input.apiKey ? { [apiKeyEnvName(launch.profile)]: input.apiKey } : {}),
  });
  return { argv, env };
}

export function createOpencodeDecoder(): StreamDecoder {
  const usage = createUsageAccumulator();
  let sessionSeen = false;
  let result: string | null = null;
  let failure: DecoderSummary['failure'] = null;
  return {
    line(text, at) {
      const event = parseJsonLine(text);
      if (!event) return [{ type: 'log', at, stream: 'stdout', text }];
      const part = obj(event.part);
      switch (event.type) {
        case 'step_start': {
          if (sessionSeen) return [];
          sessionSeen = true;
          return [{ type: 'started', at, pid: null, providerSessionId: str(event.sessionID) }];
        }
        case 'text': {
          const body = str(part.text) ?? '';
          result = body;
          return [{ type: 'message', at, role: 'assistant', text: body }];
        }
        case 'tool_use': {
          const state = obj(part.state);
          const failed = state.status === 'error';
          const detail = str(state.title) ?? str(state.error) ?? JSON.stringify(state.input ?? {});
          return [
            {
              type: 'tool',
              at,
              name: str(part.tool) ?? 'tool',
              status: failed ? 'failed' : state.status === 'completed' ? 'completed' : 'started',
              detail: truncate(detail),
            },
          ];
        }
        case 'step_finish': {
          const tokens = obj(part.tokens);
          const cache = obj(tokens.cache);
          const input = num(tokens.input);
          const read = num(cache.read) ?? 0;
          usage.add({
            input: input === null ? null : input + read + (num(cache.write) ?? 0),
            output: num(tokens.output),
            cached: num(cache.read),
            costUsd: num(part.cost),
          });
          return [{ type: 'usage', at, usage: usage.report() }];
        }
        case 'error': {
          const error = obj(event.error);
          const message =
            str(error.message) ?? str(obj(error.data).message) ?? str(error.name) ?? 'OpenCode reported an error';
          const kind = str(error.type) ?? str(error.name) ?? '';
          const classification = classifyFailureText(`${kind} ${message}`);
          failure = { message, classification };
          return [{ type: 'error', at, message, classification }];
        }
        default:
          return [];
      }
    },
    summary: () => ({ usage: usage.report(), result, failure }),
  };
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly id = 'opencode' as const;
  private readonly sessions: ProcessSessions;

  constructor(private readonly options: AdapterOptions = {}) {
    this.sessions = new ProcessSessions(options);
  }

  async capabilities(profile: AccountProfile): Promise<Capabilities> {
    const probe = await probeVersion([opencodeBinary(profile), '--version'], childEnv(this.options, [], {}));
    return {
      providerId: 'opencode',
      version: probe.version,
      available: probe.available,
      structuredEvents: true,
      usageReporting: 'measured',
      resume: true,
      cancel: true,
      modelSelection: true,
      profileIsolation: profile.configRoot ? 'env' : 'none',
      codingAgent: true,
      planningReview: true,
      notes: [
        'opencode run --standalone --format json; tokens and cost arrive on step_finish events.',
        'Structured output schemas are not supported by opencode run.',
        ...(probe.available ? [] : [probe.detail]),
      ],
    };
  }

  async validateProfile(profile: AccountProfile): Promise<ProfileHealth> {
    const executable = resolveExecutable(opencodeBinary(profile));
    if (!executable) return health('unavailable', `${opencodeBinary(profile)} not found on PATH`);
    if (profile.authMechanism === 'api-key') {
      try {
        apiKeyEnvName(profile);
        await resolveApiKey(profile, this.options.resolveSecret);
      } catch (error) {
        return health('unauthenticated', (error as Error).message);
      }
      return health('unknown', 'API key present; OpenCode validates it on first request');
    }
    ensureIsolationDirs(profile);
    const result = await run([executable, 'auth', 'list', '--standalone', '--format', 'json'], {
      env: childEnv(this.options, [], opencodeIsolationEnv(profile)),
      timeoutMs: this.options.probeTimeoutMs ?? 30_000,
      allowFailure: true,
    });
    if (result.timedOut) return health('unknown', 'opencode auth list timed out');
    if (result.exitCode !== 0) return health('unknown', `opencode auth list exited ${result.exitCode}`);
    let providers: string[];
    try {
      providers = arr(JSON.parse(result.stdout) as unknown)
        .filter((p) => arr(obj(p).connections).length > 0)
        .map((p) => str(obj(p).id) ?? '?');
    } catch {
      return health('unknown', 'opencode auth list returned no JSON');
    }
    if (providers.length === 0) {
      return health('unauthenticated', 'no credentials');
    }
    return health('healthy', `credentials configured for ${providers.join(', ')}`);
  }

  async launch(input: AgentLaunch): Promise<AgentSessionHandle> {
    const executable = resolveExecutable(opencodeBinary(input.profile));
    if (!executable) throw new CrewError('UNAVAILABLE', `${opencodeBinary(input.profile)} not found on PATH`);
    const apiKey = await resolveApiKey(input.profile, this.options.resolveSecret);
    const invocation = buildOpencodeInvocation(input, { executable, apiKey, options: this.options });
    ensureIsolationDirs(input.profile);
    const skills = crewSkillsSource(input);
    const configHome = opencodeIsolationEnv(input.profile).XDG_CONFIG_HOME;
    if (skills && configHome) syncCrewSkills(skills, join(configHome, 'opencode', 'skills'));
    return this.sessions.launch(input, {
      argv: invocation.argv,
      env: invocation.env,
      stdin: null,
      decoder: createOpencodeDecoder(),
      secretValues: apiKey ? [apiKey] : [],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sessions.cancel(sessionId);
  }
}

export function createOpencodeAdapter(options: AdapterOptions = {}): ProviderAdapter {
  return new OpencodeAdapter(options);
}
