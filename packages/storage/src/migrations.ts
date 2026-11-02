import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, nowIso, RailError, sha256 } from '@agent-rail/core';
import initialSql from '../migrations/0001_initial.sql' with { type: 'text' };
import { all, type Store } from './db.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: '0001_initial', sql: initialSql }];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrationStatus {
  currentVersion: number;
  latestVersion: number;
  pending: { version: number; name: string; checksum: string }[];
  applied: { version: number; name: string; checksum: string; appliedAt: string }[];
}

export interface MigrateResult extends MigrationStatus {
  dryRun: boolean;
  backupPath: string | null;
}

function ensureMigrationTable(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
  );
}

export function migrationStatus(store: Store): MigrationStatus {
  ensureMigrationTable(store.db);
  const applied = all<{ version: number; name: string; checksum: string; applied_at: string }>(
    store.db,
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  const currentVersion = applied.at(-1)?.version ?? 0;
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new RailError(
      'SCHEMA_TOO_NEW',
      `Database schema version ${currentVersion} is newer than this rail build supports (${LATEST_SCHEMA_VERSION})`,
      { suggestion: 'Upgrade rail to a version that supports this database, or restore a backup.', retryable: false },
    );
  }
  for (const row of applied) {
    const known = MIGRATIONS.find((m) => m.version === row.version);
    if (!known || sha256(known.sql) !== row.checksum) {
      throw new RailError(
        'MIGRATION_FAILED',
        `Migration ${row.version} (${row.name}) checksum does not match this build`,
        {
          suggestion:
            'The database was migrated by a different build. Restore from backup or use the matching rail version.',
          retryable: false,
        },
      );
    }
  }
  return {
    currentVersion,
    latestVersion: LATEST_SCHEMA_VERSION,
    pending: MIGRATIONS.filter((m) => m.version > currentVersion).map((m) => ({
      version: m.version,
      name: m.name,
      checksum: sha256(m.sql),
    })),
    applied: applied.map((r) => ({ version: r.version, name: r.name, checksum: r.checksum, appliedAt: r.applied_at })),
  };
}

export function backupDatabase(store: Store, backupDir: string, label = 'backup'): string {
  ensureDir(backupDir);
  const target = join(backupDir, `${label}-${nowIso(store.clock).replaceAll(':', '-')}-${process.pid}.sqlite`);
  if (existsSync(target)) throw new RailError('CONFLICT', `Backup target already exists: ${target}`);
  store.db.query('VACUUM INTO ?').run(target);
  return target;
}

export function migrate(store: Store, options: { dryRun?: boolean; backupDir?: string } = {}): MigrateResult {
  const status = migrationStatus(store);
  if (options.dryRun || status.pending.length === 0) {
    return { ...status, dryRun: options.dryRun ?? false, backupPath: null };
  }
  const backupPath =
    status.currentVersion > 0 && options.backupDir && store.path !== ':memory:'
      ? backupDatabase(store, options.backupDir, `pre-migration-v${status.currentVersion}`)
      : null;
  for (const pending of status.pending) {
    const migration = MIGRATIONS.find((m) => m.version === pending.version)!;
    store.immediate((db) => {
      const already = all<{ version: number }>(
        db,
        'SELECT version FROM schema_migrations WHERE version = ?',
        migration.version,
      );
      if (already.length > 0) return;
      db.exec(migration.sql);
      db.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        pending.checksum,
        nowIso(store.clock),
      );
    });
  }
  return { ...migrationStatus(store), dryRun: false, backupPath };
}
