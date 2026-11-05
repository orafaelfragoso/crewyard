import { CrewError, newId } from '@crewyard/core';
import { type CrewContext, getOutbox } from '@crewyard/storage';
import { type ExecutionLimits, type ExecutionRequest, submitExecution } from './execution.ts';
import { ExecutionSupervisor } from './execution-supervisor.ts';

export async function driveExecution(
  ctx: CrewContext,
  request: ExecutionRequest,
  limits: ExecutionLimits,
): Promise<Record<string, unknown>> {
  const supervisor = new ExecutionSupervisor(ctx, newId('wrk'), limits);
  const deadline = performance.now() + limits.timeoutSeconds * 1000;
  let operationId: string | null = null;
  try {
    while (performance.now() < deadline) {
      if (!operationId) operationId = submitExecution(ctx, request, limits)?.operationId ?? null;
      if (operationId) {
        supervisor.pump(operationId);
        const current = getOutbox(ctx.store.db, operationId)!;
        if (current.status === 'succeeded') {
          const result = current.remoteCorrelation?.result;
          if (!result || typeof result !== 'object' || Array.isArray(result))
            throw new CrewError('INTERNAL', `Execution ${operationId} has no result`);
          return result as Record<string, unknown>;
        }
        if (current.status === 'failed' || current.status === 'cancelled') {
          throw new CrewError('EXTERNAL_FAILURE', current.lastError ?? `Execution ${operationId} ${current.status}`);
        }
      }
      await Bun.sleep(25);
    }
    throw new CrewError('BUSY', 'Execution did not finish before its configured deadline');
  } finally {
    await supervisor.stop();
  }
}
