import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import {
  type Actor,
  addSeconds,
  allowedNextStates,
  CrewError,
  hashToken,
  LEASED_TASK_STATES,
  newId,
  newSecretToken,
  nowIso,
  SYSTEM_ACTOR,
  type TaskState,
  timingSafeEqualHex,
} from '@crewyard/core';
import { requestInterventionInTx } from '@crewyard/reviews';
import { all, type CrewContext, exec, one, recordTransition } from '@crewyard/storage';
import { resolveTaskConfig } from './config.ts';
import {
  type LeaseHolder,
  type LeaseInfo,
  type LeaseRow,
  mapLease,
  mapReservation,
  type Reservation,
  type ReservationRow,
  type Task,
  type TaskView,
} from './model.ts';
import {
  activeLeaseRow,
  dependencyStatuses,
  latestLeaseRow,
  projectFlags,
  requireTask,
  taskApprovalSatisfied,
  toView,
} from './queries.ts';
import { findScopeConflicts, requestedScopes, type ScopeConflict, type ScopeHolding } from './scopes.ts';
import { needsReconciliation } from './tasks.ts';
import { applyTransition, type TransitionResult } from './transitions.ts';

export interface LeaseCredentials {
  taskId: string;
  generation: number;
  token: string;
}

export interface ClaimInput {
  taskId: string;
  holder: LeaseHolder;
  impactScopes?: string[];
  leaseSeconds?: number;
  config?: CrewConfig;
}

export interface ClaimResult {
  taskId: string;
  leaseId: string;
  generation: number;
  token: string;
  expiresAt: string;
  heartbeatIntervalSeconds: number;
  reservations: Reservation[];
  advisoryOverlaps: ScopeConflict[];
  task: TaskView;
}

function holderActor(holder: LeaseHolder): Actor {
  return { kind: holder.kind, id: holder.id };
}

function isConstraintError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(String(error));
}

function activeHoldings(db: Database, projectId: string): ScopeHolding[] {
  return all<{ task_id: string; scope: string; mode: 'advisory' | 'exclusive' }>(
    db,
    'SELECT task_id, scope, mode FROM task_scope_reservations WHERE project_id = ? AND released_at IS NULL',
    projectId,
  ).map((r) => ({ taskId: r.task_id, scope: r.scope, mode: r.mode }));
}

