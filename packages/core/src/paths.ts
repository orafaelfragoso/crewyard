import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RailError } from './errors.ts';

const APP = 'agent-rail';

export interface RailDirs {
  data: string;
  config: string;
  database: string;
  cacheIndex: string;
  worktrees: string;
  artifacts: string;
  logs: string;
  backups: string;
  run: string;
}

export function resolveDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RailDirs {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  let data: string;
  let config: string;
  if (env.RAIL_DATA_DIR) {
    data = resolve(env.RAIL_DATA_DIR);
    config = resolve(env.RAIL_CONFIG_DIR ?? join(data, 'config'));
  } else if (platform === 'darwin') {
    data = join(home, 'Library', 'Application Support', APP);
    config = env.RAIL_CONFIG_DIR ?? join(home, 'Library', 'Preferences', APP);
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    data = join(local, APP);
    config = env.RAIL_CONFIG_DIR ?? join(roaming, APP);
  } else {
    data = join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP);
    config = env.RAIL_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), APP);
  }
  return {
    data,
    config,
    database: join(data, 'agent-rail.sqlite'),
    cacheIndex: join(data, 'cache', 'index'),
    worktrees: join(data, 'worktrees'),
    artifacts: join(data, 'artifacts'),
    logs: join(data, 'logs'),
    backups: join(data, 'backups'),
    run: join(data, 'run'),
  };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPath(parent), absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function safeJoin(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  if (!isWithin(root, target)) {
    throw new RailError('POLICY_DENIED', `Path escapes permitted root: ${segments.join('/')}`, {
      details: { root },
      suggestion: 'Use a path inside the permitted workspace root.',
    });
  }
  return canonicalPath(target);
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
