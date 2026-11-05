import type { Database } from 'bun:sqlite';
import { addSeconds, CrewError, toIso } from '@crewyard/core';
import { one } from './db.ts';
import { recordTransition } from './events.ts';

export interface ExecutionClaimToken {
  scope: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  inputIdentity: string;
}

export interface ExecutionProcessIdentity {
  host: string;
  pid: number;
  startIdentity: string;
}

export interface ExecutionClaim extends ExecutionClaimToken {
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  process: ExecutionProcessIdentity | null;
}

export interface AcquireExecutionClaimInput {
  scope: string;
  attemptId: string;
  ownerId: string;
  inputIdentity: string;
  ttlSeconds: number;
}

interface ClaimRow {
  scope: string;
  attempt_id: string;
  owner_id: string;
  generation: number;
  input_identity: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  process_host: string | null;
  process_pid: number | null;
  process_start_identity: string | null;
}

function mapClaim(row: ClaimRow): ExecutionClaim {
  return {
    scope: row.scope,
    attemptId: row.attempt_id,
    ownerId: row.owner_id,
    generation: row.generation,
    inputIdentity: row.input_identity,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    process:
      row.process_pid === null
        ? null
        : {
            host: row.process_host!,
            pid: row.process_pid,
            startIdentity: row.process_start_identity!,
          },
  };
}

function requireTransaction(db: Database): void {
  if (!db.inTransaction) throw new CrewError('INTERNAL', 'Execution claims require a transaction');
}

function claimExpiry(at: string, ttlSeconds: number): string {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CrewError('INVALID_INPUT', 'Execution claim TTL must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(at)) || toIso(new Date(at)) !== at) {
    throw new CrewError('INVALID_INPUT', 'Execution claim time must be a canonical ISO timestamp');
  }
  return addSeconds(at, ttlSeconds);
}

function recordClaim(db: Database, claim: ExecutionClaim, action: string, at: string): void {
  recordTransition(
    db,
    {
      type: `execution.claim.${action}`,
      actor: { kind: 'system', id: claim.ownerId },
      correlationId: claim.attemptId,
      payload: {
        scope: claim.scope,
        attemptId: claim.attemptId,
        generation: claim.generation,
        inputIdentity: claim.inputIdentity,
        expiresAt: claim.expiresAt,
      },
    },
    {
      action: `execution.claim.${action}`,
      input: claim,
      decision: action,
    },
    at,
  );
}

export function getExecutionClaim(db: Database, scope: string): ExecutionClaim | null {
  const row = one<ClaimRow>(
    db,
    'SELECT * FROM execution_claims WHERE scope = ? ORDER BY generation DESC LIMIT 1',
    scope,
  );
  return row ? mapClaim(row) : null;
}

