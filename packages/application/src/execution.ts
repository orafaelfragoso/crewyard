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
import type { ReviewType } from '@crewyard/reviews';
import {
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
import type { LeaseHolder } from '@crewyard/tasks';

export type ExecutionOperation =
  | { kind: 'index'; sha: string; ref?: string; worktreePath?: string; force?: boolean; indexRevision: string }
  | { kind: 'sync' | 'publish' | 'outbox' | 'cleanup' | 'health' }
  | {
      kind: 'queue';
      sync: boolean;
      maxCandidates: number;
      processOutbox: boolean;
      configurationFingerprint: string;
      queueRevision: string;
    }
  | {
      kind: 'review';
      prId: string;
      expectedHeadSha: string;
      expectedBaseSha: string;
      configurationFingerprint: string;
      types: ReviewType[];
      force: boolean;
    }
  | {
      kind: 'workspace';
      taskId: string;
      baseRef: string;
      baseSha: string;
      configurationFingerprint: string;
      lease: { id: string; generation: number; holder: LeaseHolder };
    }
  | {
      kind: 'dispatch';
      taskId: string;
      agentId: string;
      model: string | null;
      taskRevision: number;
      configurationFingerprint: string;
      agentConfigurationFingerprint: string;
    };

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
  const subject =
    request.operation.kind === 'dispatch' || request.operation.kind === 'workspace'
      ? request.operation.taskId
      : request.operation.kind === 'review'
        ? request.operation.prId
        : 'project';
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
  if (
    request.operation.kind === 'index' &&
    (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.operation.sha) || !request.operation.indexRevision)
  )
    throw new CrewError('INVALID_INPUT', 'Index execution requires an exact commit SHA and configuration revision');
  const scope = executionScope(request);
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
        if (
          fingerprint({
            projectId: launch.projectId,
            repositoryId: launch.repositoryId,
            operation: launch.operation,
          }) !==
          fingerprint({
            projectId: request.projectId,
            repositoryId: request.repositoryId,
            operation: request.operation,
          })
        ) {
          return null;
        }
        return operation as unknown as OutboxOperation<ExecutionLaunch>;
      }
      return null;
    }
    const active = all<{
      projectId: string;
      kind: string;
      globalLimit: number;
      projectLimit: number;
      domainLimit: number;
    }>(
      db,
      `SELECT json_extract(o.intent, '$.projectId') AS projectId, json_extract(o.intent, '$.operation.kind') AS kind, json_extract(o.intent, '$.limits.global') AS globalLimit, json_extract(o.intent, '$.limits.perProject') AS projectLimit, json_extract(o.intent, '$.limits.perDomain') AS domainLimit
       FROM execution_claims c JOIN outbox o ON json_extract(o.intent, '$.claim.attemptId') = c.attempt_id
       WHERE o.kind = ? AND c.released_at IS NULL`,
      EXECUTION_LAUNCH_KIND,
    );
    const projectActive = active.filter((row) => row.projectId === request.projectId);
    const domainActive = projectActive.filter((row) => row.kind === request.operation.kind);
    if (
      active.length >= Math.min(limits.global, ...active.map((row) => row.globalLimit)) ||
      projectActive.length >= Math.min(limits.perProject, ...projectActive.map((row) => row.projectLimit)) ||
      domainActive.length >= Math.min(limits.perDomain, ...domainActive.map((row) => row.domainLimit))
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
        taskId:
          request.operation.kind === 'dispatch' || request.operation.kind === 'workspace'
            ? request.operation.taskId
            : null,
        subjectId: scope,
        intent: intent as unknown as Record<string, unknown>,
        idempotencyKey: `execution:${attemptId}`,
        maxAttempts: 3,
      },
      at,
    ) as unknown as OutboxOperation<ExecutionLaunch>;
  });
}
