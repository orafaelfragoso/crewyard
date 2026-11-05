import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@crewyard/core';
import {
  claimDueOutbox,
  enqueueOutbox,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  migrationStatus,
  openStore,
} from '@crewyard/storage';
import { createTestContext, ManualClock } from '../../helpers/index.ts';

test('v2 migration preserves historical outbox rows and checksum-verified backup', () => {
  const clock = new ManualClock();
  const ctx = createTestContext({ clock });
  const store = openStore({ path: join(ctx.root, 'historical.sqlite'), clock });
  try {
    migrationStatus(store);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
      store.immediate((db) => {
        db.exec(migration.sql);
        db.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
          migration.version,
          migration.name,
          sha256(migration.sql),
          '2026-11-01T00:00:00Z',
        );
      });
    }
    for (const status of ['pending', 'attempted', 'ambiguous', 'succeeded'] as const) {
      store.immediate((db) => {
        const op = enqueueOutbox(db, { kind: `legacy.${status}`, intent: { status } }, '2026-11-01T00:00:00Z');
        db.query(
          `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, remote_correlation = ?, next_attempt_at = ? WHERE operation_id = ?`,
        ).run(
          status,
          status === 'pending' ? 0 : 2,
          'historic error',
          '{"id":"remote-old"}',
          status === 'attempted' ? '2026-11-02T12:01:00Z' : '2026-11-01T00:00:00Z',
          op.operationId,
        );
      });
    }
    const before = store.db.query('SELECT * FROM outbox ORDER BY kind').all();
    const checksums = migrationStatus(store).applied;
    const migrated = migrate(store, { backupDir: ctx.dirs.backups });
    expect(migrated.currentVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.applied.slice(0, 2)).toEqual(checksums);
    expect(store.db.query('SELECT * FROM outbox ORDER BY kind').all()).toEqual(before);
    expect(store.db.query('SELECT * FROM execution_claims').all()).toEqual([]);
    expect(migrated.backupPath).not.toBeNull();
    expect(existsSync(migrated.backupPath!)).toBe(true);
    const backup = openStore({ path: migrated.backupPath!, readonly: true });
    try {
      expect(migrationStatus(backup).currentVersion).toBe(2);
      expect(backup.db.query('SELECT * FROM outbox ORDER BY kind').all()).toEqual(before);
    } finally {
      backup.close();
    }
    const claimed = claimDueOutbox(store, { ownerId: 'new-worker', limit: 10, kinds: [], ttlSeconds: 30 });
    expect(claimed.map((op) => op.kind).sort()).toEqual(['legacy.ambiguous', 'legacy.pending']);
    expect(claimed.every((op) => op.claim.generation === 1)).toBe(true);
    expect(migrate(store).pending).toEqual([]);
    store.db.query('UPDATE schema_migrations SET checksum = ? WHERE version = 3').run('tampered');
    expect(() => migrationStatus(store)).toThrow('checksum does not match');
  } finally {
    store.close();
    ctx.cleanup();
  }
});
