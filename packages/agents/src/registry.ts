import type { AccountProfile, AuthMechanism, ProviderAdapter, ProviderId } from '@agent-rail/core';
import { RailError } from '@agent-rail/core';
import { claudeLoginCommand, createClaudeAdapter } from '@agent-rail/provider-claude';
import { codexLoginCommand, createCodexAdapter } from '@agent-rail/provider-codex';
import { type AdapterOptions, createGenericAdapter, settingBool } from '@agent-rail/provider-generic';
import {
  createOllamaAdapter,
  ollamaCodingEnabled,
  ollamaEndpoint,
  ollamaIsLoopback,
} from '@agent-rail/provider-ollama';
import { createOpencodeAdapter, opencodeLoginCommand } from '@agent-rail/provider-opencode';
import { type SecretStore, systemSecretStore } from './secrets.ts';

export type SessionMode = 'execute' | 'plan' | 'review';
export const SESSION_MODES: readonly SessionMode[] = ['execute', 'plan', 'review'];

export type DataDestination = 'remote' | 'local' | 'operator-defined';

export interface LoginCommand {
  argv: string[];
  env: Record<string, string>;
}

export interface ProviderManifest {
  id: ProviderId;
  displayName: string;
  authMechanisms: readonly AuthMechanism[];
  defaultAuth: AuthMechanism;
  configRootIsolation: boolean;
  create(options: AdapterOptions): ProviderAdapter;
  supportsMode(profile: AccountProfile, mode: SessionMode): boolean;
  loginCommand(profile: AccountProfile): LoginCommand | null;
  destination(profile: AccountProfile): DataDestination;
  disclosure(profile: AccountProfile): string;
}

const AGENT_CONTEXT =
  'the task prompt, agent system instructions, retrieved context packs, and any repository files, command output and diffs the agent reads in its worktree';

export const PROVIDER_MANIFESTS: Readonly<Record<ProviderId, ProviderManifest>> = {
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    authMechanisms: ['cli-login', 'api-key'],
    defaultAuth: 'cli-login',
    configRootIsolation: true,
    create: createCodexAdapter,
    supportsMode: () => true,
    loginCommand: codexLoginCommand,
    destination: () => 'remote',
    disclosure: () => `OpenAI (via the Codex CLI) receives ${AGENT_CONTEXT}.`,
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code CLI',
    authMechanisms: ['cli-login', 'api-key'],
    defaultAuth: 'cli-login',
    configRootIsolation: true,
    create: createClaudeAdapter,
    supportsMode: () => true,
    loginCommand: claudeLoginCommand,
    destination: () => 'remote',
    disclosure: () => `Anthropic (via Claude Code) receives ${AGENT_CONTEXT}.`,
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    authMechanisms: ['cli-login', 'api-key'],
    defaultAuth: 'cli-login',
    configRootIsolation: true,
    create: createOpencodeAdapter,
    supportsMode: () => true,
    loginCommand: opencodeLoginCommand,
    destination: () => 'remote',
    disclosure: () =>
      `The model provider configured in this OpenCode profile (selected by provider/model) receives ${AGENT_CONTEXT}.`,
  },
  generic: {
    id: 'generic',
    displayName: 'Generic process',
    authMechanisms: ['none', 'local', 'api-key'],
    defaultAuth: 'none',
    configRootIsolation: false,
    create: createGenericAdapter,
    supportsMode: (profile, mode) => mode !== 'execute' || settingBool(profile, 'codingAgent') !== false,
    loginCommand: () => null,
    destination: () => 'operator-defined',
    disclosure: () =>
      `The configured executable receives the prompt on stdin and can read the worktree; Agent Rail cannot know where it sends ${AGENT_CONTEXT}.`,
  },
  ollama: {
    id: 'ollama',
    displayName: 'Ollama',
    authMechanisms: ['local', 'none'],
    defaultAuth: 'local',
    configRootIsolation: false,
    create: createOllamaAdapter,
    supportsMode: (profile, mode) => mode !== 'execute' || ollamaCodingEnabled(profile),
    loginCommand: () => null,
    destination: (profile) => (ollamaIsLoopback(profile) ? 'local' : 'remote'),
    disclosure: (profile) =>
      `The Ollama endpoint ${ollamaEndpoint(profile)} receives the prompt, system instructions and retrieved context included in the request${ollamaIsLoopback(profile) ? ' (loopback: data stays on this computer)' : ''}.`,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDER_MANIFESTS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_MANIFESTS, value);
}

export function providerManifest(id: string): ProviderManifest {
  if (!isProviderId(id)) {
    throw new RailError('INVALID_INPUT', `Unknown provider: ${id}`, { details: { known: PROVIDER_IDS } });
  }
  return PROVIDER_MANIFESTS[id];
}

export interface ProviderRegistry {
  get(id: ProviderId): ProviderAdapter;
}

export interface RegistryOptions {
  secrets?: SecretStore;
  cancelGraceMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

export function createProviderRegistry(options: RegistryOptions = {}): ProviderRegistry {
  const secrets = options.secrets ?? systemSecretStore;
  const adapterOptions: AdapterOptions = {
    resolveSecret: (ref) => secrets.get(ref),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
  };
  const adapters = new Map<ProviderId, ProviderAdapter>();
  return {
    get(id) {
      let adapter = adapters.get(id);
      if (!adapter) {
        adapter = providerManifest(id).create(adapterOptions);
        adapters.set(id, adapter);
      }
      return adapter;
    },
  };
}

let defaultRegistry: ProviderRegistry | null = null;

export function getAdapter(id: ProviderId): ProviderAdapter {
  defaultRegistry ??= createProviderRegistry();
  return defaultRegistry.get(id);
}