function countActiveLeases(db: Database, where: string, ...params: string[]): number {
  return (
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM leases l JOIN tasks t ON t.id = l.task_id WHERE l.released_at IS NULL AND ${where}`,
      ...params,
    )?.n ?? 0
  );
}

function agentWipLimit(db: Database, agentId: string, fallback: number): number {
  const row = one<{ max_parallel: number }>(db, 'SELECT max_parallel FROM agents WHERE id = ?', agentId);
  return row ? Math.max(row.max_parallel, 1) : fallback;
}

function assertWipLimits(db: Database, task: Task, holder: LeaseHolder, config: CrewConfig): void {
  const wip = config.scheduler.wip;
  const checks: { scope: string; limit: number | undefined; used: () => number }[] = [
    { scope: 'global', limit: wip.global, used: () => countActiveLeases(db, '1 = 1') },
    { scope: 'project', limit: wip.project, used: () => countActiveLeases(db, 't.project_id = ?', task.projectId) },
    {
      scope: 'repository',
      limit: task.repositoryId === null ? undefined : wip.repository,
      used: () => countActiveLeases(db, 't.repository_id = ?', task.repositoryId ?? ''),
    },
    {
      scope: 'agent',
      limit: holder.kind === 'agent' ? agentWipLimit(db, holder.id, wip.agent) : undefined,
      used: () => countActiveLeases(db, "l.holder_kind = 'agent' AND l.holder_id = ?", holder.id),
    },
  ];
  for (const check of checks) {
    if (check.limit === undefined) continue;
    const used = check.used();
    if (used >= check.limit) {
      throw new CrewError('POLICY_DENIED', `WIP limit reached for ${check.scope} (${used}/${check.limit})`, {
        details: { reason: 'wip_limit', scope: check.scope, used, limit: check.limit },
        suggestion: 'Finish or release in-progress work before claiming more.',
        retryable: true,
      });
    }
  }
}

function assertClaimable(db: Database, task: Task, holder: LeaseHolder): void {
  const active = activeLeaseRow(db, task.id);
  if (active) {
    throw new CrewError('LEASE_CONFLICT', `Task ${task.id} is already claimed (generation ${active.generation})`, {
      details: { taskId: task.id, generation: active.generation, expiresAt: active.expires_at },
      suggestion: 'Pick another task with crew_get_next_action.',
    });
  }
  const claimable = task.state === 'READY' || task.state === 'REVISION';
  if (!claimable) {
    if (LEASED_TASK_STATES.has(task.state) || task.state === 'CANCEL_REQUESTED') {
      throw new CrewError('LEASE_CONFLICT', `Task ${task.id} is ${task.state} and awaiting lease reconciliation`, {
        details: { taskId: task.id, state: task.state, reason: 'awaiting_reconciliation' },
        suggestion: 'Recovery must reconcile the previous holder before the task can be claimed again.',
      });
    }
    throw new CrewError(
      'INVALID_TRANSITION',
      `Task ${task.id} is ${task.state}; only READY or REVISION tasks can be claimed`,
      {
        details: { from: task.state, to: 'CLAIMED', allowed: allowedNextStates(task.state) },
      },
    );
  }
  if (task.paused) {
    throw new CrewError('POLICY_DENIED', `Task ${task.id} is paused`, {
      details: { reason: 'task_paused' },
      suggestion: 'An operator must resume the task first.',
    });
  }
  const flags = projectFlags(db, task.projectId);
  if (flags.intakePaused) {
    throw new CrewError('POLICY_DENIED', 'Project intake is paused', {
      details: { reason: 'intake_paused' },
      retryable: true,
    });
  }
  if (flags.autonomy === 'observe') {
    throw new CrewError('POLICY_DENIED', 'Project is in observe mode; no code changes are dispatched', {
      details: { reason: 'autonomy_observe' },
    });
  }
  const blockedBy = dependencyStatuses(db, task.id).filter((d) => !d.satisfied);
  if (blockedBy.length > 0) {
    throw new CrewError('CONFLICT', `Task ${task.id} has unsatisfied dependencies`, {
      details: { reason: 'dependencies_unsatisfied', blockedBy },
      suggestion: 'Dependencies must be MERGED or DONE first.',
    });
  }
  if (
    task.assignedAgentId &&
    !(holder.kind === 'agent' && holder.id === task.assignedAgentId) &&
    holder.kind !== 'operator'
  ) {
    throw new CrewError('POLICY_DENIED', `Task ${task.id} is assigned to agent ${task.assignedAgentId}`, {
      details: { reason: 'assigned_elsewhere', assignedAgentId: task.assignedAgentId },
    });
  }
  const approval = taskApprovalSatisfied(db, task);
  if (!approval.satisfied) {
    throw new CrewError('APPROVAL_REQUIRED', `Task ${task.id} requires operator approval before it can be claimed`, {
      details: {
        approvalId: approval.approval?.id ?? null,
        status: approval.approval?.status ?? null,
        classes: task.artifacts.approval?.requiredClasses ?? [],
      },
      suggestion: `Run \`crew task approve ${task.id}\`.`,
    });
  }
}

