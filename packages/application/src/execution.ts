import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  type Actor,
  CrewError,
  fingerprint,
  isProcessAlive,
  matchesRecordedProcess,
  newId,
  nowIso,
} from '@crewyard/core';
import {
  abandonExecutionClaim,
  acquireExecutionClaim,
  all,
  type CrewContext,
  type ExecutionClaim,
  type ExecutionClaimToken,
  enqueueOutbox,
  getExecutionClaim,
  getOutbox,
  type OutboxOperation,
} from '@crewyard/storage';
import { executionResourcesState } from './execution-processes.ts';

export type ExecutionOperation =
  | { kind: 'index'; sha?: string; ref?: string; worktreePath?: string; force?: boolean }
  | { kind: 'sync' | 'publish' | 'queue' | 'outbox' | 'cleanup' | 'health' }
  | { kind: 'dispatch'; taskId: string; agentId: string };

export interface ExecutionRequest {
  projectId: string;
  repositoryId: string;
  actor: Actor;
  leaderId: string;
  operation: ExecutionOperation;
}

export interface ExecutionLimits {
  global: number;
  perProject: number;
  perDomain: number;
  leaseSeconds: number;
  timeoutSeconds: number;
  shutdownGraceSeconds: number;
}

export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = {
  global: 6,
  perProject: 4,
  perDomain: 1,
  leaseSeconds: 120,
  timeoutSeconds: 5_400,
  shutdownGraceSeconds: 10,
};

export interface ExecutionLaunch extends ExecutionRequest {
  claim: ExecutionClaimToken;
  directory: string;
  limits: ExecutionLimits;
  deadlineAt: string;
}

export const EXECUTION_LAUNCH_KIND = 'execution.launch';
export const EXECUTION_CANCEL_KIND = 'execution.cancel';

export function executionScope(request: ExecutionRequest): string {
  const subject = request.operation.kind === 'dispatch' ? request.operation.taskId : 'project';
  return `execution:${request.projectId}:${request.operation.kind}:${subject}`;
}

export function executionProcessState(claim: ExecutionClaim): 'live' | 'dead' | 'unknown' {
  if (!claim.process) return 'dead';
  if (claim.process.host !== hostname()) return 'unknown';
  if (!isProcessAlive(claim.process.pid)) return 'dead';
  const matches = matchesRecordedProcess(claim.process.pid, claim.process.startIdentity);
  return matches === true ? 'live' : matches === false ? 'dead' : 'unknown';
}

export function submitExecution(
  ctx: CrewContext,
  request: ExecutionRequest,
  limits: ExecutionLimits,
): OutboxOperation<ExecutionLaunch> | null {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new CrewError('INVALID_INPUT', 'Execution limits must be positive integers');
  }
  const scope = executionScope(request);
  const observed = getExecutionClaim(ctx.store.db, scope);
  let observedState = observed ? executionProcessState(observed) : 'dead';
  if (observed && observedState === 'dead') {
    const row = all<{ intent: string }>(
      ctx.store.db,
      `SELECT intent FROM outbox WHERE kind = ? AND json_extract(intent, '$.claim.attemptId') = ?`,
      EXECUTION_LAUNCH_KIND,
      observed.attemptId,
    )[0];
    if (row) observedState = executionResourcesState((JSON.parse(row.intent) as ExecutionLaunch).directory);
  }
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const current = getExecutionClaim(db, scope);
    if (current && current.releasedAt === null) {
      const existing = all<{ operation_id: string }>(
        db,
        `SELECT operation_id FROM outbox WHERE kind = ? AND json_extract(intent, '$.claim.attemptId') = ?`,
        EXECUTION_LAUNCH_KIND,
        current.attemptId,
      )[0];
      if (current.expiresAt > at) {
        if (!existing) throw new CrewError('INTERNAL', `Execution ${current.attemptId} has no launch intent`);
        const operation = getOutbox(db, existing.operation_id)!;
        const launch = operation.intent as unknown as ExecutionLaunch;
        if (fingerprint(launch.operation) !== fingerprint(request.operation)) {
          return null;
        }
        return operation as unknown as OutboxOperation<ExecutionLaunch>;
      }
      if (observed?.attemptId !== current.attemptId || observedState !== 'dead') return null;
      abandonExecutionClaim(db, current, at);
    }
    const active = all<{ projectId: string; kind: string }>(
      db,
      `SELECT json_extract(o.intent, '$.projectId') AS projectId, json_extract(o.intent, '$.operation.kind') AS kind
       FROM execution_claims c JOIN outbox o ON json_extract(o.intent, '$.claim.attemptId') = c.attempt_id
       WHERE o.kind = ? AND c.released_at IS NULL`,
      EXECUTION_LAUNCH_KIND,
    );
    if (
      active.length >= limits.global ||
      active.filter((row) => row.projectId === request.projectId).length >= limits.perProject ||
      active.filter((row) => row.projectId === request.projectId && row.kind === request.operation.kind).length >=
        limits.perDomain
    )
      return null;
    const attemptId = newId('lease');
    const claim = acquireExecutionClaim(
      db,
      {
        scope,
        attemptId,
        ownerId: attemptId,
        inputIdentity: fingerprint({
          projectId: request.projectId,
          repositoryId: request.repositoryId,
          operation: request.operation,
        }),
        ttlSeconds: limits.leaseSeconds,
      },
      at,
    );
    if (!claim) throw new CrewError('INTERNAL', `Execution admission changed within transaction for ${scope}`);
    const intent: ExecutionLaunch = {
      ...request,
      claim,
      directory: join(ctx.dirs.artifacts, 'executions', attemptId),
      limits,
      deadlineAt: new Date(Date.parse(at) + limits.timeoutSeconds * 1000).toISOString(),
    };
    return enqueueOutbox(
      db,
      {
        kind: EXECUTION_LAUNCH_KIND,
        projectId: request.projectId,
        taskId: request.operation.kind === 'dispatch' ? request.operation.taskId : null,
        subjectId: scope,
        intent: intent as unknown as Record<string, unknown>,
        idempotencyKey: `execution:${attemptId}`,
        maxAttempts: 3,
      },
      at,
    ) as unknown as OutboxOperation<ExecutionLaunch>;
  });
}
