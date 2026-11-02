import { RailError } from './errors.ts';

export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];

export function sanitizeEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowFailure?: boolean;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size >= limit) {
      truncated = true;
      continue;
    }
    const room = limit - size;
    const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    if (piece.byteLength < chunk.byteLength) truncated = true;
    chunks.push(piece);
    size += piece.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

export async function run(cmd: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const limit = options.maxOutputBytes ?? 16 * 1024 * 1024;
  let proc: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([...cmd], {
      cwd: options.cwd,
      env: options.env as Record<string, string> | undefined,
      stdin: options.input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    throw new RailError('UNAVAILABLE', `Cannot execute ${cmd[0]}: ${(error as Error).message}`, {
      cause: error,
      suggestion: `Install ${cmd[0]} or add it to PATH.`,
    });
  }
  if (options.input !== undefined && proc.stdin && typeof proc.stdin !== 'number') {
    proc.stdin.write(options.input);
    await proc.stdin.end();
  }
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killTree(proc.pid, 'SIGKILL');
        }, options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    readLimited(proc.stdout, limit),
    readLimited(proc.stderr, limit),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  const result: RunResult = {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: Math.round(performance.now() - started),
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
  if (!options.allowFailure && (exitCode !== 0 || timedOut)) {
    throw new RailError(
      'EXTERNAL_FAILURE',
      `${cmd.slice(0, 3).join(' ')} failed (${timedOut ? 'timeout' : `exit ${exitCode}`}): ${result.stderr.trim().slice(0, 500)}`,
      { details: { exitCode, timedOut }, retryable: timedOut },
    );
  }
  return result;
}

export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
      return true;
    }
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function terminateTree(pid: number, graceMs: number): Promise<'exited' | 'killed' | 'not_running'> {
  if (!isProcessAlive(pid)) return 'not_running';
  killTree(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return 'exited';
    await Bun.sleep(50);
  }
  killTree(pid, 'SIGKILL');
  return 'killed';
}

export function which(binary: string): string | null {
  return Bun.which(binary);
}
