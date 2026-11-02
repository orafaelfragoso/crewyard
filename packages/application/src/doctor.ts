import { Database } from 'bun:sqlite';
import { accessSync, constants, statSync } from 'node:fs';
import { ensureDir, nowIso, run, which } from '@agent-rail/core';
import { migrationStatus, type RailContext } from '@agent-rail/storage';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface DoctorCheck {
  id: string;
  category: 'runtime' | 'tools' | 'storage' | 'providers' | 'hosts' | 'github' | 'index' | 'security';
  status: CheckStatus;
  summary: string;
  detail?: Record<string, unknown>;
  repair?: string;
}

export type CheckFn = (ctx: RailContext) => Promise<DoctorCheck | DoctorCheck[]>;

export interface DoctorReport {
  generatedAt: string;
  status: CheckStatus;
  checks: DoctorCheck[];
}

async function versionOf(binary: string, args: string[] = ['--version']): Promise<string | null> {
  if (!which(binary)) return null;
  const result = await run([binary, ...args], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0] ?? null;
}

export const runtimeCheck: CheckFn = async () => {
  const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('~BUN');
  return {
    id: 'runtime.bun',
    category: 'runtime',
    status: 'ok',
    summary: `${compiled ? 'compiled binary' : 'Bun runtime'} ${Bun.version} on ${process.platform}-${process.arch}`,
    detail: { bun: Bun.version, revision: Bun.revision, compiled, platform: process.platform, arch: process.arch },
  };
};

export const gitCheck: CheckFn = async () => {
  const version = await versionOf('git');
  if (!version)
    return {
      id: 'tools.git',
      category: 'tools',
      status: 'error',
      summary: 'git not found',
      repair: 'Install Git 2.38 or newer.',
    };
  const match = /(\d+)\.(\d+)/.exec(version);
  const ok = !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 38));
  return {
    id: 'tools.git',
    category: 'tools',
    status: ok ? 'ok' : 'error',
    summary: version,
    ...(ok ? {} : { repair: 'Upgrade Git to 2.38+ (required for `git merge-tree --write-tree`).' }),
  };
};

