import { existsSync, statSync } from 'node:fs';
import {
  canonicalPath,
  DEFAULT_ENV_ALLOWLIST,
  isWithin,
  RailError,
  sanitizeEnv,
  terminateTree,
} from '@agent-rail/core';

export type NetworkPolicy = 'provider-and-github-only' | 'unrestricted' | 'offline';

export interface BoundedOptions {
  cwd: string;
  permittedRoots: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  envAllowlist?: readonly string[];
  env?: Record<string, string>;
  network?: NetworkPolicy;
  signal?: AbortSignal;
  graceMs?: number;
  allowPrivileged?: boolean;
  input?: string;
}

export interface BoundedResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  network: { requested: NetworkPolicy; enforced: false; mechanism: string };
}

const BLACKHOLE_PROXY = 'http://127.0.0.1:9';

function networkEnv(policy: NetworkPolicy): { env: Record<string, string>; mechanism: string } {
  if (policy !== 'offline') {
    return { env: {}, mechanism: 'advisory only: no network isolation is applied to child processes' };
  }
  const env: Record<string, string> = {};
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    env[key] = BLACKHOLE_PROXY;
  }
  env.NO_PROXY = '';
  env.no_proxy = '';
  return { env, mechanism: 'best-effort: proxy variables point to a blackhole; direct sockets are not blocked' };
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number; truncated: boolean },
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      continue;
    }
    const piece = chunk.byteLength > budget.remaining ? chunk.subarray(0, budget.remaining) : chunk;
    if (piece.byteLength < chunk.byteLength) budget.truncated = true;
    budget.remaining -= piece.byteLength;
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function assertWithinRoots(path: string, roots: readonly string[]): string {
  if (roots.length === 0) throw new RailError('POLICY_DENIED', 'No permitted filesystem roots were configured');
  const target = canonicalPath(path);
  if (!roots.some((root) => isWithin(root, target))) {
    throw new RailError('POLICY_DENIED', `Path ${path} is outside the permitted roots`, {
      details: { path: target, permittedRoots: roots.map((r) => canonicalPath(r)) },
    });
  }
  return target;
}

export async function runBounded(cmd: readonly string[], options: BoundedOptions): Promise<BoundedResult> {
  if (cmd.length === 0) throw new RailError('INVALID_INPUT', 'Command is empty');
  if (!(options.timeoutMs > 0) || !(options.maxOutputBytes > 0)) {
    throw new RailError('INVALID_INPUT', 'timeoutMs and maxOutputBytes must be positive');
  }
  const cwd = assertWithinRoots(options.cwd, options.permittedRoots);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new RailError('INVALID_INPUT', `Working directory does not exist: ${cwd}`);
  }
  if (!options.allowPrivileged && typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new RailError('POLICY_DENIED', 'Refusing to run agent commands as root', {
      suggestion: 'Run Agent Rail as a non-privileged user.',
    });
  }
  const network = networkEnv(options.network ?? 'provider-and-github-only');
  const env = sanitizeEnv(process.env, options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST, {
    ...network.env,
    ...options.env,
  });
  const started = performance.now();
  let proc: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([...cmd], {
      cwd,
      env,
      stdin: options.input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    throw new RailError('UNAVAILABLE', `Cannot execute ${cmd[0]}`, { cause: error });
  }
  if (options.input !== undefined && proc.stdin && typeof proc.stdin !== 'number') {
    proc.stdin.write(options.input);
    await proc.stdin.end();
  }
  const graceMs = options.graceMs ?? 2_000;
  let timedOut = false;
  let cancelled = false;
  const stop = () => void terminateTree(proc.pid, graceMs);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const budget = { remaining: options.maxOutputBytes, truncated: false };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      drain(proc.stdout, budget),
      drain(proc.stderr, budget),
      proc.exited,
    ]);
    return {
      exitCode: timedOut || cancelled ? null : exitCode,
      stdout,
      stderr,
      truncated: budget.truncated,
      timedOut,
      cancelled,
      durationMs: Math.round(performance.now() - started),
      network: {
        requested: options.network ?? 'provider-and-github-only',
        enforced: false,
        mechanism: network.mechanism,
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface PlatformLimitation {
  id: string;
  severity: 'info' | 'warning';
  message: string;
}

export function platformLimitations(platform: NodeJS.Platform = process.platform): PlatformLimitation[] {
  const out: PlatformLimitation[] = [
    {
      id: 'worktree-not-sandbox',
      severity: 'warning',
      message:
        'Git worktrees isolate branches and working files only. They are not a security sandbox: managed agents run as your user and can read or write anything that user can.',
    },
    {
      id: 'filesystem-roots-advisory',
      severity: 'warning',
      message:
        'Permitted filesystem roots are enforced for Agent Rail file operations and command working directories; child processes are not confined by the operating system.',
    },
    {
      id: 'network-policy-advisory',
      severity: 'warning',
      message:
        'Network policy is advisory. "offline" only points proxy variables at a blackhole; direct socket access is not blocked without an external firewall or container.',
    },
    {
      id: 'env-sanitized',
      severity: 'info',
      message: 'Child processes receive an allowlisted environment plus explicitly resolved secret references only.',
    },
  ];
  if (platform === 'win32') {
    out.push({
      id: 'windows-tree-kill',
      severity: 'info',
      message: 'Process-tree cancellation uses `taskkill /T /F`; there is no graceful SIGTERM phase on Windows.',
    });
    out.push({
      id: 'windows-symlinks',
      severity: 'info',
      message:
        'Symlink and junction checks depend on filesystem permissions; junction escapes are detected via canonical paths.',
    });
  } else {
    out.push({
      id: 'posix-process-groups',
      severity: 'info',
      message:
        'Commands run in their own process group; cancellation sends SIGTERM then SIGKILL to the group. Processes that create new sessions (setsid/daemonize) can escape cancellation.',
    });
  }
  if (platform === 'darwin') {
    out.push({
      id: 'macos-no-sandbox-exec',
      severity: 'info',
      message: 'macOS sandbox profiles (sandbox-exec) are not applied.',
    });
  }
  return out;
}
