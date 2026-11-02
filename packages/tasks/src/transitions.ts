import type { Database } from 'bun:sqlite';
import {
  type Actor,
  allowedNextStates,
  assertTransition,
  CrewError,
  LEASED_TASK_STATES,
  nowIso,
  type TaskState,
  TERMINAL_TASK_STATES,
} from '@crewyard/core';
import { all, type CrewContext, exec, recordTransition } from '@crewyard/storage';
import {
  type Handoff,
  requiresPullRequest,
  SATISFIED_DEPENDENCY_STATES,
  type Task,
  type TaskArtifacts,
  type TaskView,
} from './model.ts';
import { activeLeaseRow, dependencyStatuses, dependentIds, projectFlags, requireTask, toView } from './queries.ts';

const RESERVATION_RELEASE_STATES: ReadonlySet<TaskState> = new Set([
  'DRAFT',
  'READY',
  'MERGED',
  'DONE',
  'CANCELLED',
  'ESCALATED',
]);

const LEASE_ONLY_TARGETS: ReadonlySet<TaskState> = new Set(['CLAIMED', 'RUNNING']);

export interface TransitionInput {
  taskId: string;
  to: TaskState;
  actor: Actor;
  reason?: string;
  expectedRevision?: number;
  blockerReason?: string | null;
  handoff?: Handoff | null;
  artifacts?: TaskArtifacts;
  releaseReservations?: boolean;
  eventType?: string;
  payload?: Record<string, unknown>;
}

export interface TransitionResult {
  task: TaskView;
  from: TaskState;
  to: TaskState;
  eventSeq: number;
  releasedLeaseGeneration: number | null;
  releasedReservations: number;
  unblockedTaskIds: string[];
}

export function releaseReservationsInTx(
  db: Database,
  task: Pick<Task, 'id' | 'projectId'>,
  actor: Actor,
  reason: string,
  at: string,
): number {
  const rows = all<{ scope: string; mode: string }>(
    db,
    'SELECT scope, mode FROM task_scope_reservations WHERE task_id = ? AND released_at IS NULL ORDER BY scope',
    task.id,
  );
  if (rows.length === 0) return 0;
  exec(db, 'UPDATE task_scope_reservations SET released_at = ? WHERE task_id = ? AND released_at IS NULL', at, task.id);
  recordTransition(
    db,
    {
      type: 'reservation.released',
      actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { reason, scopes: rows },
    },
    { action: 'reservation.release', input: { taskId: task.id, reason }, decision: 'accepted' },
    at,
  );
  return rows.length;
}

export function releaseLeaseInTx(
  db: Database,
  task: Pick<Task, 'id' | 'projectId'>,
  actor: Actor,
  reason: string,
  at: string,
): number | null {
  const lease = activeLeaseRow(db, task.id);
  if (!lease) return null;
  exec(db, 'UPDATE leases SET released_at = ?, release_reason = ? WHERE id = ?', at, reason, lease.id);
  recordTransition(
    db,
    {
      type: 'lease.released',
      actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { generation: lease.generation, holder: { kind: lease.holder_kind, id: lease.holder_id }, reason },
    },
    { action: 'lease.release', input: { taskId: task.id, generation: lease.generation, reason }, decision: 'accepted' },
    at,
  );
  return lease.generation;
}

function assertDoneAllowed(task: Task): void {
  if (task.state === 'MERGED' || !requiresPullRequest(task)) return;
  throw new CrewError('INVALID_TRANSITION', `Task ${task.id} cannot be DONE before it is merged`, {
    details: { from: task.state, to: 'DONE', allowed: allowedNextStates(task.state).filter((s) => s !== 'DONE') },
    suggestion: 'Tasks that deliver code reach DONE only after their pull request is MERGED.',
  });
}

function releaseDependents(db: Database, task: Task, actor: Actor, at: string): string[] {
  const unblocked: string[] = [];
  for (const dependentId of dependentIds(db, task.id)) {
    const statuses = dependencyStatuses(db, dependentId);
    if (!statuses.every((s) => s.satisfied)) continue;
    unblocked.push(dependentId);
    recordTransition(
      db,
      {
        type: 'task.dependencies_satisfied',
        actor,
        projectId: task.projectId,
        taskId: dependentId,
        payload: { releasedBy: task.id, dependencies: statuses.map((s) => s.taskId) },
      },
      { action: 'task.release_dependents', input: { taskId: dependentId, releasedBy: task.id }, decision: 'accepted' },
      at,
    );
  }
  return unblocked;
}

