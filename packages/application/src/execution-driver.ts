import { CrewError, ERROR_EXIT_CODES, newId, nowIso, redact, type SerializedCrewError } from '@crewyard/core';
import { type CrewContext, enqueueOutbox, getOutbox } from '@crewyard/storage';
import { EXECUTION_CANCEL_KIND, type ExecutionLimits, type ExecutionRequest, submitExecution } from './execution.ts';
import { ExecutionSupervisor } from './execution-supervisor.ts';

export interface StartedExecution {
  operationId: string;
  result: Promise<Record<string, unknown>>;
}

export async function startExecution(
  ctx: CrewContext,
  request: ExecutionRequest,
  limits: ExecutionLimits,
): Promise<StartedExecution> {
  const supervisor = new ExecutionSupervisor(ctx, newId('wrk'), limits);
  const deadline = performance.now() + limits.timeoutSeconds * 1000;
  let operationId: string | null = null;
  let nextRecovery = 0;
  while (!operationId && performance.now() < deadline) {
    if (performance.now() >= nextRecovery) {
      await supervisor.recover();
      nextRecovery = performance.now() + 1_000;
    }
    operationId = submitExecution(ctx, request, limits)?.operationId ?? null;
    if (!operationId) await Bun.sleep(25);
  }
  if (!operationId) throw new CrewError('BUSY', 'Execution capacity did not become available before its deadline');
  const admittedId = operationId;
  const result = (async () => {
    try {
      while (performance.now() < deadline) {
        supervisor.pump(admittedId);
        const current = getOutbox(ctx.store.db, admittedId)!;
        if (
          ['succeeded', 'failed', 'cancelled'].includes(current.status) &&
          ctx.store.db
            .query(
              "SELECT 1 FROM outbox WHERE kind = 'execution.cancel' AND subject_id = ? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1",
            )
            .get(admittedId)
        ) {
          await Bun.sleep(25);
          continue;
        }
        if (current.status === 'succeeded' || (current.status === 'cancelled' && current.remoteCorrelation?.result)) {
          const output = current.remoteCorrelation?.result;
          if (!output || typeof output !== 'object' || Array.isArray(output))
            throw new CrewError('INTERNAL', `Execution ${admittedId} has no result`);
          return output as Record<string, unknown>;
        }
        if (current.status === 'failed' || current.status === 'cancelled') {
          const failure = current.remoteCorrelation?.failure as SerializedCrewError | undefined;
          if (failure && failure.code in ERROR_EXIT_CODES) throw new CrewError(failure.code, failure.message, failure);
          throw new CrewError('EXTERNAL_FAILURE', current.lastError ?? `Execution ${admittedId} ${current.status}`);
        }
        await Bun.sleep(25);
      }
      throw new CrewError('BUSY', 'Execution did not finish before its configured deadline');
    } finally {
      await supervisor.stop();
    }
  })();
  return { operationId: admittedId, result };
}

export async function driveExecution(
  ctx: CrewContext,
  request: ExecutionRequest,
  limits: ExecutionLimits,
): Promise<Record<string, unknown>> {
  return (await startExecution(ctx, request, limits)).result;
}

export function cancelExecution(ctx: CrewContext, operationId: string, reason: string): void {
  const target = getOutbox(ctx.store.db, operationId);
  if (target?.kind !== 'execution.launch') throw new CrewError('NOT_FOUND', 'Execution not found');
  ctx.store.immediate((db) =>
    enqueueOutbox(
      db,
      {
        kind: EXECUTION_CANCEL_KIND,
        projectId: target.projectId,
        taskId: target.taskId,
        subjectId: operationId,
        intent: { operationId, reason: redact(reason) },
        idempotencyKey: `execution-cancel:${operationId}`,
      },
      nowIso(ctx.clock),
    ),
  );
}
