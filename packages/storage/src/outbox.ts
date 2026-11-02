import type { Database } from 'bun:sqlite';
import { backoffWithJitter, newId, nowIso, redactObject, sha256, stableStringify, toIso } from '@crewyard/core';
import { all, one, parseJson, type Store } from './db.ts';

export type OutboxStatus = 'pending' | 'attempted' | 'succeeded' | 'failed' | 'ambiguous' | 'cancelled';

export interface OutboxOperation<TIntent = Record<string, unknown>> {
  operationId: string;
  kind: string;
  projectId: string | null;
  taskId: string | null;
  subjectId: string | null;
  intent: TIntent;
  expectedState: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  remoteCorrelation: Record<string, unknown> | null;
  leaderGeneration: number | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutboxRow {
  operation_id: string;
  kind: string;
  project_id: string | null;
  task_id: string | null;
  subject_id: string | null;
  intent: string;
  expected_state: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  remote_correlation: string | null;
  leader_generation: number | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow<T>(row: OutboxRow): OutboxOperation<T> {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    projectId: row.project_id,
    taskId: row.task_id,
    subjectId: row.subject_id,
    intent: parseJson(row.intent, {} as T),
    expectedState: parseJson(row.expected_state, {}),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    remoteCorrelation: parseJson(row.remote_correlation, null),
    leaderGeneration: row.leader_generation,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueInput {
  kind: string;
  projectId?: string | null;
  taskId?: string | null;
  subjectId?: string | null;
  intent: Record<string, unknown>;
  expectedState?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  leaderGeneration?: number | null;
  operationId?: string;
}

export function enqueueOutbox(db: Database, input: EnqueueInput, at: string = nowIso()): OutboxOperation {
  const key = input.idempotencyKey ?? sha256(stableStringify({ kind: input.kind, intent: input.intent }));
  const existing = one<OutboxRow>(db, 'SELECT * FROM outbox WHERE idempotency_key = ?', key);
  if (existing) return mapRow(existing);
  const row = one<OutboxRow>(
    db,
    `INSERT INTO outbox (operation_id, kind, project_id, task_id, subject_id, intent, expected_state, status, attempts, max_attempts, next_attempt_at, leader_generation, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?) RETURNING *`,
    input.operationId ?? newId('op'),
    input.kind,
    input.projectId ?? null,
    input.taskId ?? null,
    input.subjectId ?? null,
    JSON.stringify(redactObject(input.intent)),
    JSON.stringify(input.expectedState ?? {}),
    input.maxAttempts ?? 5,
    at,
    input.leaderGeneration ?? null,
    key,
    at,
    at,
  );
  return mapRow(row!);
}

export function getOutbox(db: Database, operationId: string): OutboxOperation | null {
  const row = one<OutboxRow>(db, 'SELECT * FROM outbox WHERE operation_id = ?', operationId);
  return row ? mapRow(row) : null;
}

export function listOutbox(
  store: Store,
  filter: { statuses?: OutboxStatus[]; kind?: string; limit?: number } = {},
): OutboxOperation[] {
  const statuses = filter.statuses ?? ['pending', 'attempted', 'ambiguous'];
  const params: (string | number)[] = [...statuses];
  let sql = `SELECT * FROM outbox WHERE status IN (${statuses.map(() => '?').join(',')})`;
  if (filter.kind) {
    sql += ' AND kind = ?';
    params.push(filter.kind);
  }
  sql += ` ORDER BY created_at LIMIT ${Math.min(filter.limit ?? 100, 1000)}`;
  return all<OutboxRow>(store.db, sql, ...params).map((r) => mapRow(r));
}

export function claimDueOutbox(store: Store, limit = 10, kinds?: string[]): OutboxOperation[] {
  const at = nowIso(store.clock);
  return store.immediate((db) => {
    const params: (string | number)[] = [at];
    let sql = `SELECT * FROM outbox WHERE status IN ('pending', 'attempted', 'ambiguous') AND next_attempt_at <= ?`;
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    sql += ` ORDER BY next_attempt_at LIMIT ${limit}`;
    const rows = all<OutboxRow>(db, sql, ...params);
    for (const row of rows) {
      const lease = toIso(new Date(Date.parse(at) + 60_000));
      db.query(
        `UPDATE outbox SET status = CASE WHEN status = 'pending' THEN 'attempted' ELSE status END, attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
      ).run(lease, at, row.operation_id);
    }
    return rows.map((r) =>
      mapRow({ ...r, status: r.status === 'pending' ? 'attempted' : r.status, attempts: r.attempts + 1 }),
    );
  });
}

export function completeOutbox(
  db: Database,
  operationId: string,
  outcome:
    | { status: 'succeeded'; remoteCorrelation?: Record<string, unknown> }
    | { status: 'failed'; error: string; remoteCorrelation?: Record<string, unknown> }
    | { status: 'ambiguous'; error: string; remoteCorrelation?: Record<string, unknown> }
    | { status: 'retry'; error: string; attempts: number }
    | { status: 'cancelled'; error: string },
  at: string = nowIso(),
): void {
  if (outcome.status === 'retry') {
    const next = toIso(new Date(Date.parse(at) + backoffWithJitter(outcome.attempts)));
    db.query(
      `UPDATE outbox SET status = 'attempted', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
    ).run(outcome.error, next, at, operationId);
    return;
  }
  const correlation =
    'remoteCorrelation' in outcome && outcome.remoteCorrelation ? JSON.stringify(outcome.remoteCorrelation) : null;
  const next = outcome.status === 'ambiguous' ? toIso(new Date(Date.parse(at) + 5_000)) : at;
  db.query(
    `UPDATE outbox SET status = ?, last_error = ?, remote_correlation = COALESCE(?, remote_correlation), next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
  ).run(outcome.status, 'error' in outcome ? outcome.error : null, correlation, next, at, operationId);
}

export interface RemoteOperationInput {
  operationId: string | null;
  host: string;
  method: string;
  target: string;
  request: unknown;
  responseStatus?: number | null;
  remoteId?: string | null;
  result?: unknown;
}

export function recordRemoteOperation(db: Database, input: RemoteOperationInput, at: string = nowIso()): string {
  const id = newId('rop');
  db.query(
    `INSERT INTO remote_operations (id, operation_id, host, method, target, request_fingerprint, response_status, remote_id, result, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.operationId,
    input.host,
    input.method,
    input.target,
    sha256(stableStringify(redactObject(input.request ?? null))),
    input.responseStatus ?? null,
    input.remoteId ?? null,
    input.result === undefined ? null : JSON.stringify(redactObject(input.result)),
    at,
  );
  return id;
}
