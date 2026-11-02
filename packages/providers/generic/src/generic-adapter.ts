import {
  type AccountProfile,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  type Capabilities,
  type FailureClass,
  type ProfileHealth,
  type ProviderAdapter,
  RailError,
  UNKNOWN_USAGE,
  type UsageReport,
} from '@agent-rail/core';
import { classifyFailureText } from './classify.ts';
import { num, parseJsonLine, str } from './json.ts';
import { type DecoderSummary, ProcessSessions, type StreamDecoder } from './process-session.ts';
import {
  type AdapterOptions,
  childEnv,
  health,
  probeVersion,
  resolveApiKey,
  resolveExecutable,
  settingBool,
  settingRecord,
  settingString,
  settingStrings,
  unsupported,
} from './support.ts';

export const GENERIC_PROTOCOL_VERSION = 1;

const FAILURE_CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  'transient_provider',
  'transient_network',
  'transient_ci',
  'rate_limited',
  'compilation',
  'test_failure',
  'merge_conflict',
  'authentication',
  'policy_violation',
  'missing_permissions',
  'ambiguous_remote',
  'unknown',
]);

export type GenericProtocol = 'jsonl' | 'text';
export type GenericInput = 'text' | 'json' | 'none';

export interface GenericSettings {
  command: string;
  args: string[];
  protocol: GenericProtocol;
  input: GenericInput;
  envAllowlist: string[];
  env: Record<string, string>;
  apiKeyEnv: string | null;
  versionArgs: string[];
  codingAgent: boolean;
}

export function genericSettings(profile: AccountProfile): GenericSettings {
  const command = settingString(profile, 'command');
  if (!command) {
    throw new RailError('CONFIG_INVALID', `Generic profile ${profile.name} has no settings.command`, {
      suggestion: 'Set settings.command to the agent executable.',
    });
  }
  const protocol = settingString(profile, 'protocol') ?? 'jsonl';
  const input = settingString(profile, 'input') ?? 'text';
  if (protocol !== 'jsonl' && protocol !== 'text') {
    throw new RailError('CONFIG_INVALID', `settings.protocol must be jsonl or text, got ${protocol}`);
  }
  if (input !== 'text' && input !== 'json' && input !== 'none') {
    throw new RailError('CONFIG_INVALID', `settings.input must be text, json or none, got ${input}`);
  }
  const apiKeyEnv = settingString(profile, 'apiKeyEnv');
  if (profile.authMechanism === 'api-key' && !apiKeyEnv) {
    throw new RailError('CONFIG_INVALID', 'Generic api-key profiles must set settings.apiKeyEnv');
  }
  return {
    command,
    args: settingStrings(profile, 'args'),
    protocol,
    input,
    envAllowlist: settingStrings(profile, 'envAllowlist'),
    env: settingRecord(profile, 'env'),
    apiKeyEnv,
    versionArgs: settingStrings(profile, 'versionArgs'),
    codingAgent: settingBool(profile, 'codingAgent') ?? true,
  };
}

export function expandArgs(args: readonly string[], launch: AgentLaunch): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.includes('{model}') && !launch.model) continue;
    out.push(
      arg
        .replaceAll('{model}', launch.model ?? '')
        .replaceAll('{mode}', launch.mode)
        .replaceAll('{session_id}', launch.sessionId),
    );
  }
  return out;
}

function usageFromLine(line: Record<string, unknown>): UsageReport {
  const input = num(line.input_tokens);
  const output = num(line.output_tokens);
  if (input === null && output === null) return UNKNOWN_USAGE;
  const cost = num(line.cost_usd);
  const model = str(line.model);
  return {
    ...(model ? { model } : {}),
    inputTokens: input,
    outputTokens: output,
    cachedTokens: num(line.cached_tokens),
    costUsd: cost,
    usageSource: 'measured',
    costSource: cost === null ? 'unknown' : 'reported',
  };
}