export function acquireExecutionClaim(
  db: Database,
  input: AcquireExecutionClaimInput,
  at: string,
): ExecutionClaim | null {
  requireTransaction(db);
  const expiresAt = claimExpiry(at, input.ttlSeconds);
  if (!input.scope || !input.attemptId || !input.ownerId || !input.inputIdentity) {
    throw new CrewError('INVALID_INPUT', 'Execution claims require scope, attempt, owner and input identities');
  }
  if (one(db, 'SELECT attempt_id FROM execution_claims WHERE attempt_id = ?', input.attemptId)) {
    throw new CrewError('CONFLICT', `Execution attempt ${input.attemptId} already exists`);
  }
  const current = getExecutionClaim(db, input.scope);
  if (current && current.releasedAt === null) {
    if (current.expiresAt > at) return null;
    db.query('UPDATE execution_claims SET released_at = ? WHERE attempt_id = ?').run(at, current.attemptId);
    recordClaim(db, current, 'expired', at);
  }
  const row = one<ClaimRow>(
    db,
    `INSERT INTO execution_claims (attempt_id, scope, owner_id, generation, input_identity, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    input.attemptId,
    input.scope,
    input.ownerId,
    (current?.generation ?? 0) + 1,
    input.inputIdentity,
    at,
    at,
    expiresAt,
  );
  const claim = mapClaim(row!);
  recordClaim(db, claim, 'acquired', at);
  return claim;
}

export function assertExecutionClaim(db: Database, token: ExecutionClaimToken, at: string): ExecutionClaim {
  requireTransaction(db);
  const claim = getExecutionClaim(db, token.scope);
  if (
    !claim ||
    claim.attemptId !== token.attemptId ||
    claim.ownerId !== token.ownerId ||
    claim.generation !== token.generation ||
    claim.inputIdentity !== token.inputIdentity ||
    claim.releasedAt !== null ||
    claim.expiresAt <= at
  ) {
    throw new CrewError('STALE_LEASE', `Execution claim for ${token.scope} is no longer current`);
  }
  return claim;
}

export function renewExecutionClaim(
  db: Database,
  token: ExecutionClaimToken,
  ttlSeconds: number,
  at: string,
): ExecutionClaim {
  const expiresAt = claimExpiry(at, ttlSeconds);
  const claim = assertExecutionClaim(db, token, at);
  db.query('UPDATE execution_claims SET heartbeat_at = ?, expires_at = ? WHERE attempt_id = ?').run(
    at,
    expiresAt,
    claim.attemptId,
  );
  const renewed = { ...claim, heartbeatAt: at, expiresAt };
  recordClaim(db, renewed, 'renewed', at);
  return renewed;
}

export function bindExecutionProcess(
  db: Database,
  token: ExecutionClaimToken,
  processIdentity: ExecutionProcessIdentity,
  at: string,
): ExecutionClaim {
  const claim = assertExecutionClaim(db, token, at);
  if (
    !processIdentity.host ||
    !Number.isSafeInteger(processIdentity.pid) ||
    processIdentity.pid <= 0 ||
    !processIdentity.startIdentity
  ) {
    throw new CrewError('INVALID_INPUT', 'Execution process requires host, positive PID and process start identity');
  }
  if (claim.process) {
    if (
      claim.process.host !== processIdentity.host ||
      claim.process.pid !== processIdentity.pid ||
      claim.process.startIdentity !== processIdentity.startIdentity
    ) {
      throw new CrewError('CONFLICT', `Execution attempt ${claim.attemptId} already has a different process identity`);
    }
    return claim;
  }
  db.query(
    'UPDATE execution_claims SET process_host = ?, process_pid = ?, process_start_identity = ? WHERE attempt_id = ?',
  ).run(processIdentity.host, processIdentity.pid, processIdentity.startIdentity, claim.attemptId);
  const bound = { ...claim, process: processIdentity };
  recordClaim(db, bound, 'process_bound', at);
  return bound;
}

export function releaseExecutionClaim(db: Database, token: ExecutionClaimToken, at: string): void {
  const claim = assertExecutionClaim(db, token, at);
  db.query('UPDATE execution_claims SET released_at = ? WHERE attempt_id = ?').run(at, claim.attemptId);
  recordClaim(db, claim, 'released', at);
}

export function abandonExecutionClaim(db: Database, token: ExecutionClaimToken, at: string): void {
  requireTransaction(db);
  const claim = getExecutionClaim(db, token.scope);
  if (
    !claim ||
    claim.attemptId !== token.attemptId ||
    claim.ownerId !== token.ownerId ||
    claim.generation !== token.generation ||
    claim.inputIdentity !== token.inputIdentity ||
    claim.releasedAt !== null ||
    claim.expiresAt > at
  ) {
    throw new CrewError('STALE_LEASE', `Expired execution claim for ${token.scope} is no longer current`);
  }
  db.query('UPDATE execution_claims SET released_at = ? WHERE attempt_id = ?').run(at, claim.attemptId);
  recordClaim(db, claim, 'abandoned', at);
}
