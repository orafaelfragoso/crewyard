import type { Clock, CrewDirs, Logger } from '@crewyard/core';
import type { Store } from './db.ts';

export interface CrewContext {
  store: Store;
  dirs: CrewDirs;
  logger: Logger;
  clock: Clock;
}
