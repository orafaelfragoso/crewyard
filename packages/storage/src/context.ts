import type { Clock, CrewDirs, Logger } from '@crewyard/core';
import type { Store } from './db.ts';
import type { ExecutionClaimToken } from './execution-claims.ts';

export interface ExecutionScope {
  claim: ExecutionClaimToken;
  directory: string;
  signal: AbortSignal;
  onSpawn(pid: number): void;
}

export interface CrewContext {
  store: Store;
  dirs: CrewDirs;
  logger: Logger;
  clock: Clock;
  execution?: ExecutionScope;
}
