import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function writeFileIfAbsent(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function resolveWriteTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function existingMode(path: string, fallback: number): number {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (isNotFound(error)) return fallback;
    throw error;
  }
}

export function writeFileAtomic(path: string, content: string, options: { mode?: number } = {}): void {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const mode = existingMode(target, options.mode ?? 0o644);
  const temp = join(dirname(target), `.${basename(target)}.crewyard-${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