export function claimTask(ctx: CrewContext, input: ClaimInput): ClaimResult {
  const projectId = requireTask(ctx.store.db, input.taskId).projectId;
  const config = resolveTaskConfig(ctx, projectId, input.config);
  const leaseSeconds = input.leaseSeconds ?? config.agents.default_task_lease_seconds;
  if (!(Number.isInteger(leaseSeconds) && leaseSeconds >= 30)) {
    throw new CrewError('INVALID_INPUT', 'leaseSeconds must be an integer of at least 30');
  }
  const token = newSecretToken();
  const actor = holderActor(input.holder);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, input.taskId);
    assertClaimable(db, task, input.holder);
    assertWipLimits(db, task, input.holder, config);

    const requests = requestedScopes(task, config, input.impactScopes);
    const conflicts = findScopeConflicts(requests, activeHoldings(db, task.projectId), task.id);
    if (conflicts.exclusive.length > 0) {
      throw new CrewError('RESERVATION_CONFLICT', `Task ${task.id} conflicts with exclusive reservations`, {
        details: {
          conflictingTaskIds: [...new Set(conflicts.exclusive.map((c) => c.conflictingTaskId))].sort(),
          conflicts: conflicts.exclusive,
        },
        suggestion: 'Wait for the conflicting task to finish or pick another task.',
        retryable: true,
      });
    }

    const generation = task.leaseGeneration + 1;
    const leaseId = newId('lease');
    const expiresAt = addSeconds(at, leaseSeconds);
    try {
      exec(
        db,
        `INSERT INTO leases (id, task_id, generation, holder_kind, holder_id, token_hash, acquired_at, expires_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        leaseId,
        task.id,
        generation,
        input.holder.kind,
        input.holder.id,
        hashToken(token),
        at,
        expiresAt,
        at,
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new CrewError('LEASE_CONFLICT', `Task ${task.id} is already claimed`, { cause: error });
      }
      throw error;
    }
    exec(
      db,
      'UPDATE task_scope_reservations SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
      at,
      task.id,
    );
    for (const request of requests) {
      try {
        exec(
          db,
          `INSERT INTO task_scope_reservations (id, task_id, repository_id, project_id, lease_generation, scope, mode, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId('res'),
          task.id,
          task.repositoryId,
          task.projectId,
          generation,
          request.scope,
          request.mode,
          request.source,
          at,
        );
      } catch (error) {
        if (!isConstraintError(error)) throw error;
        const holder = one<{ task_id: string }>(
          db,
          `SELECT task_id FROM task_scope_reservations WHERE project_id = ? AND scope = ? AND mode = 'exclusive' AND released_at IS NULL`,
          task.projectId,
          request.scope,
        );
        throw new CrewError('RESERVATION_CONFLICT', `Scope ${request.scope} is exclusively reserved`, {
          details: { scope: request.scope, conflictingTaskIds: holder ? [holder.task_id] : [] },
          cause: error,
          retryable: true,
        });
      }
    }
    exec(db, 'UPDATE tasks SET lease_generation = ?, attempts = attempts + 1 WHERE id = ?', generation, task.id);
    if (requests.length > 0) {
      recordTransition(
        db,
        {
          type: 'reservation.acquired',
          actor,
          projectId: task.projectId,
          taskId: task.id,
          payload: { generation, scopes: requests, advisoryOverlaps: conflicts.advisory },
        },
        { action: 'reservation.acquire', input: { taskId: task.id, generation, requests }, decision: 'accepted' },
        at,
      );
    }
    const claimed =
      task.state === 'READY'
        ? applyTransition(
            db,
            {
              taskId: task.id,
              to: 'CLAIMED',
              actor,
              reason: 'claimed',
              eventType: 'task.claimed',
              payload: { generation, holder: input.holder, expiresAt },
            },
            at,
          ).task
        : claimRevision(db, task, actor, generation, input.holder, expiresAt, at);
    return {
      taskId: task.id,
      leaseId,
      generation,
      token,
      expiresAt,
      heartbeatIntervalSeconds: config.agents.heartbeat_interval_seconds,
      reservations: all<ReservationRow>(
        db,
        'SELECT * FROM task_scope_reservations WHERE task_id = ? AND released_at IS NULL ORDER BY scope',
        task.id,
      ).map(mapReservation),
      advisoryOverlaps: conflicts.advisory,
      task: claimed,
    };
  });
}

