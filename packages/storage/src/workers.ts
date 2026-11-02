import { hostname } from 'node:os';
import { newId, nowIso } from '@crewyard/core';
import { all, parseJson, type Store } from './db.ts';

export type WorkerKind = 'service' | 'mcp' | 'cli' | 'dashboard';

export interface WorkerHeartbeat {
  workerId: string;
  kind: WorkerKind;
  pid: number;
  host: string;
  status: string;
  info: Record<string, unknown>;
  startedAt: string;
  lastHeartbeatAt: string;
}

export function registerWorker(store: Store, kind: WorkerKind, info: Record<string, unknown> = {}): string {
  const id = newId('wrk');
  const at = nowIso(store.clock);
  store.immediate((db) => {
    db.query(
      `INSERT INTO worker_heartbeats (worker_id, kind, pid, host, status, info, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(id, kind, process.pid, hostname(), JSON.stringify(info), at, at);
  });
  return id;
}

export function heartbeatWorker(
  store: Store,
  workerId: string,
  status = 'running',
  info?: Record<string, unknown>,
): void {
  const at = nowIso(store.clock);
  store.immediate((db) => {
    db.query(
      'UPDATE worker_heartbeats SET status = ?, last_heartbeat_at = ?, info = COALESCE(?, info) WHERE worker_id = ?',
    ).run(status, at, info ? JSON.stringify(info) : null, workerId);
  });
}

export function unregisterWorker(store: Store, workerId: string): void {
  store.immediate((db) => {
    db.query(`UPDATE worker_heartbeats SET status = 'stopped', last_heartbeat_at = ? WHERE worker_id = ?`).run(
      nowIso(store.clock),
      workerId,
    );
  });
}

export function listWorkers(store: Store, kind?: WorkerKind): WorkerHeartbeat[] {
  const rows = all<{
    worker_id: string;
    kind: WorkerKind;
    pid: number;
    host: string;
    status: string;
    info: string;
    started_at: string;
    last_heartbeat_at: string;
  }>(
    store.db,
    `SELECT * FROM worker_heartbeats ${kind ? 'WHERE kind = ?' : ''} ORDER BY last_heartbeat_at DESC LIMIT 200`,
    ...(kind ? [kind] : []),
  );
  return rows.map((r) => ({
    workerId: r.worker_id,
    kind: r.kind,
    pid: r.pid,
    host: r.host,
    status: r.status,
    info: parseJson(r.info, {}),
    startedAt: r.started_at,
    lastHeartbeatAt: r.last_heartbeat_at,
  }));
}
