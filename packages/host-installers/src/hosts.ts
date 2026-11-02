import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { run } from '@crewyard/core';
import { findMember, parseJsoncObject, readMemberValue } from './jsonc-edit.ts';
import { findMarkerBlock, HASH_MARKERS } from './marker-block.ts';
import {
  type CommandRunner,
  CREW_SERVER_NAME,
  HOST_IDS,
  type HostConfigPaths,
  type HostDetection,
  type HostId,
  type HostSupport,
  type InstallerEnvironment,
  type InstallScope,
} from './types.ts';

export type McpFormat = 'toml' | 'json' | 'claude-cli';

export interface HostSpec {
  binary: string;
  testedVersion: string;
  maxMajor: number;
  format: (scope: InstallScope) => McpFormat;
  containerKey: string;
}

export const HOST_SPECS: Record<HostId, HostSpec> = {
  codex: { binary: 'codex', testedVersion: '0.166.0', maxMajor: 0, format: () => 'toml', containerKey: 'mcp_servers' },
  claude: {
    binary: 'claude',
    testedVersion: '2.1.316',
    maxMajor: 2,
    format: (scope) => (scope === 'user' ? 'claude-cli' : 'json'),
    containerKey: 'mcpServers',
  },
  opencode: { binary: 'opencode', testedVersion: '2.2.5', maxMajor: 2, format: () => 'json', containerKey: 'mcp' },
};

export const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function preferExisting(...candidates: string[]): string {
  return candidates.find((path) => existsSync(path)) ?? candidates.at(-1)!;
}

export function hostConfigPaths(
  host: HostId,
  scope: InstallScope,
  env: NodeJS.ProcessEnv,
  projectRoot?: string,
): HostConfigPaths {
  const home = homeDir(env);
  if (scope === 'project' && !projectRoot) throw new Error('projectRoot is required for project scope');
  const root = projectRoot ?? '';
  switch (host) {
    case 'codex':
      return scope === 'user'
        ? {
            mcpConfig: join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
            skillsDir: join(home, '.agents', 'skills'),
          }
        : { mcpConfig: join(root, '.codex', 'config.toml'), skillsDir: join(root, '.agents', 'skills') };
    case 'claude': {
      if (scope === 'project')
        return { mcpConfig: join(root, '.mcp.json'), skillsDir: join(root, '.claude', 'skills') };
      const configDir = env.CLAUDE_CONFIG_DIR;
      return {
        mcpConfig: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
        skillsDir: join(configDir ?? join(home, '.claude'), 'skills'),
      };
    }
    case 'opencode': {
      const dir = scope === 'user' ? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode') : root;
      return {
        mcpConfig: preferExisting(join(dir, 'opencode.jsonc'), join(dir, 'opencode.json')),
        skillsDir: scope === 'user' ? join(home, '.agents', 'skills') : join(root, '.agents', 'skills'),
      };
    }
  }
}

export function instructionFile(host: HostId, projectRoot: string): string {
  const agents = join(projectRoot, 'AGENTS.md');
  if (host !== 'claude') return agents;
  const claude = join(projectRoot, 'CLAUDE.md');
  return preferExisting(claude, join(projectRoot, '.claude', 'CLAUDE.md'), agents, claude);
}