function claimRevision(
  db: Database,
  task: Task,
  actor: Actor,
  generation: number,
  holder: LeaseHolder,
  expiresAt: string,
  at: string,
): TaskView {
  exec(db, 'UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ?', at, task.id);
  recordTransition(
    db,
    {
      type: 'task.claimed',
      actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { from: 'REVISION', to: 'REVISION', generation, holder, expiresAt },
    },
    { action: 'task.claim', input: { taskId: task.id, generation }, decision: 'accepted' },
    at,
  );
  return toView(db, requireTask(db, task.id));
}

export interface VerifiedLease {
  task: Task;
  lease: LeaseRow;
}

export function verifyLeaseInTx(db: Database, credentials: LeaseCredentials, at: string): VerifiedLease {
  const task = requireTask(db, credentials.taskId);
  const lease = one<LeaseRow>(
    db,
    'SELECT * FROM leases WHERE task_id = ? AND generation = ?',
    credentials.taskId,
    credentials.generation,
  );
  const stale = (reason: string) =>
    new CrewError(
      'STALE_LEASE',
      `Lease generation ${credentials.generation} for ${task.id} is no longer valid (${reason})`,
      {
        details: {
          taskId: task.id,
          generation: credentials.generation,
          currentGeneration: task.leaseGeneration,
          reason,
        },
        suggestion: 'Stop working on this task; call crew_get_next_action for new work.',
        retryable: false,
      },
    );
  if (!lease) throw stale('unknown_generation');
  if (!timingSafeEqualHex(lease.token_hash, hashToken(credentials.token))) {
    throw new CrewError('NOT_AUTHORIZED', `Invalid lease token for ${task.id}`, {
      details: { taskId: task.id, generation: credentials.generation },
    });
  }
  if (credentials.generation !== task.leaseGeneration) throw stale('superseded');
  if (lease.released_at !== null) throw stale(lease.release_reason ?? 'released');
  if (Date.parse(lease.expires_at) <= Date.parse(at)) throw stale('expired');
  return { task, lease };
}

function renewInTx(db: Database, verified: VerifiedLease, leaseSeconds: number, actor: Actor, at: string): string {
  const expiresAt = addSeconds(at, leaseSeconds);
  exec(db, 'UPDATE leases SET expires_at = ?, heartbeat_at = ? WHERE id = ?', expiresAt, at, verified.lease.id);
  recordTransition(
    db,
    {
      type: 'lease.renewed',
      actor,
      projectId: verified.task.projectId,
      taskId: verified.task.id,
      payload: { generation: verified.lease.generation, expiresAt },
    },
    {
      action: 'lease.renew',
      input: { taskId: verified.task.id, generation: verified.lease.generation },
      decision: 'accepted',
    },
    at,
  );
  return expiresAt;
}

function leaseActor(lease: LeaseRow): Actor {
  return { kind: lease.holder_kind, id: lease.holder_id };
}

export interface HeartbeatResult {
  taskId: string;
  generation: number;
  expiresAt: string;
  state: TaskState;
  cancelRequested: boolean;
  paused: boolean;
}

export function heartbeat(
  ctx: CrewContext,
  credentials: LeaseCredentials,
  options: { leaseSeconds?: number; config?: CrewConfig } = {},
): HeartbeatResult {
  const projectId = requireTask(ctx.store.db, credentials.taskId).projectId;
  const leaseSeconds =
    options.leaseSeconds ?? resolveTaskConfig(ctx, projectId, options.config).agents.default_task_lease_seconds;
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const verified = verifyLeaseInTx(db, credentials, at);
    const expiresAt = renewInTx(db, verified, leaseSeconds, leaseActor(verified.lease), at);
    return {
      taskId: verified.task.id,
      generation: verified.lease.generation,
      expiresAt,
      state: verified.task.state,
      cancelRequested: verified.task.state === 'CANCEL_REQUESTED',
      paused: verified.task.paused,
    };
  });
}

