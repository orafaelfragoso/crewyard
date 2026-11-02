import { readFileSync } from 'node:fs';

export function processIdentity(pid: number): string | null {
  if (pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    const result = Bun.spawnSync(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const out = result.stdout.toString().trim();
    return result.exitCode === 0 && /^\d+$/.test(out) ? out : null;
  }
  const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const out = result.stdout.toString().trim();
  return result.exitCode === 0 && out ? out : null;
}

export function matchesRecordedProcess(pid: number, recordedIdentity: unknown): boolean | null {
  if (typeof recordedIdentity !== 'string') return null;
  const current = processIdentity(pid);
  return current === null ? null : current === recordedIdentity;
}