export const ghCheck: CheckFn = async () => {
  const version = await versionOf('gh');
  if (!version) {
    return {
      id: 'tools.gh',
      category: 'tools',
      status: 'warn',
      summary: 'GitHub CLI not found; GitHub sync and integration are unavailable',
      repair: 'Install the GitHub CLI and run `gh auth login`.',
    };
  }
  const status = await run(['gh', 'auth', 'status', '--hostname', 'github.com'], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  return {
    id: 'tools.gh',
    category: 'tools',
    status: status.exitCode === 0 ? 'ok' : 'warn',
    summary: status.exitCode === 0 ? `${version}; authenticated to github.com` : `${version}; not authenticated`,
    ...(status.exitCode === 0 ? {} : { repair: 'Run `gh auth login` (minimum scopes: repo, workflow read).' }),
  };
};

export const filesystemCheck: CheckFn = async (ctx) => {
  const checks: DoctorCheck[] = [];
  for (const [name, path] of Object.entries({
    data: ctx.dirs.data,
    config: ctx.dirs.config,
    worktrees: ctx.dirs.worktrees,
  })) {
    try {
      ensureDir(path);
      accessSync(path, constants.W_OK | constants.R_OK);
      const mode = statSync(path).mode & 0o777;
      const loose = process.platform !== 'win32' && (mode & 0o077) !== 0;
      checks.push({
        id: `fs.${name}`,
        category: 'storage',
        status: loose ? 'warn' : 'ok',
        summary: `${path} writable${loose ? ` but mode ${mode.toString(8)} is readable by other users` : ''}`,
        ...(loose ? { repair: `chmod 700 '${path}'` } : {}),
      });
    } catch (error) {
      checks.push({
        id: `fs.${name}`,
        category: 'storage',
        status: 'error',
        summary: `${path} is not writable: ${(error as Error).message}`,
        repair: `Fix permissions or set RAIL_DATA_DIR to a writable directory.`,
      });
    }
  }
  return checks;
};

export const sqliteCheck: CheckFn = async (ctx) => {
  const checks: DoctorCheck[] = [];
  const journal = (ctx.store.db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  const sync = (ctx.store.db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
  checks.push({
    id: 'sqlite.wal',
    category: 'storage',
    status: journal === 'wal' ? 'ok' : 'error',
    summary: `journal_mode=${journal}, synchronous=${['OFF', 'NORMAL', 'FULL', 'EXTRA'][sync] ?? sync}`,
    detail: { path: ctx.store.path, durability: sync >= 2 ? 'full' : 'normal' },
    ...(journal === 'wal' ? {} : { repair: 'The data directory must be on a local filesystem that supports WAL.' }),
  });
  try {
    const status = migrationStatus(ctx.store);
    checks.push({
      id: 'sqlite.schema',
      category: 'storage',
      status: status.pending.length === 0 ? 'ok' : 'warn',
      summary: `schema v${status.currentVersion} of v${status.latestVersion}`,
      ...(status.pending.length
        ? { repair: 'Run any rail command to apply migrations (a backup is taken first).' }
        : {}),
    });
  } catch (error) {
    checks.push({ id: 'sqlite.schema', category: 'storage', status: 'error', summary: (error as Error).message });
  }
  if (ctx.store.path !== ':memory:') {
    const other = new Database(ctx.store.path);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      ctx.store.db.exec('BEGIN IMMEDIATE');
      let locked = false;
      try {
        other.exec('BEGIN IMMEDIATE');
        other.exec('ROLLBACK');
      } catch {
        locked = true;
      } finally {
        ctx.store.db.exec('ROLLBACK');
      }
      checks.push({
        id: 'sqlite.locking',
        category: 'storage',
        status: locked ? 'ok' : 'error',
        summary: locked
          ? 'write locks are exclusive across connections'
          : 'write locks are NOT exclusive; leases are unsafe',
        ...(locked ? {} : { repair: 'Move the data directory off network/virtual filesystems (set RAIL_DATA_DIR).' }),
      });
    } finally {
      other.close();
    }
  }
  return checks;
};

export const providerCliCheck: CheckFn = async () => {
  const providers: [string, string, string[]][] = [
    ['codex', 'codex', ['--version']],
    ['claude', 'claude', ['--version']],
    ['opencode', 'opencode', ['--version']],
    ['ollama', 'ollama', ['--version']],
  ];
  return Promise.all(
    providers.map(async ([id, bin, args]) => {
      const version = await versionOf(bin, args);
      return {
        id: `provider.${id}`,
        category: 'providers' as const,
        status: version ? ('ok' as const) : ('skip' as const),
        summary: version ? version : `${bin} not installed (optional)`,
      };
    }),
  );
};

export const secretStoreCheck: CheckFn = async () => {
  const name = `doctor-probe-${process.pid}`;
  try {
    await Bun.secrets.set({ service: 'agent-rail', name, value: 'probe' });
    const value = await Bun.secrets.get({ service: 'agent-rail', name });
    await Bun.secrets.delete({ service: 'agent-rail', name });
    return {
      id: 'security.secret_store',
      category: 'security',
      status: value === 'probe' ? 'ok' : 'error',
      summary: value === 'probe' ? 'system secret store is available' : 'system secret store round-trip failed',
    };
  } catch (error) {
    return {
      id: 'security.secret_store',
      category: 'security',
      status: 'warn',
      summary: `system secret store unavailable: ${(error as Error).message}`,
      repair:
        process.platform === 'linux'
          ? 'Install and unlock a Secret Service provider (gnome-keyring or KWallet). API-key profiles need it; CLI-login profiles do not.'
          : 'Unlock the OS keychain / Credential Manager.',
    };
  }
};

export const BASE_CHECKS: readonly CheckFn[] = [
  runtimeCheck,
  gitCheck,
  ghCheck,
  filesystemCheck,
  sqliteCheck,
  providerCliCheck,
  secretStoreCheck,
];

export async function runDoctor(ctx: RailContext, checks: readonly CheckFn[] = BASE_CHECKS): Promise<DoctorReport> {
  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        const out = await check(ctx);
        return Array.isArray(out) ? out : [out];
      } catch (error) {
        return [
          {
            id: `doctor.${check.name || 'check'}`,
            category: 'runtime' as const,
            status: 'error' as const,
            summary: `check crashed: ${(error as Error).message}`,
          },
        ];
      }
    }),
  );
  const flat = results.flat();
  const status: CheckStatus = flat.some((c) => c.status === 'error')
    ? 'error'
    : flat.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { generatedAt: nowIso(ctx.clock), status, checks: flat };
}