function assertAgentMutable(task: Task): void {
  if (task.state === 'CANCEL_REQUESTED') {
    throw new CrewError('INVALID_TRANSITION', `Task ${task.id} has a pending cancellation`, {
      details: { from: task.state, allowed: allowedNextStates(task.state) },
      suggestion: 'Stop work and release the lease.',
    });
  }
}

export function startTask(ctx: CrewContext, credentials: LeaseCredentials & { sessionId?: string }): TaskView {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const verified = verifyLeaseInTx(db, credentials, at);
    if (verified.task.state === 'RUNNING') return toView(db, verified.task);
    assertAgentMutable(verified.task);
    return applyTransition(
      db,
      {
        taskId: verified.task.id,
        to: 'RUNNING',
        actor: leaseActor(verified.lease),
        reason: 'started',
        payload: { generation: verified.lease.generation, sessionId: credentials.sessionId ?? null },
      },
      at,
    ).task;
  });
}

export interface ProgressInput extends LeaseCredentials {
  summary: string;
  percent?: number;
  commits?: string[];
}

export function reportProgress(
  ctx: CrewContext,
  input: ProgressInput,
  options: { leaseSeconds?: number; config?: CrewConfig } = {},
): HeartbeatResult & { task: TaskView } {
  if (input.summary.trim() === '') throw new CrewError('INVALID_INPUT', 'summary is required');
  if (input.percent !== undefined && !(input.percent >= 0 && input.percent <= 100)) {
    throw new CrewError('INVALID_INPUT', 'percent must be between 0 and 100');
  }
  const projectId = requireTask(ctx.store.db, input.taskId).projectId;
  const leaseSeconds =
    options.leaseSeconds ?? resolveTaskConfig(ctx, projectId, options.config).agents.default_task_lease_seconds;
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const verified = verifyLeaseInTx(db, input, at);
    const actor = leaseActor(verified.lease);
    const checkpoint = {
      summary: input.summary,
      ...(input.percent === undefined ? {} : { percent: input.percent }),
      ...(input.commits === undefined ? {} : { commits: input.commits }),
      at,
      generation: verified.lease.generation,
    };
    exec(
      db,
      'UPDATE tasks SET artifacts = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      JSON.stringify({ ...verified.task.artifacts, checkpoint }),
      at,
      verified.task.id,
    );
    recordTransition(
      db,
      {
        type: 'task.progress',
        actor,
        projectId: verified.task.projectId,
        taskId: verified.task.id,
        payload: checkpoint,
      },
      { action: 'task.report_progress', input: checkpoint, decision: 'accepted' },
      at,
    );
    const expiresAt = renewInTx(db, verified, leaseSeconds, actor, at);
    const task = requireTask(db, verified.task.id);
    return {
      taskId: task.id,
      generation: verified.lease.generation,
      expiresAt,
      state: task.state,
      cancelRequested: task.state === 'CANCEL_REQUESTED',
      paused: task.paused,
      task: toView(db, task),
    };
  });
}

function releaseTarget(state: TaskState): TaskState {
  return state === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'READY';
}

export function releaseLease(ctx: CrewContext, credentials: LeaseCredentials & { reason?: string }): TransitionResult {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const verified = verifyLeaseInTx(db, credentials, at);
    return applyTransition(
      db,
      {
        taskId: verified.task.id,
        to: releaseTarget(verified.task.state),
        actor: leaseActor(verified.lease),
        reason: credentials.reason ? `released: ${credentials.reason}` : 'released',
      },
      at,
    );
  });
}

export interface ExpiredLease {
  taskId: string;
  projectId: string;
  generation: number;
  holder: LeaseHolder;
  expiresAt: string;
  taskState: TaskState;
}

