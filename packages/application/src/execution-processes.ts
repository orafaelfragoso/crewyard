import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  CrewError,
  ensureDir,
  fingerprint,
  isProcessAlive,
  isProcessGroupAlive,
  killTree,
  matchesRecordedProcess,
  processIdentity,
  waitForGroupExit,
} from '@crewyard/core';
import type { ExecutionProcessIdentity } from '@crewyard/storage';

export function recordExecutionProcess(directory: string, pid: number): void {
  const startIdentity = processIdentity(pid);
  if (startIdentity === null) {
    if (!isProcessAlive(pid)) return;
    throw new CrewError('UNAVAILABLE', `Cannot verify execution child ${pid}; launch must stop`);
  }
  const identity: ExecutionProcessIdentity = { host: hostname(), pid, startIdentity };
  const path = join(ensureDir(join(directory, 'processes')), `${pid}-${fingerprint(identity)}.json`);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== JSON.stringify(identity))
      throw new CrewError('CONFLICT', 'Execution child identity manifest changed');
    return;
  }
  writeFileSync(path, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
}

export function stopExecutionProcesses(directory: string): {
  stopped: number;
  unverifiable: number;
  pending: number;
  groups: number[];
} {
  const path = join(directory, 'processes');
  if (!existsSync(path)) return { stopped: 0, unverifiable: 0, pending: 0, groups: [] };
  let stopped = 0;
  const groups: number[] = [];
  let unverifiable = 0;
  for (const file of readdirSync(path)) {
    if (!file.endsWith('.json')) continue;
    const identity = JSON.parse(readFileSync(join(path, file), 'utf8')) as ExecutionProcessIdentity;
    if (identity.host !== hostname()) {
      unverifiable++;
      continue;
    }
    if (!isProcessAlive(identity.pid)) {
      if (isProcessGroupAlive(identity.pid)) unverifiable++;
      continue;
    }
    const matches = matchesRecordedProcess(identity.pid, identity.startIdentity);
    if (matches === false) {
      unverifiable++;
      continue;
    }
    if (matches !== true) {
      unverifiable++;
      continue;
    }
    if (killTree(identity.pid, 'SIGKILL')) {
      stopped++;
      groups.push(identity.pid);
    } else unverifiable++;
  }
  return { stopped, unverifiable, pending: groups.filter(isProcessGroupAlive).length, groups };
}

export async function finishExecutionProcesses(
  directory: string,
  timeoutMs: number,
): Promise<{ stopped: number; unverifiable: number; pending: number }> {
  const result = stopExecutionProcesses(directory);
  const exited = await Promise.all(result.groups.map((pid) => waitForGroupExit(pid, timeoutMs)));
  return { stopped: result.stopped, unverifiable: result.unverifiable, pending: exited.filter((done) => !done).length };
}

export function executionResourcesState(directory: string): 'dead' | 'live' | 'unknown' {
  const path = join(directory, 'processes');
  if (!existsSync(path)) return 'dead';
  let state: 'dead' | 'live' = 'dead';
  for (const file of readdirSync(path)) {
    if (!file.endsWith('.json')) continue;
    const identity = JSON.parse(readFileSync(join(path, file), 'utf8')) as ExecutionProcessIdentity;
    if (identity.host !== hostname()) return 'unknown';
    if (!isProcessAlive(identity.pid)) {
      if (isProcessGroupAlive(identity.pid)) return 'unknown';
      continue;
    }
    if (matchesRecordedProcess(identity.pid, identity.startIdentity) !== true) return 'unknown';
    state = 'live';
  }
  return state;
}
