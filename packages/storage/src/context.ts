import type { Clock, Logger, RailDirs } from '@agent-rail/core';
import type { Store } from './db.ts';

export interface RailContext {
  store: Store;
  dirs: RailDirs;
  logger: Logger;
  clock: Clock;
}
