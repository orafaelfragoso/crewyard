import { addSeconds, nowIso } from '@agent-rail/core';
import { one, type Store } from './db.ts';

export interface LeadershipLease {
  scope: string;
  holderId: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
}

interface Row {
  scope: string;
  holder_id: string;
  generation: number;
  acquired_at: string;
  expires_at: string;
}

const map = (r: Row): LeadershipLease => ({
  scope: r.scope,
  holderId: r.holder_id,
  generation: r.generation,
  acquiredAt: r.acquired_at,
  expiresAt: r.expires_at,
});

export function acquireLeadership(
  store: Store,
  scope: string,
  holderId: string,
  ttlSeconds: number,
): LeadershipLease | null {
  const at = nowIso(store.clock);
  const expires = addSeconds(at, ttlSeconds);
  return store.immediate((db) => {
    const current = one<Row>(db, 'SELECT * FROM service_leadership WHERE scope = ?', scope);
    if (!current) {
      db.query(
        'INSERT INTO service_leadership (scope, holder_id, generation, acquired_at, expires_at) VALUES (?, ?, 1, ?, ?)',
      ).run(scope, holderId, at, expires);
      return { scope, holderId, generation: 1, acquiredAt: at, expiresAt: expires };
    }
    if (current.holder_id === holderId && current.expires_at > at) {
      db.query('UPDATE service_leadership SET expires_at = ? WHERE scope = ?').run(expires, scope);
      return { ...map(current), expiresAt: expires };
    }
    if (current.expires_at > at) return null;
    const generation = current.generation + 1;
    db.query(
      'UPDATE service_leadership SET holder_id = ?, generation = ?, acquired_at = ?, expires_at = ? WHERE scope = ?',
    ).run(holderId, generation, at, expires, scope);
    return { scope, holderId, generation, acquiredAt: at, expiresAt: expires };
  });
}

export function isLeader(store: Store, scope: string, holderId: string, generation: number): boolean {
  const at = nowIso(store.clock);
  const row = one<Row>(store.db, 'SELECT * FROM service_leadership WHERE scope = ?', scope);
  return !!row && row.holder_id === holderId && row.generation === generation && row.expires_at > at;
}

export function releaseLeadership(store: Store, scope: string, holderId: string, generation: number): void {
  store.immediate((db) => {
    db.query(
      'UPDATE service_leadership SET expires_at = acquired_at WHERE scope = ? AND holder_id = ? AND generation = ?',
    ).run(scope, holderId, generation);
  });
}

export function getLeadership(store: Store, scope: string): LeadershipLease | null {
  const row = one<Row>(store.db, 'SELECT * FROM service_leadership WHERE scope = ?', scope);
  return row ? map(row) : null;
}
