import { listSessions, reapOrphans } from '@crewyard/agents';
import { type Actor, isProcessAlive, nowIso, SYSTEM_ACTOR, toCrewError } from '@crewyard/core';
import { failOrphanedReviews } from '@crewyard/reviews';
import { appendEvent, type CrewContext, listOutbox, listWorkers, migrationStatus } from '@crewyard/storage';
import {
  expireLeases,
  listTasksNeedingReconciliation,
  type ReconcileResult,
  reconcileExpiredLease,
} from '@crewyard/tasks';
import { inspectWorkspace, listWorkspaces, markWorkspacesForReconciliation } from '@crewyard/workspaces';

export interface RemoteRecovery {
  name: string;
  run(ctx: CrewContext): Promise<Record<string, unknown>>;
}

export interface RecoveryStep {
  step: string;
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

export interface RecoveryReport {
  startedAt: string;
  finishedAt: string;
  steps: RecoveryStep[];
  ok: boolean;
}

export interface RecoveryOptions {
  projectId?: string;
  actor?: Actor;
  killLiveOrphans?: boolean;
  remote?: readonly RemoteRecovery[];
}

async function step(
  steps: RecoveryStep[],
  name: string,
  fn: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<void> {
  try {
    steps.push({ step: name, ok: true, detail: await fn() });
  } catch (error) {
    steps.push({ step: name, ok: false, detail: {}, error: toCrewError(error).message });
  }
}

async function workspaceDirty(ctx: CrewContext, taskId: string): Promise<boolean> {
  for (const ws of listWorkspaces(ctx, { taskId })) {
    if (ws.state === 'cleaned') continue;
    try {
      const inspection = await inspectWorkspace(ctx, ws.id);
      if (inspection.dirtyFiles.length > 0 || inspection.commitsSinceBase > 0 || inspection.unpushedCommits.length > 0)
        return true;
    } catch {
      return true;
    }
  }
  return false;
}

function taskProcessAlive(ctx: CrewContext, taskId: string): boolean {
  return listSessions(ctx, { taskId }).some(
    (s) => ['starting', 'running', 'stopping'].includes(s.state) && s.pid !== null && isProcessAlive(s.pid),
  );
}

function otherServiceAlive(ctx: CrewContext): boolean {
  return listWorkers(ctx.store, 'service').some(
    (w) => w.status === 'running' && w.pid !== process.pid && isProcessAlive(w.pid),
  );
}

export async function reconcileLeases(
  ctx: CrewContext,
  options: { projectId?: string; actor?: Actor } = {},
): Promise<ReconcileResult[]> {
  const actor = options.actor ?? SYSTEM_ACTOR;
  expireLeases(ctx, { ...(options.projectId ? { projectId: options.projectId } : {}), actor });
  const results: ReconcileResult[] = [];
  for (const candidate of listTasksNeedingReconciliation(
    ctx,
    options.projectId ? { projectId: options.projectId } : {},
  )) {
    const taskId = candidate.task.id;
    const processAlive = taskProcessAlive(ctx, taskId);
    const worktreeDirty = await workspaceDirty(ctx, taskId);
    if (worktreeDirty) {
      markWorkspacesForReconciliation(ctx, { taskId, actor, reason: 'lease expired with local changes present' });
    }
    results.push(reconcileExpiredLease(ctx, taskId, { processAlive, worktreeDirty, actor }));
  }
  return results;
}

export async function runRecovery(ctx: CrewContext, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const actor = options.actor ?? SYSTEM_ACTOR;
  const startedAt = nowIso(ctx.clock);
  const steps: RecoveryStep[] = [];

  await step(steps, 'verify-database', () => {
    const status = migrationStatus(ctx.store);
    return { schemaVersion: status.currentVersion, pending: status.pending.length };
  });
  await step(steps, 'incomplete-side-effects', () => {
    const open = listOutbox(ctx.store, { statuses: ['attempted', 'ambiguous'], limit: 1000 });
    return { count: open.length, kinds: [...new Set(open.map((o) => o.kind))] };
  });
  await step(steps, 'reconcile-processes', async () => {
    const result = await reapOrphans(ctx, { actor, killLiveOrphans: options.killLiveOrphans ?? false });
    return { ...result };
  });
  await step(steps, 'reconcile-leases', async () => {
    const results = await reconcileLeases(ctx, {
      ...(options.projectId ? { projectId: options.projectId } : {}),
      actor,
    });
    return { reconciled: results.map((r) => ({ taskId: r.taskId, outcome: r.outcome })) };
  });
  await step(steps, 'reconcile-reviews', () =>
    otherServiceAlive(ctx) ? { skipped: 'service_running' } : { failed: failOrphanedReviews(ctx, actor) },
  );
  await step(steps, 'inspect-workspaces', async () => {
    const flagged: string[] = [];
    for (const ws of listWorkspaces(ctx, { states: ['needs_reconciliation'] })) flagged.push(ws.id);
    return { needsReconciliation: flagged };
  });
  for (const remote of options.remote ?? []) {
    await step(steps, remote.name, () => remote.run(ctx));
  }
  const report: RecoveryReport = { startedAt, finishedAt: nowIso(ctx.clock), steps, ok: steps.every((s) => s.ok) };
  ctx.store.immediate((db) =>
    appendEvent(db, {
      type: 'recovery.completed',
      actor,
      projectId: options.projectId ?? null,
      payload: { ok: report.ok, steps: steps.map((s) => ({ step: s.step, ok: s.ok, error: s.error ?? null })) },
    }),
  );
  return report;
}
