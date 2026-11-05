import { hostname } from 'node:os';
import { reapOrphans } from '@crewyard/agents';
import {
  CrewError,
  ensureDir,
  nowIso,
  processIdentity,
  redact,
  redactObject,
  toCrewError,
  withProcessLifecycle,
} from '@crewyard/core';
import { processIntegrationOutbox, syncRepository } from '@crewyard/integration';
import { loadProjectConfig, primaryRepository } from '@crewyard/projects';
import { reconcileLeases } from '@crewyard/recovery';
import { failOrphanedReviews, requestInterventionInTx } from '@crewyard/reviews';
import {
  assertExecutionClaim,
  assertOutboxClaim,
  bindExecutionProcess,
  type ClaimedOutboxOperation,
  type CrewContext,
  completeOutbox,
  executionContext,
  getExecutionClaim,
  getOutbox,
  recordTransition,
  releaseExecutionClaim,
  renewExecutionClaim,
} from '@crewyard/storage';
import { type OperationKind, recordOperation } from '@crewyard/telemetry';
import { type Dispatch, dispatchTask } from './agents.ts';
import { guardDiskSpace } from './disk-guard.ts';
import { EXECUTION_LAUNCH_KIND, type ExecutionLaunch } from './execution.ts';
import { recordExecutionProcess, stopExecutionProcesses } from './execution-processes.ts';
import { finishExecutionResources } from './execution-worktrees.ts';
import { integrationEnv, reviewPullRequest, runIntegrationTick } from './integration.ts';
import { cleanFinishedWorkspaces } from './maintenance.ts';
import { scanPostMergeHealth } from './post-merge.ts';
import { blockDivergedPublication, publishTask, tasksAwaitingPublication } from './publish.ts';
import { buildIndex } from './retrieval.ts';
import { resumeSessionRetries } from './session-retries.ts';
import { allocateTaskWorkspace } from './work.ts';

async function execute(
  ctx: CrewContext,
  launch: ExecutionLaunch,
  onDispatch: (dispatch: Dispatch) => void,
): Promise<Record<string, unknown>> {
  const { projectId, repositoryId, actor, leaderId, operation } = launch;
  const env = integrationEnv(ctx);
  switch (operation.kind) {
    case 'index':
      return (await buildIndex(ctx, { ...operation, projectId, actor })) as unknown as Record<string, unknown>;
    case 'sync':
      return (await syncRepository(ctx, repositoryId, env)) as unknown as Record<string, unknown>;
    case 'outbox':
      return (await processIntegrationOutbox(ctx, { leaderId, env })) as unknown as Record<string, unknown>;
    case 'queue':
      return (await runIntegrationTick(
        ctx,
        {
          repositoryId,
          leaderId,
          actor,
          sync: operation.sync,
          maxCandidates: operation.maxCandidates,
          processOutbox: operation.processOutbox,
          expected: operation,
        },
        env,
      )) as unknown as Record<string, unknown>;
    case 'review':
      return (await reviewPullRequest(
        ctx,
        {
          prId: operation.prId,
          expectedHeadSha: operation.expectedHeadSha,
          expectedBaseSha: operation.expectedBaseSha,
          configurationFingerprint: operation.configurationFingerprint,
          types: operation.types,
          force: operation.force,
        },
        env,
      )) as unknown as Record<string, unknown>;
    case 'workspace':
      return (await allocateTaskWorkspace(ctx, {
        taskId: operation.taskId,
        actor,
        baseRef: operation.baseRef,
        baseSha: operation.baseSha,
        expectedLease: operation.lease,
        configurationFingerprint: operation.configurationFingerprint,
      })) as unknown as Record<string, unknown>;
    case 'health':
      return { health: await scanPostMergeHealth(ctx, { repositoryId, actor, limit: 20 }, env) };
    case 'publish': {
      const published: Record<string, unknown>[] = [];
      for (const taskId of tasksAwaitingPublication(ctx, projectId)) {
        try {
          const result = await publishTask(ctx, { taskId, actor, leaderId, env });
          published.push({ taskId, prId: result.pullRequest?.id ?? null, queued: result.queued });
        } catch (error) {
          if (error instanceof CrewError && error.code === 'HEAD_MISMATCH')
            blockDivergedPublication(ctx, taskId, error, actor);
          throw error;
        }
      }
      return { published };
    }
    case 'cleanup': {
      await reapOrphans(ctx, { actor });
      const reconciled = await reconcileLeases(ctx, { projectId, actor });
      const resumed = resumeSessionRetries(ctx, projectId, actor);
      const failedReviews = failOrphanedReviews(ctx, actor);
      const removed = await cleanFinishedWorkspaces(ctx, { repositoryId, actor });
      const disk = await guardDiskSpace(ctx, {
        projectId,
        config: loadProjectConfig(ctx, projectId).config,
        actor,
        alert: true,
        prune: 'always',
      });
      return { reconciled, resumed, failedReviews, removed: removed.map((r) => r.workspace.id), disk };
    }
    case 'dispatch': {
      const dispatch = await dispatchTask(ctx, {
        taskId: operation.taskId,
        agent: operation.agentId,
        actor,
        model: operation.model,
        expected: operation,
      });
      onDispatch(dispatch);
      if (dispatch.session.pid) ctx.execution!.onSpawn(dispatch.session.pid);
      ctx.store.immediate((db) =>
        recordTransition(
          db,
          {
            type: 'service.dispatched',
            actor,
            projectId,
            taskId: operation.taskId,
            payload: { agentId: operation.agentId, sessionId: dispatch.session.sessionId },
          },
          { action: 'service.dispatch', input: operation, decision: 'running' },
          nowIso(ctx.clock),
        ),
      );
      const outcome = await dispatch.done;
      ctx.store.immediate((db) =>
        recordTransition(
          db,
          {
            type: 'service.dispatch_finished',
            actor,
            projectId,
            taskId: operation.taskId,
            payload: { outcome },
          },
          { action: 'service.dispatch', input: operation, decision: outcome.kind },
          nowIso(ctx.clock),
        ),
      );
      return { claim: dispatch.claim, session: dispatch.session, outcome };
    }
  }
}

