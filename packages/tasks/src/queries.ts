import type { Database } from 'bun:sqlite';
import { CrewError, type TaskState } from '@crewyard/core';
import { all, one } from '@crewyard/storage';
import {
  type ApprovalRow,
  compareTaskIds,
  type LeaseRow,
  mapTask,
  type ReservationRow,
  SATISFIED_DEPENDENCY_STATES,
  type Task,
  type TaskRow,
  type TaskView,
} from './model.ts';

export function findTask(db: Database, taskId: string): Task | null {
  const row = one<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId);
  return row ? mapTask(row) : null;
}

export function requireTask(db: Database, taskId: string): Task {
  const task = findTask(db, taskId);
  if (!task) {
    throw new CrewError('NOT_FOUND', `Task not found: ${taskId}`, { suggestion: 'Run `crew task list`.' });
  }
  return task;
}

export interface DependencyStatus {
  taskId: string;
  state: TaskState;
  satisfied: boolean;
}

export function dependencyStatuses(db: Database, taskId: string): DependencyStatus[] {
  return all<{ id: string; state: TaskState }>(
    db,
    'SELECT t.id, t.state FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?',
    taskId,
  )
    .map((r) => ({ taskId: r.id, state: r.state, satisfied: SATISFIED_DEPENDENCY_STATES.has(r.state) }))
    .sort((a, b) => compareTaskIds(a.taskId, b.taskId));
}

export function dependentIds(db: Database, taskId: string): string[] {
  return all<{ task_id: string }>(db, 'SELECT task_id FROM task_dependencies WHERE depends_on_id = ?', taskId)
    .map((r) => r.task_id)
    .sort(compareTaskIds);
}

export function toViews(db: Database, tasks: readonly Task[]): TaskView[] {
  if (tasks.length === 0) return [];
  const deps = new Map<string, DependencyStatus[]>();
  const ids = tasks.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all<{ task_id: string; depends_on_id: string; state: TaskState }>(
      db,
      `SELECT d.task_id, d.depends_on_id, t.state FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    );
    for (const row of rows) {
      const list = deps.get(row.task_id) ?? [];
      list.push({
        taskId: row.depends_on_id,
        state: row.state,
        satisfied: SATISFIED_DEPENDENCY_STATES.has(row.state),
      });
      deps.set(row.task_id, list);
    }
  }
  return tasks.map((task) => {
    const statuses = (deps.get(task.id) ?? []).sort((a, b) => compareTaskIds(a.taskId, b.taskId));
    return {
      ...task,
      dependencies: statuses.map((d) => d.taskId),
      blockedByDependencies: statuses.filter((d) => !d.satisfied).map((d) => d.taskId),
    };
  });
}

export function toView(db: Database, task: Task): TaskView {
  return toViews(db, [task])[0]!;
}

export function activeLeaseRow(db: Database, taskId: string): LeaseRow | null {
  return one<LeaseRow>(db, 'SELECT * FROM leases WHERE task_id = ? AND released_at IS NULL', taskId);
}

export function latestLeaseRow(db: Database, taskId: string): LeaseRow | null {
  return one<LeaseRow>(db, 'SELECT * FROM leases WHERE task_id = ? ORDER BY generation DESC LIMIT 1', taskId);
}

export function activeReservationRows(db: Database, taskId: string): ReservationRow[] {
  return all<ReservationRow>(
    db,
    'SELECT * FROM task_scope_reservations WHERE task_id = ? AND released_at IS NULL ORDER BY scope',
    taskId,
  );
}

export function latestApprovalRow(
  db: Database,
  kind: ApprovalRow['subject_kind'],
  subjectId: string,
): ApprovalRow | null {
  return one<ApprovalRow>(
    db,
    `SELECT * FROM approvals WHERE subject_kind = ? AND subject_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1`,
    kind,
    subjectId,
  );
}

export function taskApprovalSatisfied(db: Database, task: Task): { satisfied: boolean; approval: ApprovalRow | null } {
  if (!task.requiresApproval) return { satisfied: true, approval: null };
  const approval = latestApprovalRow(db, 'task', task.id);
  const approved = task.artifacts.approval?.approvedClasses ?? [];
  const required = task.artifacts.approval?.requiredClasses ?? [];
  const covered = required.every((c) => approved.includes(c));
  return { satisfied: approval?.status === 'approved' && covered, approval };
}

export function projectFlags(
  db: Database,
  projectId: string,
): { intakePaused: boolean; workersPaused: boolean; autonomy: string; policyRevision: number } {
  const row = one<{ intake_paused: number; workers_paused: number; autonomy: string; policy_revision: number }>(
    db,
    'SELECT intake_paused, workers_paused, autonomy, policy_revision FROM projects WHERE id = ?',
    projectId,
  );
  if (!row) throw new CrewError('NOT_FOUND', `Project not found: ${projectId}`);
  return {
    intakePaused: row.intake_paused === 1,
    workersPaused: row.workers_paused === 1,
    autonomy: row.autonomy,
    policyRevision: row.policy_revision,
  };
}
