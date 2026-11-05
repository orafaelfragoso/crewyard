import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { processIdentity, sha256 } from '@crewyard/core';
import {
  acquireExecutionClaim,
  bindExecutionProcess,
  claimDueOutbox,
  enqueueOutbox,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  migrationStatus,
  openStore,
  releaseExecutionClaim,
  type Store,
} from '@crewyard/storage';
import { createTestContext, ManualClock } from '../../helpers/index.ts';

function seedSchema(store: Store, version: number): void {
  migrationStatus(store);
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= version)) {
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
}

test('v2 migration preserves historical outbox rows and checksum-verified backup', () => {
  const clock = new ManualClock();
  const ctx = createTestContext({ clock });
  const store = openStore({ path: join(ctx.root, 'historical.sqlite'), clock });
  try {
    seedSchema(store, 2);
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

test('upgrades from every supported predecessor fence already-open legacy writers while retaining reads and current writes', () => {
  const ctx = createTestContext();
  try {
    for (const version of [2, 3, 4]) {
      const path = join(ctx.root, `writer-v${version}.sqlite`);
      const store = openStore({ path });
      seedSchema(store, version);
      store.db
        .query(
          "INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p','before','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
        )
        .run();
      const legacy = new Database(path, { strict: true });
      const prepared = legacy.query("UPDATE projects SET name = 'legacy' WHERE id = 'p'");
      try {
        migrate(store);
        expect(() => prepared.run()).toThrow('crewyard_writer_protocol');
        expect(legacy.query("SELECT name FROM projects WHERE id = 'p'").get()).toEqual({ name: 'before' });
        store.immediate((db) => db.query("UPDATE projects SET name = 'current' WHERE id = 'p'").run());
        expect(legacy.query("SELECT name FROM projects WHERE id = 'p'").get()).toEqual({ name: 'current' });
      } finally {
        legacy.close();
        store.close();
      }
    }
  } finally {
    ctx.cleanup();
  }
});

test('upgrade refuses recorded live or unprovable remote writers before creating a backup or changing schema', () => {
  const ctx = createTestContext();
  const store = openStore({ path: join(ctx.root, 'active-writer.sqlite') });
  try {
    seedSchema(store, 2);
    store.db
      .query(
        "INSERT INTO worker_heartbeats (worker_id,kind,pid,host,status,started_at,last_heartbeat_at) VALUES ('w','service',?,?,'running','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
      )
      .run(process.pid, hostname());
    expect(() => migrate(store, { backupDir: ctx.dirs.backups })).toThrow('Stop recorded Crewyard workers');
    expect(migrationStatus(store).currentVersion).toBe(2);
    store.db.query("UPDATE worker_heartbeats SET host = 'other-host'").run();
    expect(() => migrate(store)).toThrow('Stop recorded Crewyard workers');
    store.db.query("UPDATE worker_heartbeats SET status = 'stopped'").run();
    expect(migrate(store).currentVersion).toBe(LATEST_SCHEMA_VERSION);
  } finally {
    store.close();
    ctx.cleanup();
  }
});

test('upgrade checks direct execution claims again under the DDL transaction', () => {
  const ctx = createTestContext();
  const store = openStore({ path: join(ctx.root, 'direct-writer.sqlite') });
  try {
    seedSchema(store, 4);
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const claim = store.immediate((db) =>
      acquireExecutionClaim(
        db,
        { scope: 'review:direct', attemptId: 'direct', ownerId: 'cli', inputIdentity: 'input', ttlSeconds: 600 },
        at,
      ),
    )!;
    store.immediate((db) =>
      bindExecutionProcess(
        db,
        claim,
        { host: hostname(), pid: process.pid, startIdentity: processIdentity(process.pid)! },
        at,
      ),
    );
    expect(() => migrate(store)).toThrow('Reconcile all active or unverified execution attempts');
    expect(migrationStatus(store).currentVersion).toBe(4);
    store.immediate((db) => releaseExecutionClaim(db, claim, at));
    let intercepted = false;
    const racing: Store = {
      ...store,
      immediate: (fn) => {
        if (!intercepted) {
          intercepted = true;
          store.immediate((db) =>
            acquireExecutionClaim(
              db,
              { scope: 'index:unbound', attemptId: 'racer', ownerId: 'cli', inputIdentity: 'other', ttlSeconds: 600 },
              at,
            ),
          );
        }
        return store.immediate(fn);
      },
    };
    expect(() => migrate(racing)).toThrow('Reconcile all active or unverified execution attempts');
    expect(migrationStatus(store).currentVersion).toBe(4);
  } finally {
    store.close();
    ctx.cleanup();
  }
});
