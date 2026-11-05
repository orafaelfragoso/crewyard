import { type Clock, type CrewDirs, resolveDirs } from '@crewyard/core';
import { type Durability, openStore, type Store } from './db.ts';
import { migrate } from './migrations.ts';

export interface OpenCrewStoreOptions {
  dirs?: CrewDirs;
  durability?: Durability;
  clock?: Clock;
  migrate?: boolean;
}

export function openCrewStore(options: OpenCrewStoreOptions = {}): Store {
  const dirs = options.dirs ?? resolveDirs();
  const store = openStore({
    path: dirs.database,
    durability: options.durability ?? 'full',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  try {
    if (options.migrate !== false) migrate(store, { backupDir: dirs.backups });
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

export function openMemoryStore(clock?: Clock): Store {
  const store = openStore({ path: ':memory:', ...(clock ? { clock } : {}) });
  migrate(store);
  return store;
}
