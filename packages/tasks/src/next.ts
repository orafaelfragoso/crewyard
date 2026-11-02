import type { CrewConfig } from '@crewyard/config';
import { addSeconds, isCrewError, nowIso, type TaskState } from '@crewyard/core';
import { all, type CrewContext } from '@crewyard/storage';
import { resolveTaskConfig } from './config.ts';
import { type LeaseCredentials, verifyLeaseInTx } from './leases.ts';
import { compareTaskIds, type LeaseRow, mapTask, type TaskRow, type TaskView } from './model.ts';
import { activeLeaseRow, dependencyStatuses, projectFlags, taskApprovalSatisfied, toView } from './queries.ts';
import { findScopeConflicts, requestedScopes, type ScopeHolding } from './scopes.ts';

export interface NextTaskOptions {
  projectId?: string;
  config?: CrewConfig;
}

export interface NextTaskSuggestion {
  task: TaskView;
  workClass: 'recovery' | 'implementation';
  reason: string;
}

function compareCandidates(a: TaskView, b: TaskView): number {
  const recovery = Number(b.state === 'REVISION') - Number(a.state === 'REVISION');
  if (recovery !== 0) return recovery;
  if (a.effectivePriority !== b.effectivePriority) return b.effectivePriority - a.effectivePriority;
  const da = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
  const db = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return compareTaskIds(a.id, b.id);
}

export function nextTask(ctx: CrewContext, agentId: string, options: NextTaskOptions = {}): NextTaskSuggestion | null {
  const db = ctx.store.db;
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE state IN ('READY', 'REVISION') AND paused = 0
       AND (assigned_agent_id IS NULL OR assigned_agent_id = ?) ${options.projectId ? 'AND project_id = ?' : ''}`,
    ...(options.projectId ? [agentId, options.projectId] : [agentId]),
  );
  const configs = new Map<string, CrewConfig | null>();
  const holdings = new Map<string, ScopeHolding[]>();
  const candidates: TaskView[] = [];
  for (const row of rows) {
    const task = mapTask(row);
    if (task.state === 'REVISION' && task.assignedAgentId !== agentId && task.assignedAgentId !== null) continue;
    if (activeLeaseRow(db, task.id)) continue;
    const flags = projectFlags(db, task.projectId);
    if (flags.intakePaused || flags.autonomy === 'observe') continue;
    if (dependencyStatuses(db, task.id).some((d) => !d.satisfied)) continue;
    if (!taskApprovalSatisfied(db, task).satisfied) continue;
    if (!configs.has(task.projectId)) {
      try {
        configs.set(task.projectId, resolveTaskConfig(ctx, task.projectId, options.config));
      } catch (error) {
        if (!isCrewError(error)) throw error;
        configs.set(task.projectId, null);
      }
    }
    const config = configs.get(task.projectId);
    if (!config) continue;
    if (!holdings.has(task.projectId)) {
      holdings.set(
        task.projectId,
        all<{ task_id: string; scope: string; mode: 'advisory' | 'exclusive' }>(
          db,
          'SELECT task_id, scope, mode FROM task_scope_reservations WHERE project_id = ? AND released_at IS NULL',
          task.projectId,
        ).map((r) => ({ taskId: r.task_id, scope: r.scope, mode: r.mode })),
      );
    }
    const conflicts = findScopeConflicts(requestedScopes(task, config), holdings.get(task.projectId)!, task.id);
    if (conflicts.exclusive.length > 0) continue;
    candidates.push(toView(db, task));
  }
  candidates.sort(compareCandidates);
  const best = candidates[0];
  if (!best) return null;
  return {
    task: best,
    workClass: best.state === 'REVISION' ? 'recovery' : 'implementation',
    reason:
      best.state === 'REVISION'
        ? 'Revision work takes precedence over new implementation'
        : `Highest effective priority (${best.effectivePriority}) among dispatchable tasks`,
  };
}

export type NextAction =
  | { action: 'claim'; taskId: string; workClass: 'recovery' | 'implementation'; reason: string }
  | { action: 'start'; taskId: string; generation: number; state: TaskState }
  | { action: 'continue'; taskId: string; generation: number; heartbeatDueAt: string; expiresAt: string }
  | { action: 'resume'; taskId: string; generation: number; expiresAt: string; reason: string }
  | { action: 'stop'; taskId: string; reason: 'cancel_requested' | 'stale_lease' | 'not_authorized'; detail: string }
  | { action: 'wait'; reason: 'no_dispatchable_tasks'; retryAfterSeconds: number };

export function getNextAction(
  ctx: CrewContext,
  input: { agentId: string; lease?: LeaseCredentials; projectId?: string; config?: CrewConfig },
): NextAction {
  const db = ctx.store.db;
  const at = nowIso(ctx.clock);
  if (input.lease) {
    try {
      const { task, lease } = verifyLeaseInTx(db, input.lease, at);
      if (task.state === 'CANCEL_REQUESTED') {
        return {
          action: 'stop',
          taskId: task.id,
          reason: 'cancel_requested',
          detail: 'The operator requested cancellation',
        };
      }
      if (task.state === 'CLAIMED' || task.state === 'REVISION') {
        return { action: 'start', taskId: task.id, generation: lease.generation, state: task.state };
      }
      const interval = resolveTaskConfig(ctx, task.projectId, input.config).agents.heartbeat_interval_seconds;
      return {
        action: 'continue',
        taskId: task.id,
        generation: lease.generation,
        heartbeatDueAt: addSeconds(lease.heartbeat_at, interval),
        expiresAt: lease.expires_at,
      };
    } catch (error) {
      if (!isCrewError(error)) throw error;
      if (error.code === 'STALE_LEASE') {
        return { action: 'stop', taskId: input.lease.taskId, reason: 'stale_lease', detail: error.message };
      }
      if (error.code === 'NOT_AUTHORIZED') {
        return { action: 'stop', taskId: input.lease.taskId, reason: 'not_authorized', detail: error.message };
      }
      throw error;
    }
  }
  const held = all<LeaseRow>(
    db,
    `SELECT l.* FROM leases l JOIN tasks t ON t.id = l.task_id
     WHERE l.released_at IS NULL AND l.holder_kind = 'agent' AND l.holder_id = ? AND l.expires_at > ?
     ${input.projectId ? 'AND t.project_id = ?' : ''} ORDER BY l.acquired_at`,
    ...(input.projectId ? [input.agentId, at, input.projectId] : [input.agentId, at]),
  );
  const current = held[0];
  if (current) {
    return {
      action: 'resume',
      taskId: current.task_id,
      generation: current.generation,
      expiresAt: current.expires_at,
      reason: 'You already hold this lease; continue with the token issued at claim time',
    };
  }
  const suggestion = nextTask(ctx, input.agentId, {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.config ? { config: input.config } : {}),
  });
  if (suggestion) {
    return { action: 'claim', taskId: suggestion.task.id, workClass: suggestion.workClass, reason: suggestion.reason };
  }
  return { action: 'wait', reason: 'no_dispatchable_tasks', retryAfterSeconds: 60 };
}