function expiredRows(
  db: Database,
  at: string,
  projectId?: string,
): (LeaseRow & { project_id: string; state: TaskState })[] {
  return all<LeaseRow & { project_id: string; state: TaskState }>(
    db,
    `SELECT l.*, t.project_id, t.state FROM leases l JOIN tasks t ON t.id = l.task_id
     WHERE l.released_at IS NULL AND l.expires_at <= ? ${projectId ? 'AND t.project_id = ?' : ''}
     ORDER BY l.expires_at, l.task_id`,
    ...(projectId ? [at, projectId] : [at]),
  );
}

function toExpired(row: LeaseRow & { project_id: string; state: TaskState }): ExpiredLease {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    generation: row.generation,
    holder: { kind: row.holder_kind, id: row.holder_id },
    expiresAt: row.expires_at,
    taskState: row.state,
  };
}

export function findExpiredLeases(ctx: CrewContext, options: { projectId?: string } = {}): ExpiredLease[] {
  return expiredRows(ctx.store.db, nowIso(ctx.clock), options.projectId).map(toExpired);
}

function expireInTx(
  db: Database,
  row: LeaseRow & { project_id: string; state: TaskState },
  actor: Actor,
  at: string,
): void {
  exec(
    db,
    `UPDATE leases SET released_at = ?, release_reason = 'expired' WHERE id = ? AND released_at IS NULL`,
    at,
    row.id,
  );
  recordTransition(
    db,
    {
      type: 'lease.expired',
      actor,
      projectId: row.project_id,
      taskId: row.task_id,
      payload: {
        generation: row.generation,
        holder: { kind: row.holder_kind, id: row.holder_id },
        expiresAt: row.expires_at,
        taskState: row.state,
        needsReconciliation: true,
      },
    },
    { action: 'lease.expire', input: { taskId: row.task_id, generation: row.generation }, decision: 'accepted' },
    at,
  );
}

export function expireLeases(ctx: CrewContext, options: { projectId?: string; actor?: Actor } = {}): ExpiredLease[] {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const rows = expiredRows(db, at, options.projectId);
    for (const row of rows) expireInTx(db, row, options.actor ?? SYSTEM_ACTOR, at);
    return rows.map(toExpired);
  });
}

export interface ReconciliationCandidate {
  task: TaskView;
  lastLease: LeaseInfo;
}

export function listTasksNeedingReconciliation(
  ctx: CrewContext,
  options: { projectId?: string } = {},
): ReconciliationCandidate[] {
  const db = ctx.store.db;
  const rows = all<{ id: string }>(
    db,
    `SELECT id FROM tasks WHERE state IN ('CLAIMED', 'RUNNING', 'REVISION', 'CANCEL_REQUESTED')
     ${options.projectId ? 'AND project_id = ?' : ''} ORDER BY CAST(substr(id, 6) AS INTEGER)`,
    ...(options.projectId ? [options.projectId] : []),
  );
  const out: ReconciliationCandidate[] = [];
  for (const { id } of rows) {
    const task = requireTask(db, id);
    const last = latestLeaseRow(db, id);
    const active = activeLeaseRow(db, id);
    const lastLease = last ? mapLease(last) : null;
    if (lastLease && needsReconciliation(task, active ? mapLease(active) : null, lastLease)) {
      out.push({ task: toView(db, task), lastLease });
    }
  }
  return out;
}

export type ReconcileOutcome = 'released' | 'preserved' | 'cancelled' | 'deferred_process_alive' | 'noop';

export interface ReconcileResult {
  taskId: string;
  outcome: ReconcileOutcome;
  transition: TransitionResult | null;
}

