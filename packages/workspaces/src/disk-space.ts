import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export function freeDiskBytes(path: string): number {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const stats = statfsSync(existing);
  return stats.bavail * stats.bsize;
}