export function createGenericDecoder(protocol: GenericProtocol): StreamDecoder {
  let usage: UsageReport = UNKNOWN_USAGE;
  let result: string | null = null;
  let lastMessage: string | null = null;
  let failure: DecoderSummary['failure'] = null;
  return {
    line(text, at): AgentEvent[] {
      const line = protocol === 'jsonl' ? parseJsonLine(text) : null;
      if (!line) return [{ type: 'log', at, stream: 'stdout', text }];
      switch (line.type) {
        case 'session':
          return [{ type: 'started', at, pid: null, providerSessionId: str(line.id) }];
        case 'message': {
          const role = line.role === 'user' || line.role === 'system' ? line.role : 'assistant';
          const body = str(line.text) ?? '';
          if (role === 'assistant') lastMessage = body;
          return [{ type: 'message', at, role, text: body }];
        }
        case 'tool': {
          const status = line.status === 'started' || line.status === 'failed' ? line.status : 'completed';
          const detail = str(line.detail);
          return [{ type: 'tool', at, name: str(line.name) ?? 'tool', status, ...(detail === null ? {} : { detail }) }];
        }
        case 'usage': {
          const report = usageFromLine(line);
          if (report.usageSource === 'unknown') return [];
          usage = report;
          return [{ type: 'usage', at, usage: report }];
        }
        case 'error': {
          const message = str(line.message) ?? 'agent reported an error';
          const declared = str(line.class);
          const classification =
            declared && FAILURE_CLASSES.has(declared) ? (declared as FailureClass) : classifyFailureText(message);
          if (line.fatal !== false) failure = { message, classification };
          return [{ type: 'error', at, message, classification }];
        }
        case 'result':
          result = str(line.text) ?? (line.data === undefined ? null : JSON.stringify(line.data));
          return [];
        case 'log':
          return [{ type: 'log', at, stream: 'stdout', text: str(line.text) ?? '' }];
        default:
          return [{ type: 'log', at, stream: 'stdout', text }];
      }
    },
    summary: () => ({ usage, result: result ?? lastMessage, failure }),
  };
}

export class GenericAdapter implements ProviderAdapter {
  readonly id = 'generic' as const;
  private readonly sessions: ProcessSessions;

  constructor(private readonly options: AdapterOptions = {}) {
    this.sessions = new ProcessSessions(options);
  }

  async capabilities(profile: AccountProfile): Promise<Capabilities> {
    const settings = genericSettings(profile);
    const executable = resolveExecutable(settings.command);
    const probe =
      executable && settings.versionArgs.length > 0
        ? await probeVersion([executable, ...settings.versionArgs], childEnv(this.options, [], {}))
        : null;
    return {
      providerId: 'generic',
      version: probe?.version ?? null,
      available: executable !== null && (probe?.available ?? true),
      structuredEvents: settings.protocol === 'jsonl',
      usageReporting: 'unknown',
      resume: false,
      cancel: true,
      modelSelection: settings.args.some((a) => a.includes('{model}')),
      profileIsolation: 'env',
      codingAgent: settings.codingAgent,
      planningReview: true,
      notes: [
        `Generic JSONL protocol v${GENERIC_PROTOCOL_VERSION}; usage is measured only when the process emits usage lines.`,
        ...(executable ? [] : [`${settings.command} was not found`]),
      ],
    };
  }

  async validateProfile(profile: AccountProfile): Promise<ProfileHealth> {
    const settings = genericSettings(profile);
    if (!resolveExecutable(settings.command)) return health('unavailable', `${settings.command} not found`);
    if (profile.authMechanism === 'api-key') {
      try {
        await resolveApiKey(profile, this.options.resolveSecret);
      } catch (error) {
        return health('unauthenticated', (error as Error).message);
      }
      return health('unknown', 'API key present in the secret store; generic processes expose no auth status check');
    }
    return health('healthy', `${settings.command} is executable; generic processes expose no auth status check`);
  }

  async launch(input: AgentLaunch): Promise<AgentSessionHandle> {
    const settings = genericSettings(input.profile);
    if (input.mode === 'execute' && !settings.codingAgent) {
      throw unsupported('generic', 'execute mode', 'Set settings.codingAgent=true for coding agents.');
    }
    const executable = resolveExecutable(settings.command);
    if (!executable) throw new RailError('UNAVAILABLE', `${settings.command} not found`);
    const apiKey = await resolveApiKey(input.profile, this.options.resolveSecret);
    const env = childEnv(this.options, settings.envAllowlist, {
      ...settings.env,
      ...input.env,
      RAIL_SESSION_ID: input.sessionId,
      RAIL_MODE: input.mode,
      ...(input.model ? { RAIL_MODEL: input.model } : {}),
      ...(apiKey && settings.apiKeyEnv ? { [settings.apiKeyEnv]: apiKey } : {}),
    });
    const stdin =
      settings.input === 'none'
        ? null
        : settings.input === 'json'
          ? JSON.stringify({
              prompt: input.prompt,
              systemInstructions: input.systemInstructions,
              mode: input.mode,
              model: input.model,
              ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
            })
          : input.prompt;
    return this.sessions.launch(input, {
      argv: [executable, ...expandArgs(settings.args, input)],
      env,
      stdin,
      decoder: createGenericDecoder(settings.protocol),
      secretValues: apiKey ? [apiKey] : [],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sessions.cancel(sessionId);
  }
}

export function createGenericAdapter(options: AdapterOptions = {}): ProviderAdapter {
  return new GenericAdapter(options);
}
