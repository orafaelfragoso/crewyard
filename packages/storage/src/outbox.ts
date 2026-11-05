import type { Database } from 'bun:sqlite';
import {
  backoffWithJitter,
  CrewError,
  newId,
  nowIso,
  redactObject,
  sha256,
  stableStringify,
  toIso,
} from '@crewyard/core';
import { all, one, parseJson, type Store } from './db.ts';
import { recordTransition } from './events.ts';
import {
  acquireExecutionClaim,
  assertExecutionClaim,
  bindExecutionProcess,
  type ExecutionClaim,
  type ExecutionProcessIdentity,
  releaseExecutionClaim,
  renewExecutionClaim,
} from './execution-claims.ts';

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

export interface ClaimedOutboxOperation<TIntent = Record<string, unknown>> extends OutboxOperation<TIntent> {
  claim: ExecutionClaim;
}

export interface ClaimDueOutboxInput {
  ownerId: string;
  limit: number;
  kinds: string[];
  ttlSeconds: number;
  operationIds?: readonly string[];
  process?: ExecutionProcessIdentity;
  preserveProcessClaims?: boolean;
}

function outboxInputIdentity(row: OutboxRow): string {
  return sha256(
    stableStringify({
      operationId: row.operation_id,
      kind: row.kind,
      intent: row.intent,
      expectedState: row.expected_state,
    }),
  );
}

function recordDelivery(db: Database, op: ClaimedOutboxOperation, action: string, at: string): void {
  recordTransition(
    db,
    {
      type: `outbox.${action}`,
      actor: { kind: 'system', id: op.claim.ownerId },
      projectId: op.projectId,
      taskId: op.taskId,
      correlationId: op.operationId,
      payload: { operationId: op.operationId, attemptId: op.claim.attemptId, generation: op.claim.generation },
    },
    { action: `outbox.${action}`, input: op.claim, decision: action },
    at,
  );
}

export function claimDueOutbox(store: Store, input: ClaimDueOutboxInput): ClaimedOutboxOperation[] {
  if (
    !input.ownerId ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1000 ||
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0
  ) {
    throw new CrewError(
      'INVALID_INPUT',
      'Outbox claim requires an owner, a limit from 1 to 1000 and positive integer TTL',
    );
  }
  return store.immediate((db) => {
    const at = nowIso(store.clock);
    const params: (string | number)[] = [at, at];
    let sql = `SELECT * FROM outbox WHERE status IN ('pending', 'attempted', 'ambiguous') AND next_attempt_at <= ?
      AND NOT EXISTS (SELECT 1 FROM execution_claims c WHERE c.scope = 'outbox:' || outbox.operation_id
        AND c.released_at IS NULL AND (c.expires_at > ?${input.preserveProcessClaims ? ' OR c.process_pid IS NOT NULL' : ''}))`;
    if (input.operationIds) {
      if (input.operationIds.length === 0) return [];
      sql += ` AND operation_id IN (${input.operationIds.map(() => '?').join(',')})`;
      params.push(...input.operationIds);
    }
    if (input.kinds.length > 0) {
      sql += ` AND kind IN (${input.kinds.map(() => '?').join(',')})`;
      params.push(...input.kinds);
    }
    sql += ' ORDER BY next_attempt_at, operation_id LIMIT ?';
    params.push(input.limit);
    return all<OutboxRow>(db, sql, ...params).map((row) => {
      let claim = acquireExecutionClaim(
        db,
        {
          scope: `outbox:${row.operation_id}`,
          attemptId: newId('lease'),
          ownerId: input.ownerId,
          inputIdentity: outboxInputIdentity(row),
          ttlSeconds: input.ttlSeconds,
        },
        at,
      );
      if (!claim) throw new CrewError('INTERNAL', 'Due outbox operation already has an active delivery claim');
      if (input.process) claim = bindExecutionProcess(db, claim, input.process, at);
      const updated = one<OutboxRow>(
        db,
        `UPDATE outbox SET status = CASE WHEN status = 'pending' THEN 'attempted' ELSE status END,
          attempts = attempts + 1, updated_at = ? WHERE operation_id = ? RETURNING *`,
        at,
        row.operation_id,
      );
      const op = { ...mapRow<Record<string, unknown>>(updated!), claim };
      recordDelivery(db, op, 'claimed', at);
      return op;
    });
  });
}

export function assertOutboxClaim(db: Database, op: ClaimedOutboxOperation, at: string): ExecutionClaim {
  const claim = assertExecutionClaim(db, op.claim, at);
  const current = one<OutboxRow>(db, 'SELECT * FROM outbox WHERE operation_id = ?', op.operationId);
  if (
    !current ||
    claim.scope !== `outbox:${op.operationId}` ||
    outboxInputIdentity(current) !== claim.inputIdentity ||
    !['pending', 'attempted', 'ambiguous'].includes(current.status)
  ) {
    throw new CrewError('STALE_LEASE', `Outbox delivery for ${op.operationId} is no longer current`);
  }
  return claim;
}

export function renewOutboxClaim(store: Store, op: ClaimedOutboxOperation, ttlSeconds: number): ExecutionClaim {
  return store.immediate((db) => {
    const at = nowIso(store.clock);
    assertOutboxClaim(db, op, at);
    return renewExecutionClaim(db, op.claim, ttlSeconds, at);
  });
}

export type OutboxOutcome =
  | { status: 'succeeded'; remoteCorrelation?: Record<string, unknown> }
  | { status: 'failed'; error: string; remoteCorrelation?: Record<string, unknown> }
  | { status: 'ambiguous'; error: string; remoteCorrelation?: Record<string, unknown>; nextAttemptAt?: string }
  | { status: 'retry'; error: string; attempts: number; nextAttemptAt?: string }
  | { status: 'cancelled'; error: string; remoteCorrelation?: Record<string, unknown> };

export function completeOutbox(db: Database, op: ClaimedOutboxOperation, outcome: OutboxOutcome, at: string): void {
  assertOutboxClaim(db, op, at);
  if (outcome.status === 'retry') {
    const next = outcome.nextAttemptAt ?? toIso(new Date(Date.parse(at) + backoffWithJitter(outcome.attempts)));
    db.query(
      `UPDATE outbox SET status = 'attempted', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
    ).run(outcome.error, next, at, op.operationId);
  } else {
    const correlation =
      'remoteCorrelation' in outcome && outcome.remoteCorrelation ? JSON.stringify(outcome.remoteCorrelation) : null;
    const next =
      outcome.status === 'ambiguous' ? (outcome.nextAttemptAt ?? toIso(new Date(Date.parse(at) + 5_000))) : at;
    db.query(
      `UPDATE outbox SET status = ?, last_error = ?, remote_correlation = COALESCE(?, remote_correlation), next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
    ).run(outcome.status, 'error' in outcome ? outcome.error : null, correlation, next, at, op.operationId);
  }
  releaseExecutionClaim(db, op.claim, at);
  recordDelivery(db, op, outcome.status, at);
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
