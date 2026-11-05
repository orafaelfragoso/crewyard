import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CrewError, ensureDir, isProcessAlive, nowIso, sha256 } from '@crewyard/core';
import initialSql from '../migrations/0001_initial.sql' with { type: 'text' };
import queueEntryProgressSql from '../migrations/0002_queue_entry_progress.sql' with { type: 'text' };
import executionClaimsSql from '../migrations/0003_execution_claims.sql' with { type: 'text' };
import reviewExecutionSql from '../migrations/0004_review_execution.sql' with { type: 'text' };
import writerProtocolSql from '../migrations/0005_writer_protocol.sql' with { type: 'text' };
import { all, type Store } from './db.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_initial', sql: initialSql },
  { version: 2, name: '0002_queue_entry_progress', sql: queueEntryProgressSql },
  { version: 3, name: '0003_execution_claims', sql: executionClaimsSql },
  { version: 4, name: '0004_review_execution', sql: reviewExecutionSql },
  { version: 5, name: '0005_writer_protocol', sql: writerProtocolSql },
];

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
    throw new CrewError(
      'SCHEMA_TOO_NEW',
      `Database schema version ${currentVersion} is newer than this crew build supports (${LATEST_SCHEMA_VERSION})`,
      {
        suggestion: 'Upgrade crew to a version that supports this database. Do not resume an older writer.',
        retryable: false,
      },
    );
  }
  for (const row of applied) {
    const known = MIGRATIONS.find((m) => m.version === row.version);
    if (!known || sha256(known.sql) !== row.checksum) {
      throw new CrewError(
        'MIGRATION_FAILED',
        `Migration ${row.version} (${row.name}) checksum does not match this build`,
        {
          suggestion:
            'The database was migrated by a different build. Restore from backup or use the matching crew version.',
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
  if (existsSync(target)) throw new CrewError('CONFLICT', `Backup target already exists: ${target}`);
  store.db.query('VACUUM INTO ?').run(target);
  return target;
}

export function migrate(store: Store, options: { dryRun?: boolean; backupDir?: string } = {}): MigrateResult {
  const status = migrationStatus(store);
  if (options.dryRun || status.pending.length === 0) {
    return { ...status, dryRun: options.dryRun ?? false, backupPath: null };
  }
  if (status.currentVersion > 0) assertUpgradeQuiescent(store);
  const backupPath =
    status.currentVersion > 0 && options.backupDir && store.path !== ':memory:'
      ? backupDatabase(store, options.backupDir, `pre-migration-v${status.currentVersion}`)
      : null;
  for (const pending of status.pending) {
    const migration = MIGRATIONS.find((m) => m.version === pending.version)!;
    store.immediate((db) => {
      if (status.currentVersion > 0) assertUpgradeQuiescent(store);
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

function assertUpgradeQuiescent(store: Store): void {
  const processes = all<{ pid: number | null; host: string | null }>(
    store.db,
    `SELECT pid, host FROM worker_heartbeats WHERE status != 'stopped'
     UNION ALL SELECT pid, host FROM sessions WHERE state IN ('starting', 'running', 'stopping', 'orphaned')`,
  );
  if (processes.some((record) => record.pid !== null && (record.host !== hostname() || isProcessAlive(record.pid))))
    throw new CrewError('BUSY', 'Stop recorded Crewyard workers and provider sessions before upgrading the database', {
      suggestion:
        'Stop the service and its children, close MCP hosts and direct CLI writers, then retry with the current build.',
      retryable: false,
    });
  if (all(store.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_claims'").length) {
    const claims = all<{ process_pid: number | null; process_host: string | null }>(
      store.db,
      'SELECT process_pid, process_host FROM execution_claims WHERE released_at IS NULL',
    );
    if (
      claims.some(
        (claim) => claim.process_pid === null || claim.process_host !== hostname() || isProcessAlive(claim.process_pid),
      )
    )
      throw new CrewError(
        'BUSY',
        'Reconcile all active or unverified execution attempts before upgrading the database',
        {
          suggestion:
            'Use the existing compatible build to stop or reconcile attempts, then quiesce all writers and retry the upgrade.',
          retryable: false,
        },
      );
  }
}
