import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { CrewError } from './errors.ts';

const APP = 'crewyard';

export interface CrewDirs {
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
): CrewDirs {
  const path = platform === 'win32' ? win32 : posix;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  let data: string;
  let config: string;
  if (env.CREW_DATA_DIR) {
    data = path.resolve(env.CREW_DATA_DIR);
    config = path.resolve(env.CREW_CONFIG_DIR ?? path.join(data, 'config'));
  } else if (platform === 'darwin') {
    data = path.join(home, 'Library', 'Application Support', APP);
    config = env.CREW_CONFIG_DIR ?? path.join(home, 'Library', 'Preferences', APP);
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    data = path.join(local, APP);
    config = env.CREW_CONFIG_DIR ?? path.join(roaming, APP);
  } else {
    data = path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), APP);
    config = env.CREW_CONFIG_DIR ?? path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP);
  }
  return {
    data,
    config,
    database: path.join(data, 'crewyard.sqlite'),
    cacheIndex: path.join(data, 'cache', 'index'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    logs: path.join(data, 'logs'),
    backups: path.join(data, 'backups'),
    run: path.join(data, 'run'),
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
    throw new CrewError('POLICY_DENIED', `Path escapes permitted root: ${segments.join('/')}`, {
      details: { root },
      suggestion: 'Use a path inside the permitted workspace root.',
    });
  }
  return canonicalPath(target);
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