function completeGoalIfFinished(db: Database, task: Task, actor: Actor, at: string): void {
  if (!task.goalId) return;
  const counts = all<{ state: TaskState; n: number }>(
    db,
    'SELECT state, COUNT(*) AS n FROM tasks WHERE goal_id = ? GROUP BY state',
    task.goalId,
  );
  const open = counts.filter((c) => !TERMINAL_TASK_STATES.has(c.state)).reduce((sum, c) => sum + c.n, 0);
  const done = counts.find((c) => c.state === 'DONE')?.n ?? 0;
  if (open > 0 || done === 0) return;
  const changed = exec(
    db,
    `UPDATE goals SET state = 'completed', revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'active'`,
    at,
    task.goalId,
  ).changes;
  if (changed === 0) return;
  recordTransition(
    db,
    { type: 'goal.completed', actor, projectId: task.projectId, payload: { goalId: task.goalId } },
    { action: 'goal.complete', input: { goalId: task.goalId }, decision: 'accepted' },
    at,
  );
}

export function applyTransition(db: Database, input: TransitionInput, at: string): TransitionResult {
  const task = requireTask(db, input.taskId);
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
    throw new CrewError(
      'CONFLICT',
      `Task ${task.id} changed (revision ${task.revision}, expected ${input.expectedRevision})`,
      {
        details: { currentRevision: task.revision, expectedRevision: input.expectedRevision },
        suggestion: 'Reload the task and retry with the current revision.',
        retryable: true,
      },
    );
  }
  assertTransition(task.state, input.to, task.id);
  if (input.to === 'DONE') assertDoneAllowed(task);

  const reason = input.reason ?? `transition:${input.to}`;
  const releasedLeaseGeneration =
    !LEASED_TASK_STATES.has(input.to) && input.to !== 'CANCEL_REQUESTED'
      ? releaseLeaseInTx(db, task, input.actor, reason, at)
      : null;
  const shouldReleaseReservations =
    RESERVATION_RELEASE_STATES.has(input.to) || (input.to === 'BLOCKED' && input.releaseReservations !== false);
  const releasedReservations = shouldReleaseReservations
    ? releaseReservationsInTx(db, task, input.actor, reason, at)
    : 0;

  const blockerReason =
    input.to === 'BLOCKED'
      ? (input.blockerReason ?? input.reason ?? task.blockerReason)
      : (input.blockerReason ?? null);
  exec(
    db,
    `UPDATE tasks SET state = ?, revision = revision + 1, blocker_reason = ?, handoff = ?, artifacts = ?,
       updated_at = ?, state_changed_at = ? WHERE id = ?`,
    input.to,
    blockerReason,
    JSON.stringify(input.handoff === undefined ? task.handoff : input.handoff),
    JSON.stringify(input.artifacts ?? task.artifacts),
    at,
    at,
    task.id,
  );
  const policyRevision = projectFlags(db, task.projectId).policyRevision;
  const event = recordTransition(
    db,
    {
      type: input.eventType ?? 'task.transitioned',
      actor: input.actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { from: task.state, to: input.to, reason, revision: task.revision + 1, ...input.payload },
    },
    {
      action: 'task.transition',
      input: { taskId: task.id, from: task.state, to: input.to, reason },
      decision: 'accepted',
      policyRevision,
      agentId: input.actor.kind === 'agent' ? input.actor.id : null,
    },
    at,
  );
  const updated = requireTask(db, task.id);
  const unblockedTaskIds =
    SATISFIED_DEPENDENCY_STATES.has(input.to) && !SATISFIED_DEPENDENCY_STATES.has(task.state)
      ? releaseDependents(db, updated, input.actor, at)
      : [];
  if (TERMINAL_TASK_STATES.has(input.to)) completeGoalIfFinished(db, updated, input.actor, at);
  return {
    task: toView(db, updated),
    from: task.state,
    to: input.to,
    eventSeq: event.seq,
    releasedLeaseGeneration,
    releasedReservations,
    unblockedTaskIds,
  };
}

export function transitionTask(ctx: CrewContext, input: TransitionInput): TransitionResult {
  if (LEASE_ONLY_TARGETS.has(input.to)) {
    throw new CrewError('INVALID_TRANSITION', `Transition to ${input.to} requires a lease`, {
      details: { to: input.to },
      suggestion: input.to === 'CLAIMED' ? 'Use claimTask.' : 'Use startTask with the current lease token.',
    });
  }
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    if (input.actor.kind === 'github') {
      const lease = activeLeaseRow(db, input.taskId);
      if (lease) {
        throw new CrewError('POLICY_DENIED', 'GitHub observations cannot change ownership of a leased task', {
          details: { taskId: input.taskId, generation: lease.generation },
          suggestion: 'Record the observed PR status; the lease holder or operator decides the task transition.',
        });
      }
    }
    return applyTransition(db, input, at);
  });
}
