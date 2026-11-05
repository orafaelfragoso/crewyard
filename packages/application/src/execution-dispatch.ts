import { closeUnsupervisedSession, getSession, listSessions } from '@crewyard/agents';
import { addSeconds, CrewError, LEASED_TASK_STATES, nowIso, withProcessLifecycle } from '@crewyard/core';
import { assertOutboxClaim, type ClaimedOutboxOperation, type CrewContext, recordTransition } from '@crewyard/storage';
import { activeLeaseRow, applyTransition, requireTask } from '@crewyard/tasks';
import { collectCommits, commitWorkspaceChanges, listWorkspaces } from '@crewyard/workspaces';
import type { Dispatch } from './agents.ts';
import type { ExecutionLaunch } from './execution.ts';
import { recordExecutionProcess } from './execution-processes.ts';

// Called only after the exact execution worker and all its recorded children have exited.
export async function recoverExecutionDispatch(
  ctx: CrewContext,
  op: ClaimedOutboxOperation,
  launch: ExecutionLaunch,
  reason: string,
): Promise<Record<string, unknown> | null> {
  if (launch.operation.kind !== 'dispatch') return null;
  const operation = launch.operation;
  const progress = op.remoteCorrelation?.progress as Pick<Dispatch, 'claim' | 'session'> | undefined;
  const row = ctx.store.db
    .query(
      "SELECT payload FROM events WHERE type = 'lease.execution_bound' AND correlation_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(launch.claim.attemptId, operation.taskId) as { payload: string } | null;
  const binding = row
    ? (JSON.parse(row.payload) as { leaseId: string; generation: number; holder: { kind: string; id: string } })
    : null;
  if (!progress && !binding) return null;
  if (binding && (binding.holder.kind !== 'agent' || binding.holder.id !== operation.agentId))
    throw new CrewError('CONFLICT', 'Execution task lease belongs to a different agent');
  const taskId = operation.taskId;
  const generation = binding?.generation ?? progress!.claim.leaseGeneration;
  const sessions = progress
    ? [getSession(ctx, progress.session.sessionId)]
    : listSessions(ctx, { taskId, limit: 1000 }).filter((session) => session.leaseGeneration === generation);
  if (
    sessions.some(
      (session) =>
        session.taskId !== taskId || session.leaseGeneration !== generation || session.agentId !== operation.agentId,
    ) ||
    (progress &&
      (progress.claim.taskId !== taskId ||
        progress.claim.leaseGeneration !== generation ||
        sessions[0]!.workspaceId !== progress.claim.workspaceId))
  )
    throw new CrewError('CONFLICT', 'Dispatch progress no longer matches its exact session and task lease');
  const lease = activeLeaseRow(ctx.store.db, taskId);
  const task = requireTask(ctx.store.db, taskId);
  const current =
    lease?.generation === generation &&
    task.leaseGeneration === generation &&
    (!binding || lease.id === binding.leaseId) &&
    lease.holder_kind === 'agent' &&
    lease.holder_id === operation.agentId;
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    assertOutboxClaim(db, op, at);
    for (const session of sessions) closeUnsupervisedSession(db, session.id, 'cancelled', reason, launch.actor, at);
  });
  if (!current || (!LEASED_TASK_STATES.has(task.state) && task.state !== 'CANCEL_REQUESTED'))
    return { ...progress, outcome: { kind: 'handed_off', taskState: task.state } };
  const workspaces = listWorkspaces(ctx, {
    taskId,
    states: ['allocating', 'ready', 'in_use', 'preserved', 'needs_reconciliation'],
  });
  if (workspaces.length > 1) throw new CrewError('CONFLICT', 'Dispatch recovery found multiple active task workspaces');
  const workspaceId = progress?.claim.workspaceId ?? workspaces[0]?.id ?? null;
  if (sessions.some((session) => session.workspaceId !== workspaceId))
    throw new CrewError('CONFLICT', 'Dispatch recovery session workspace does not match its task workspace');
  const claim = { taskId, leaseGeneration: generation, workspaceId };
  const assertOwner = () => {
    assertOutboxClaim(ctx.store.db, op, nowIso(ctx.clock));
    const active = activeLeaseRow(ctx.store.db, claim.taskId);
    const currentTask = requireTask(ctx.store.db, claim.taskId);
    if (
      active?.id !== lease.id ||
      active.generation !== claim.leaseGeneration ||
      currentTask.leaseGeneration !== claim.leaseGeneration
    )
      throw new CrewError('STALE_LEASE', 'Dispatch recovery no longer owns the original task lease');
  };
  ctx.store.immediate((db) => {
    assertOwner();
    db.query('UPDATE leases SET expires_at = ? WHERE id = ?').run(addSeconds(at, 40), lease.id);
    recordTransition(
      db,
      {
        type: 'execution.dispatch_recovery_started',
        actor: launch.actor,
        projectId: launch.projectId,
        taskId: claim.taskId,
        ...(sessions[0] ? { sessionId: sessions[0].id } : {}),
        payload: { operationId: op.operationId, generation: claim.leaseGeneration },
      },
      { action: 'execution.recover_dispatch', input: { operationId: op.operationId }, decision: 'preserving' },
      at,
    );
  });
  const recovery: CrewContext = {
    ...ctx,
    store: {
      ...ctx.store,
      immediate(fn) {
        return ctx.store.immediate((db) => {
          assertOwner();
          return fn(db);
        });
      },
      preview(fn) {
        return ctx.store.preview((db) => {
          assertOwner();
          return fn(db);
        });
      },
    },
  };
  const commits = await withProcessLifecycle(
    {
      signal: AbortSignal.timeout(30_000),
      onSpawn(pid) {
        recordExecutionProcess(launch.directory, pid);
        ctx.store.immediate(() => assertOwner());
      },
    },
    async () => {
      if (!claim.workspaceId) return [];
      await commitWorkspaceChanges(recovery, claim.workspaceId, {
        message: `${claim.taskId}: work in progress saved after execution ${launch.claim.attemptId} stopped`,
        actor: launch.actor,
      });
      return (await collectCommits(recovery, claim.workspaceId)).commits.map((commit) => commit.sha);
    },
  );
  recovery.store.immediate((db) => {
    const currentTask = requireTask(db, claim.taskId);
    applyTransition(
      db,
      {
        taskId: claim.taskId,
        to: currentTask.state === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'READY',
        actor: launch.actor,
        reason,
        payload: { operationId: op.operationId, ...(sessions[0] ? { sessionId: sessions[0].id } : {}), commits },
      },
      nowIso(ctx.clock),
    );
  });
  return { ...progress, outcome: { kind: 'interrupted', reason, commits } };
}
