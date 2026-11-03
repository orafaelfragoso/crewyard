import type { Database } from 'bun:sqlite';
import { type Actor, newId, nowIso } from '@crewyard/core';
import { type CrewContext, one, recordTransition } from '@crewyard/storage';

export type ApprovalSubject = 'goal_plan' | 'task' | 'pr_publish' | 'merge' | 'repo_hooks' | 'cleanup';
export type NotificationLevel = 'info' | 'warning' | 'error' | 'action_required';

export interface InterventionInput {
  projectId: string;
  title: string;
  reasons: string[];
  level?: NotificationLevel;
  prId?: string | null;
  taskId?: string | null;
  approval?: { subjectKind: ApprovalSubject; subjectId: string } | null;
  once?: boolean;
}

export interface InterventionRecord {
  notificationId: string;
  approvalId: string | null;
  created: boolean;
}

export function requestInterventionInTx(
  db: Database,
  input: InterventionInput,
  actor: Actor,
  at: string,
): InterventionRecord {
  const body = input.reasons.map((r) => `- ${r}`).join('\n');
  if (input.once) {
    const sent = one<{ id: string }>(
      db,
      'SELECT id FROM notifications WHERE project_id = ? AND pr_id IS ? AND title = ? AND body = ? ORDER BY created_at DESC LIMIT 1',
      input.projectId,
      input.prId ?? null,
      input.title,
      body,
    );
    if (sent) return { notificationId: sent.id, approvalId: null, created: false };
  }
  let approvalId: string | null = null;
  let created = true;
  if (input.approval) {
    const existing = one<{ id: string; status: string }>(
      db,
      `SELECT id, status FROM approvals WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 1`,
      input.approval.subjectKind,
      input.approval.subjectId,
    );
    if (existing && existing.status !== 'rejected') {
      approvalId = existing.id;
      created = false;
    } else {
      approvalId = newId('apr');
      db.query(
        `INSERT INTO approvals (id, project_id, subject_kind, subject_id, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        approvalId,
        input.projectId,
        input.approval.subjectKind,
        input.approval.subjectId,
        input.reasons.join('; '),
        `${actor.kind}:${actor.id}`,
        at,
      );
    }
  }
  if (!created) {
    const notification = one<{ id: string }>(
      db,
      'SELECT id FROM notifications WHERE project_id = ? AND title = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1',
      input.projectId,
      input.title,
    );
    if (notification) return { notificationId: notification.id, approvalId, created };
  }
  const notificationId = newId('ntf');
  db.query(
    `INSERT INTO notifications (id, project_id, level, title, body, task_id, pr_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    notificationId,
    input.projectId,
    input.level ?? 'action_required',
    input.title,
    body,
    input.taskId ?? null,
    input.prId ?? null,
    at,
  );
  recordTransition(
    db,
    {
      type: input.approval ? 'approval.requested' : 'intervention.escalated',
      actor,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      prId: input.prId ?? null,
      payload: { title: input.title, reasons: input.reasons, approvalId, notificationId },
    },
    { action: 'intervention.request', input: { title: input.title, reasons: input.reasons }, decision: 'requested' },
    at,
  );
  return { notificationId, approvalId, created };
}

export function requestIntervention(ctx: CrewContext, input: InterventionInput, actor: Actor): InterventionRecord {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => requestInterventionInTx(db, input, actor, at));
}
