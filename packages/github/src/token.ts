import { RailError, run } from '@agent-rail/core';

export type TokenProvider = () => Promise<string>;

export interface GhTokenOptions {
  host: string;
  configDir?: string | null;
  ghBinary?: string;
  timeoutMs?: number;
}

const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

const tokenCache = new Map<string, Promise<string>>();

function ghEnv(configDir: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (configDir) env.GH_CONFIG_DIR = configDir;
  else if (process.env.GH_CONFIG_DIR) env.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR;
  return env;
}

async function readGhToken(options: GhTokenOptions): Promise<string> {
  const result = await run([options.ghBinary ?? 'gh', 'auth', 'token', '--hostname', options.host], {
    env: ghEnv(options.configDir),
    timeoutMs: options.timeoutMs ?? 15_000,
    allowFailure: true,
    maxOutputBytes: 16 * 1024,
  });
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token === '') {
    throw new RailError('UNAUTHENTICATED', `GitHub CLI has no token for ${options.host}`, {
      retryable: false,
      details: { host: options.host, configDir: options.configDir ?? null },
      suggestion: options.configDir
        ? `Run \`GH_CONFIG_DIR=${options.configDir} gh auth login --hostname ${options.host}\`.`
        : `Run \`gh auth login --hostname ${options.host}\`.`,
    });
  }
  return token;
}

export function ghTokenProvider(options: GhTokenOptions): TokenProvider {
  const key = `${options.host}\u0000${options.configDir ?? ''}`;
  return () => {
    let pending = tokenCache.get(key);
    if (!pending) {
      pending = readGhToken(options);
      pending.catch(() => tokenCache.delete(key));
      tokenCache.set(key, pending);
    }
    return pending;
  };
}

export function staticTokenProvider(token: string): TokenProvider {
  return () => Promise.resolve(token);
}

export function forgetCachedTokens(): void {
  tokenCache.clear();
}