function metricKind(launch: ExecutionLaunch): OperationKind {
  switch (launch.operation.kind) {
    case 'index':
      return 'index';
    case 'sync':
      return 'sync';
    case 'publish':
      return 'publish';
    case 'queue':
      return 'validation';
    case 'review':
      return 'review';
    case 'workspace':
    case 'dispatch':
      return 'workspace';
    case 'cleanup':
      return 'workspace';
    case 'outbox':
    case 'health':
      return 'controller';
  }
}

export async function runExecutionWorker(
  ctx: CrewContext,
  operationId: string,
  deliveryAttemptId: string,
): Promise<void> {
  const op = getOutbox(ctx.store.db, operationId);
  if (!op || op.kind !== EXECUTION_LAUNCH_KIND)
    throw new CrewError('NOT_FOUND', `Execution launch ${operationId} not found`);
  const launch = op.intent as unknown as ExecutionLaunch;
  const delivery = getExecutionClaim(ctx.store.db, `outbox:${operationId}`);
  if (!delivery || delivery.attemptId !== deliveryAttemptId)
    throw new CrewError('STALE_LEASE', 'Execution launch delivery changed');
  const claimed: ClaimedOutboxOperation = { ...op, claim: delivery };
  const identity = processIdentity(process.pid);
  if (!identity) throw new CrewError('UNAVAILABLE', 'Cannot verify execution worker process identity');
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    assertOutboxClaim(db, claimed, at);
    bindExecutionProcess(db, launch.claim, { host: hostname(), pid: process.pid, startIdentity: identity }, at);
  });
  const directory = ensureDir(launch.directory);
  const cancellation = new AbortController();
  let dispatch: Dispatch | null = null;
  let cancelled = false;
  let ownershipError: unknown = null;
  const requestCancel = () => {
    cancelled = true;
    if (dispatch) {
      void dispatch
        .interrupt(
          (
            ctx.store.db
              .query(
                "SELECT json_extract(intent, '$.reason') AS reason FROM outbox WHERE kind = 'execution.cancel' AND subject_id = ? ORDER BY created_at DESC LIMIT 1",
              )
              .get(operationId) as { reason: string } | null
          )?.reason ?? 'execution worker stopping',
        )
        .catch((error: unknown) => {
          ownershipError = error;
          cancellation.abort(error);
        });
    } else {
      stopExecutionProcesses(directory);
      cancellation.abort(new CrewError('CONFLICT', 'Execution cancelled'));
    }
  };
  const guarded = executionContext(ctx, {
    claim: launch.claim,
    directory,
    signal: cancellation.signal,
    onSpawn: (pid) => recordExecutionProcess(directory, pid),
  });
  const pulse = setInterval(
    () => {
      try {
        ctx.store.immediate((db) => {
          const at = nowIso(ctx.clock);
          assertOutboxClaim(db, claimed, at);
          renewExecutionClaim(db, delivery, launch.limits.leaseSeconds, at);
          renewExecutionClaim(db, launch.claim, launch.limits.leaseSeconds, at);
        });
      } catch (error) {
        ownershipError = error;
        requestCancel();
      }
    },
    Math.max(250, Math.floor((launch.limits.leaseSeconds * 1000) / 3)),
  );
  const deadline = setTimeout(requestCancel, Math.max(1, Date.parse(launch.deadlineAt) - Date.now()));
  process.once('SIGTERM', requestCancel);
  process.once('SIGINT', requestCancel);
  const started = performance.now();
  let result: Record<string, unknown> | null = null;
  let failure: unknown = null;
  try {
    result = await withProcessLifecycle(guarded.execution!, () =>
      execute(guarded, launch, (active) => {
        dispatch = active;
        guarded.store.immediate((db) => {
          const at = nowIso(ctx.clock);
          assertOutboxClaim(db, claimed, at);
          db.query('UPDATE outbox SET remote_correlation = ?, updated_at = ? WHERE operation_id = ?').run(
            JSON.stringify({ progress: { claim: active.claim, session: active.session } }),
            at,
            operationId,
          );
          recordTransition(
            db,
            {
              type: 'execution.progress',
              actor: launch.actor,
              projectId: launch.projectId,
              taskId: active.claim.taskId,
              payload: { operationId, sessionId: active.session.sessionId },
            },
            { action: 'execution.progress', input: { operationId }, decision: 'session_started' },
            at,
          );
        });
        if (cancelled) requestCancel();
      }),
    );
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(pulse);
    clearTimeout(deadline);
    process.removeListener('SIGTERM', requestCancel);
    process.removeListener('SIGINT', requestCancel);
  }
  const children = await finishExecutionResources(ctx, launch);
  if (children.unverifiable > 0)
    failure = new CrewError('CONFLICT', 'Unverifiable execution children remain; attempt resources preserved');
  if (children.cleanupError) failure = new CrewError('CONFLICT', children.cleanupError);
  if (ownershipError) throw ownershipError;
  const completionContext = executionContext(ctx, {
    claim: launch.claim,
    directory,
    signal: new AbortController().signal,
    onSpawn: (pid) => recordExecutionProcess(directory, pid),
  });
  recordOperation(completionContext, {
    operation: metricKind(launch),
    projectId: launch.projectId,
    repositoryId: primaryRepository(ctx, launch.projectId).id,
    actor: launch.actor,
    durationMs: performance.now() - started,
    outcome: cancelled ? 'cancelled' : failure ? 'failed' : 'completed',
    counts: { childProcessesStopped: children.stopped, ...ctx.store.contention },
  });
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    assertExecutionClaim(db, launch.claim, at);
    completeOutbox(
      db,
      claimed,
      children.unverifiable || children.pending || children.cleanupError
        ? { status: 'ambiguous', error: 'Child process exit is not verified; attempt resources preserved' }
        : cancelled
          ? { status: 'cancelled', error: 'Execution cancelled', remoteCorrelation: { result } }
          : failure
            ? {
                status: 'failed',
                error: redact(toCrewError(failure).message),
                remoteCorrelation: { failure: redactObject(toCrewError(failure).toJSON()) },
              }
            : { status: 'succeeded', remoteCorrelation: { result } },
      at,
    );
    if (children.unverifiable || children.cleanupError) {
      requestInterventionInTx(
        db,
        {
          projectId: launch.projectId,
          title: `Execution ${launch.claim.attemptId} needs process verification`,
          reasons: [children.cleanupError ?? 'Unverifiable child processes remain. Attempt resources are preserved.'],
          once: true,
        },
        launch.actor,
        at,
      );
    } else if (!children.pending) releaseExecutionClaim(db, launch.claim, at);
  });
  if (failure) throw failure;
}
