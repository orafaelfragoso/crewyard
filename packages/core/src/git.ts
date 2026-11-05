import { CrewError } from './errors.ts';
import { type RunResult, run } from './process.ts';

const GIT_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'LANG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];

function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of GIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_') || key === 'SSH_AUTH_SOCK') && value) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

export interface GitOptions {
  input?: string;
  allowFailure?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
}

export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<RunResult> {
  const result = await run(['git', '-c', 'core.quotepath=off', ...args], {
    cwd,
    env: gitEnv(options.env),
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
  });
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new CrewError('EXTERNAL_FAILURE', `git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`, {
      details: { args: args.slice(0, 6), exitCode: result.exitCode },
      retryable: false,
    });
  }
  return result;
}

export async function gitText(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, options)).stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return gitText(cwd, ['rev-parse', '--show-toplevel']);
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  return (await gitText(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) === '';
}

export interface RemoteIdentity {
  url: string;
  host: string;
  owner: string;
  name: string;
}

export function parseRemoteUrl(url: string): RemoteIdentity | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/([^/]+)$/.exec(trimmed);
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/.exec(trimmed);
  const match = ssh ?? https;
  if (!match) return null;
  return { url: url.trim(), host: match[1]!, owner: match[2]!, name: match[3]! };
}

export async function remoteIdentity(cwd: string, remote = 'origin'): Promise<RemoteIdentity | null> {
  const result = await git(cwd, ['remote', 'get-url', remote], { allowFailure: true });
  return result.exitCode === 0 ? parseRemoteUrl(result.stdout) : null;
}