export function crewServerEntry(host: HostId, crewCommand: readonly string[]): unknown {
  const [command, ...rest] = crewCommand;
  const args = [...rest, 'mcp'];
  switch (host) {
    case 'codex':
      return { command, args };
    case 'claude':
      return { type: 'stdio', command, args };
    case 'opencode':
      return { type: 'local', command: [...crewCommand, 'mcp'], enabled: true };
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexTomlBody(crewCommand: readonly string[]): string {
  const [command, ...rest] = crewCommand;
  return [
    '# Managed by Crewyard. Remove with `crew uninstall --target codex`.',
    `[mcp_servers.${CREW_SERVER_NAME}]`,
    `command = ${tomlString(command ?? 'crew')}`,
    `args = [${[...rest, 'mcp'].map(tomlString).join(', ')}]`,
  ].join('\n');
}

export function sameServerEntry(host: HostId, a: unknown, b: unknown): boolean {
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  if (host === 'opencode') return Bun.deepEquals(x.command, y.command) && x.type === y.type;
  const type = (v: unknown) => (v === undefined ? 'stdio' : v);
  return x.command === y.command && Bun.deepEquals(x.args ?? [], y.args ?? []) && type(x.type) === type(y.type);
}

export function readRegisteredEntry(host: HostId, scope: InstallScope, path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  try {
    if (HOST_SPECS[host].format(scope) === 'toml') {
      const parsed = Bun.TOML.parse(text) as Record<string, Record<string, unknown> | undefined>;
      return parsed.mcp_servers?.[CREW_SERVER_NAME];
    }
    const root = parseJsoncObject(text);
    const container = root && findMember(root, HOST_SPECS[host].containerKey);
    const member = container?.object && findMember(container.object, CREW_SERVER_NAME);
    return member ? readMemberValue(text, member) : undefined;
  } catch {
    return undefined;
  }
}

export function hasMarkerBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const span = findMarkerBlock(readFileSync(path, 'utf8'), HASH_MARKERS);
  return span !== null && span !== 'malformed';
}

export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function versionSupport(host: HostId, version: string | null): { support: HostSupport; note: string | null } {
  const spec = HOST_SPECS[host];
  if (version === null) return { support: 'unknown', note: `${spec.binary} not found; writing the documented format` };
  const major = Number(version.split('.')[0]);
  if (major > spec.maxMajor) {
    return {
      support: 'unsupported',
      note: `${spec.binary} ${version} is newer than the tested major version (${spec.testedVersion}); configuration format not verified`,
    };
  }
  if (compareVersions(version, spec.testedVersion) < 0) {
    return { support: 'supported', note: `${spec.binary} ${version} is older than tested ${spec.testedVersion}` };
  }
  return { support: 'supported', note: null };
}

export const defaultExec: CommandRunner = async (argv, options) => {
  const result = await run(argv, { env: options.env, timeoutMs: options.timeoutMs, allowFailure: true });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

export function defaultWhich(env: NodeJS.ProcessEnv): (binary: string) => string | null {
  return (binary) => Bun.which(binary, { PATH: env.PATH ?? env.Path ?? '' });
}

export function resolveCrewCommand(
  options: { env?: NodeJS.ProcessEnv; which?: (binary: string) => string | null } = {},
): string[] {
  const exe = basename(process.execPath).toLowerCase();
  if (exe === 'crew' || exe === 'crew.exe' || exe.startsWith('crew-')) return [process.execPath];
  const found = (options.which ?? defaultWhich(options.env ?? process.env))('crew');
  return found ? [found] : ['bunx', 'crewyard'];
}

export function isRegistered(host: HostId, scope: InstallScope, env: NodeJS.ProcessEnv, projectRoot?: string): boolean {
  const path = hostConfigPaths(host, scope, env, projectRoot).mcpConfig;
  if (HOST_SPECS[host].format(scope) === 'claude-cli') {
    return readClaudeUserEntry(path) !== undefined;
  }
  return readRegisteredEntry(host, scope, path) !== undefined;
}

export function readClaudeUserEntry(stateFile: string): unknown {
  if (!existsSync(stateFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers?.[CREW_SERVER_NAME];
  } catch {
    return undefined;
  }
}

export async function detectHosts(
  options: InstallerEnvironment & { projectRoot?: string; targets?: readonly HostId[] } = {},
): Promise<HostDetection[]> {
  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich(env);
  const exec = options.exec ?? defaultExec;
  return Promise.all(
    (options.targets ?? HOST_IDS).map(async (host): Promise<HostDetection> => {
      const spec = HOST_SPECS[host];
      const binaryPath = which(spec.binary);
      let version: string | null = null;
      const notes: string[] = [];
      if (binaryPath) {
        const result = await exec([binaryPath, '--version'], { env, timeoutMs: 10_000 }).catch(() => null);
        version = result && result.exitCode === 0 ? parseVersion(result.stdout || result.stderr) : null;
        if (!version) notes.push(`Could not read ${spec.binary} --version`);
      }
      const { support, note } =
        binaryPath && !version ? { support: 'unknown' as const, note: null } : versionSupport(host, version);
      if (note) notes.push(note);
      const project = options.projectRoot ? hostConfigPaths(host, 'project', env, options.projectRoot) : null;
      return {
        host,
        installed: binaryPath !== null,
        binaryPath,
        version,
        testedVersion: spec.testedVersion,
        support,
        configPaths: { user: hostConfigPaths(host, 'user', env), project },
        registered: {
          user: isRegistered(host, 'user', env),
          project: options.projectRoot ? isRegistered(host, 'project', env, options.projectRoot) : null,
        },
        notes,
      };
    }),
  );
}
