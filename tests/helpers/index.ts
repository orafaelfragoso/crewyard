import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Clock,
  canonicalPath,
  git,
  type RailDirs,
  resolveDirs,
  silentLogger,
  systemClock,
} from '@agent-rail/core';
import { openRailStore, type RailContext } from '@agent-rail/storage';

export interface TestContext extends RailContext {
  root: string;
  cleanup(): void;
}

export function tempDir(prefix = 'rail-test-'): string {
  return canonicalPath(mkdtempSync(join(tmpdir(), prefix)));
}

export function createTestContext(options: { clock?: Clock; durability?: 'full' | 'normal' } = {}): TestContext {
  const root = tempDir();
  const dirs: RailDirs = resolveDirs({ RAIL_DATA_DIR: join(root, 'data') } as NodeJS.ProcessEnv);
  const clock = options.clock ?? systemClock;
  const store = openRailStore({ dirs, clock, durability: options.durability ?? 'normal' });
  return {
    root,
    dirs,
    store,
    clock,
    logger: silentLogger,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export async function createTempGitRepo(
  files: Record<string, string>,
  options: { branch?: string; remote?: string } = {},
): Promise<string> {
  const dir = tempDir('rail-repo-');
  await git(dir, ['init', '-q', '-b', options.branch ?? 'main']);
  await git(dir, ['config', 'user.email', 'test@agent-rail.local']);
  await git(dir, ['config', 'user.name', 'Rail Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFiles(dir, files);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  if (options.remote) await git(dir, ['remote', 'add', 'origin', options.remote]);
  return dir;
}

export async function commitFiles(repo: string, files: Record<string, string>, message = 'change'): Promise<string> {
  writeFiles(repo, files);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', message]);
  return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
}

export class ManualClock implements Clock {
  constructor(private current: Date = new Date('2026-11-02T12:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
