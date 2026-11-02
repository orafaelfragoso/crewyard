import { type Clock, type RailDirs, resolveDirs } from '@agent-rail/core';
import { type Durability, openStore, type Store } from './db.ts';
import { migrate } from './migrations.ts';

export interface OpenRailStoreOptions {
  dirs?: RailDirs;
  durability?: Durability;
  clock?: Clock;
  migrate?: boolean;
}

export function openRailStore(options: OpenRailStoreOptions = {}): Store {
  const dirs = options.dirs ?? resolveDirs();
  const store = openStore({
    path: dirs.database,
    durability: options.durability ?? 'full',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  if (options.migrate !== false) migrate(store, { backupDir: dirs.backups });
  return store;
}

export function openMemoryStore(clock?: Clock): Store {
  const store = openStore({ path: ':memory:', ...(clock ? { clock } : {}) });
  migrate(store);
  return store;
}