export function reconcileExpiredLease(
  ctx: CrewContext,
  taskId: string,
  input: { processAlive: boolean; worktreeDirty: boolean; actor?: Actor; note?: string },
): ReconcileResult {
  const actor = input.actor ?? SYSTEM_ACTOR;
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    const active = activeLeaseRow(db, taskId);
    if (active) {
      if (Date.parse(active.expires_at) > Date.parse(at)) {
        throw new CrewError('LEASE_CONFLICT', `Task ${taskId} still holds a live lease`, {
          details: { generation: active.generation, expiresAt: active.expires_at },
          suggestion: 'Only expired leases can be reconciled; use forceReleaseLease for operator intervention.',
          retryable: false,
        });
      }
      expireInTx(db, { ...active, project_id: task.projectId, state: task.state }, actor, at);
    }
    const lastLease = latestLeaseRow(db, taskId);
    if (!needsReconciliation(task, null, lastLease ? mapLease(lastLease) : null)) {
      return { taskId, outcome: 'noop', transition: null };
    }
    if (input.processAlive) {
      recordTransition(
        db,
        {
          type: 'lease.reconcile_deferred',
          actor,
          projectId: task.projectId,
          taskId,
          payload: { reason: 'process_alive', generation: lastLease?.generation ?? null },
        },
        { action: 'lease.reconcile', input: { taskId, ...input, actor: undefined }, decision: 'deferred' },
        at,
      );
      return { taskId, outcome: 'deferred_process_alive', transition: null };
    }
    const note = input.note ? `: ${input.note}` : '';
    if (task.state === 'CANCEL_REQUESTED') {
      const transition = applyTransition(db, { taskId, to: 'CANCELLED', actor, reason: `lease expired${note}` }, at);
      return { taskId, outcome: 'cancelled', transition };
    }
    if (input.worktreeDirty) {
      const blockerReason = `Lease generation ${lastLease?.generation} expired with uncommitted work; workspace preserved for recovery${note}`;
      const transition = applyTransition(
        db,
        { taskId, to: 'BLOCKED', actor, reason: 'lease_expired_preserved', blockerReason },
        at,
      );
      requestInterventionInTx(
        db,
        { projectId: task.projectId, title: `Task ${taskId} blocked`, reasons: [blockerReason], taskId },
        actor,
        at,
      );
      return { taskId, outcome: 'preserved', transition };
    }
    const transition = applyTransition(
      db,
      { taskId, to: 'READY', actor, reason: `lease expired; released${note}` },
      at,
    );
    return { taskId, outcome: 'released', transition };
  });
}

export function forceReleaseLease(
  ctx: CrewContext,
  taskId: string,
  input: { reason: string; actor: Actor; to?: 'READY' | 'BLOCKED' },
): TransitionResult {
  if (input.actor.kind !== 'operator') {
    throw new CrewError('NOT_AUTHORIZED', 'Only an operator can force-release a lease', {
      details: { actorKind: input.actor.kind },
    });
  }
  if (input.reason.trim() === '') throw new CrewError('INVALID_INPUT', 'A reason is required to force-release a lease');
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    const active = activeLeaseRow(db, taskId);
    if (!LEASED_TASK_STATES.has(task.state) && task.state !== 'CANCEL_REQUESTED') {
      throw new CrewError('INVALID_TRANSITION', `Task ${taskId} is ${task.state}; nothing to force-release`, {
        details: { from: task.state, allowed: allowedNextStates(task.state) },
      });
    }
    const reason = `force: ${input.reason.trim()}`;
    if (active) {
      exec(db, 'UPDATE leases SET released_at = ?, release_reason = ? WHERE id = ?', at, reason, active.id);
      recordTransition(
        db,
        {
          type: 'lease.force_released',
          actor: input.actor,
          projectId: task.projectId,
          taskId,
          payload: {
            generation: active.generation,
            holder: { kind: active.holder_kind, id: active.holder_id },
            reason,
          },
        },
        { action: 'lease.force_release', input: { taskId, reason }, decision: 'forced' },
        at,
      );
    }
    const to = task.state === 'CANCEL_REQUESTED' ? 'CANCELLED' : (input.to ?? 'READY');
    return applyTransition(
      db,
      { taskId, to, actor: input.actor, reason, ...(to === 'BLOCKED' ? { blockerReason: reason } : {}) },
      at,
    );
  });
}
