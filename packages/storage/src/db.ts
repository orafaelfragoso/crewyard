import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { dirname } from 'node:path';
import { type Clock, CrewError, ensureDir, systemClock } from '@crewyard/core';

export type Durability = 'full' | 'normal';

export interface OpenOptions {
  path: string;
  durability?: Durability;
  busyTimeoutMs?: number;
  readonly?: boolean;
  clock?: Clock;
}

export interface Store {
  readonly db: Database;
  readonly path: string;
  readonly clock: Clock;
  immediate<T>(fn: (db: Database) => T): T;
  preview<T>(fn: (db: Database) => T): T;
  read<T>(fn: (db: Database) => T): T;
  close(): void;
}

const MAX_BUSY_RETRIES = 8;

function isBusy(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : '';
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED') || /database is locked/i.test(message);
}

export function openStore(options: OpenOptions): Store {
  if (options.path !== ':memory:') ensureDir(dirname(options.path));
  const db = new Database(
    options.path,
    options.readonly ? { readonly: true, strict: true } : { create: true, strict: true },
  );
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  if (!options.readonly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${(options.durability ?? 'full') === 'full' ? 'FULL' : 'NORMAL'}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  const clock = options.clock ?? systemClock;

  const immediate = <T>(fn: (db: Database) => T): T => {
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusy(error) && attempt < MAX_BUSY_RETRIES) {
          Bun.sleepSync(Math.min(500, 10 * 2 ** attempt) + Math.floor(Math.random() * 10));
          continue;
        }
        if (isBusy(error)) {
          throw new CrewError('BUSY', 'Database is busy; retry the operation', { cause: error, retryable: true });
        }
        throw error;
      }
      try {
        const result = fn(db);
        if (result instanceof Promise) {
          throw new CrewError('INTERNAL', 'Transactions must be synchronous; never await inside a DB transaction');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
  };

  const preview = <T>(fn: (db: Database) => T): T => {
    const rollback = Symbol('preview');
    let result: { value: T } | undefined;
    try {
      immediate((tx) => {
        result = { value: fn(tx) };
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return result!.value;
  };

  const read = <T>(fn: (db: Database) => T): T => fn(db);

  return {
    db,
    path: options.path,
    clock,
    immediate,
    preview,
    read,
    close: () => db.close(),
  };
}

export function previewStore(store: Store): Store {
  return { ...store, immediate: store.preview, close: () => {} };
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function one<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
  return (db.query(sql).get(...params) as T | null) ?? null;
}

export function all<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query(sql).all(...params) as T[];
}

export function exec(
  db: Database,
  sql: string,
  ...params: SQLQueryBindings[]
): { changes: number; lastInsertRowid: number } {
  const result = db.query(sql).run(...params);
  return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
}

export function nextSequence(db: Database, name: string): number {
  const row = one<{ value: number }>(
    db,
    'INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value',
    name,
  );
  return row!.value;
}
