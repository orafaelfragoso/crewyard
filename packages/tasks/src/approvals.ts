import type { Database } from 'bun:sqlite';
import type { RailConfig } from '@agent-rail/config';
import { type Actor, newId, nowIso, RailError } from '@agent-rail/core';
import { all, exec, one, type RailContext, recordTransition } from '@agent-rail/storage';
import { resolveTaskConfig } from './config.ts';
import {
  type Approval,
  type ApprovalClass,
  type ApprovalRow,
  type ApprovalStatus,
  type ApprovalSubjectKind,
  mapApproval,
  type Task,
  type TaskApprovalState,
} from './model.ts';
import { requireTask } from './queries.ts';
import { classifyRisk, type RiskClassification } from './risk.ts';

export interface ApprovalRequestInput {
  projectId: string;
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  reason: string;
  requestedBy: Actor;
}

export function requestApprovalInTx(db: Database, input: ApprovalRequestInput, at: string): Approval {
  const pending = one<ApprovalRow>(
    db,
    `SELECT * FROM approvals WHERE subject_kind = ? AND subject_id = ? AND status = 'pending'`,
    input.subjectKind,
    input.subjectId,
  );
  if (pending) {
    if (pending.reason !== input.reason)
      exec(db, 'UPDATE approvals SET reason = ? WHERE id = ?', input.reason, pending.id);
    return mapApproval({ ...pending, reason: input.reason });
  }
  const id = newId('apr');
  exec(
    db,
    `INSERT INTO approvals (id, project_id, subject_kind, subject_id, reason, status, requested_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    input.projectId,
    input.subjectKind,
    input.subjectId,
    input.reason,
    `${input.requestedBy.kind}:${input.requestedBy.id}`,
    at,
  );
  recordTransition(
    db,
    {
      type: 'approval.requested',
      actor: input.requestedBy,
      projectId: input.projectId,
      taskId: input.subjectKind === 'task' ? input.subjectId : null,
      payload: { approvalId: id, subjectKind: input.subjectKind, subjectId: input.subjectId, reason: input.reason },
    },
    {
      action: 'approval.request',
      input: { subjectKind: input.subjectKind, subjectId: input.subjectId },
      decision: 'pending',
    },
    at,
  );
  return mapApproval(one<ApprovalRow>(db, 'SELECT * FROM approvals WHERE id = ?', id)!);
}

export function decideApprovalInTx(
  db: Database,
  approvalId: string,
  decision: Exclude<ApprovalStatus, 'pending'>,
  actor: Actor,
  at: string,
  note?: string,
): Approval {
  if (actor.kind !== 'operator' && actor.kind !== 'system') {
    throw new RailError('NOT_AUTHORIZED', 'Only an operator (or an autonomy policy) can decide approvals', {
      details: { actorKind: actor.kind },
    });
  }
  const row = one<ApprovalRow>(db, 'SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!row) throw new RailError('NOT_FOUND', `Approval not found: ${approvalId}`);
  if (row.status !== 'pending') {
    throw new RailError('CONFLICT', `Approval ${approvalId} is already ${row.status}`, {
      details: { status: row.status },
    });
  }
  exec(
    db,
    'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    decision,
    `${actor.kind}:${actor.id}`,
    at,
    approvalId,
  );
  recordTransition(
    db,
    {
      type: `approval.${decision}`,
      actor,
      projectId: row.project_id,
      taskId: row.subject_kind === 'task' ? row.subject_id : null,
      payload: { approvalId, subjectKind: row.subject_kind, subjectId: row.subject_id, note: note ?? null },
    },
    { action: 'approval.decide', input: { approvalId, decision }, decision },
    at,
  );
  if (row.subject_kind === 'task' && decision === 'approved') {
    const task = requireTask(db, row.subject_id);
    const state = task.artifacts.approval;
    if (state) {
      const artifacts = { ...task.artifacts, approval: { ...state, approvedClasses: [...state.requiredClasses] } };
      exec(
        db,
        'UPDATE tasks SET artifacts = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        JSON.stringify(artifacts),
        at,
        task.id,
      );
    }
  }
  return mapApproval(one<ApprovalRow>(db, 'SELECT * FROM approvals WHERE id = ?', approvalId)!);
}

export function listApprovals(
  ctx: RailContext,
  filter: { projectId?: string; status?: ApprovalStatus; subjectKind?: ApprovalSubjectKind; subjectId?: string } = {},
): Approval[] {
  const where: string[] = [];
  const params: string[] = [];
  for (const [column, value] of [
    ['project_id', filter.projectId],
    ['status', filter.status],
    ['subject_kind', filter.subjectKind],
    ['subject_id', filter.subjectId],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  return all<ApprovalRow>(
    ctx.store.db,
    `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`,
    ...params,
  ).map(mapApproval);
}

function approvalReason(classes: readonly ApprovalClass[]): string {
  return `Task requires approval: ${classes.join(', ')}`;
}

export interface RiskApplication {
  classification: RiskClassification;
  requiresApproval: boolean;
  approvalPending: boolean;
  approval: Approval | null;
}

export function applyRiskInTx(
  db: Database,
  task: Task,
  classification: RiskClassification,
  actor: Actor,
  at: string,
): RiskApplication {
  const approvedClasses = task.artifacts.approval?.approvedClasses ?? [];
  const state: TaskApprovalState = {
    requiredClasses: classification.requiredClasses,
    approvedClasses,
    matches: classification.matches,
  };
  const requiresApproval = classification.requiredClasses.length > 0;
  const missing = classification.requiredClasses.filter((c) => !approvedClasses.includes(c));
  exec(
    db,
    'UPDATE tasks SET requires_approval = ?, artifacts = ?, updated_at = ? WHERE id = ?',
    requiresApproval ? 1 : 0,
    JSON.stringify({ ...task.artifacts, approval: state }),
    at,
    task.id,
  );
  let approval: Approval | null = null;
  if (missing.length > 0) {
    approval = requestApprovalInTx(
      db,
      {
        projectId: task.projectId,
        subjectKind: 'task',
        subjectId: task.id,
        reason: approvalReason(classification.requiredClasses),
        requestedBy: actor,
      },
      at,
    );
  }
  return { classification, requiresApproval, approvalPending: missing.length > 0, approval };
}

export function applyRiskClassification(
  ctx: RailContext,
  taskId: string,
  options: { actor: Actor; changedPaths?: string[]; config?: RailConfig },
): RiskApplication {
  const projectId = requireTask(ctx.store.db, taskId).projectId;
  const config = resolveTaskConfig(ctx, projectId, options.config);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    const previous = task.artifacts.approval?.matches.map((m) => m.path).filter((p) => p !== '*') ?? [];
    const classification = classifyRisk(
      {
        risk: task.risk,
        scopeHints: task.scopeHints,
        exclusiveResources: task.exclusiveResources,
        changedPaths: [...new Set([...previous, ...(options.changedPaths ?? [])])],
      },
      config,
    );
    return applyRiskInTx(db, task, classification, options.actor, at);
  });
}

export function decideTaskApproval(
  ctx: RailContext,
  taskId: string,
  decision: Exclude<ApprovalStatus, 'pending'>,
  actor: Actor,
  note?: string,
): Approval {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const pending = one<ApprovalRow>(
      db,
      `SELECT * FROM approvals WHERE subject_kind = 'task' AND subject_id = ? AND status = 'pending'`,
      taskId,
    );
    if (!pending) throw new RailError('NOT_FOUND', `Task ${taskId} has no pending approval`);
    return decideApprovalInTx(db, pending.id, decision, actor, at, note);
  });
}
