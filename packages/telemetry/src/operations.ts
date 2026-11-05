import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, nowIso } from '@crewyard/core';
import { type CrewContext, recordTransition } from '@crewyard/storage';

export type OperationKind =
  | 'controller'
  | 'index'
  | 'validation'
  | 'review'
  | 'workspace'
  | 'bootstrap'
  | 'sync'
  | 'publish'
  | 'fetch';

export interface OperationObservation {
  operation: OperationKind;
  projectId: string | null;
  repositoryId: string | null;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  actor: Actor;
  counts: Readonly<Record<string, number>>;
}

export interface OperationMetrics {
  operation: string;
  count: number;
  failed: number;
  cancelled: number;
  totalDurationMs: number;
  meanDurationMs: number;
  maxDurationMs: number;
}

export function recordOperation(ctx: CrewContext, observation: OperationObservation): void {
  ctx.store.immediate((db) => recordOperationInTx(db, observation, nowIso(ctx.clock)));
}

export function recordOperationInTx(db: Database, observation: OperationObservation, at: string): void {
  if (!db.inTransaction) throw new CrewError('INTERNAL', 'Operation observations require an active transaction');
  if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0) {
    throw new CrewError('INVALID_INPUT', 'Operation duration must be a finite non-negative number');
  }
  for (const [name, value] of Object.entries(observation.counts)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new CrewError('INVALID_INPUT', `Operation counter ${name} must be a finite non-negative number`);
    }
  }
  const payload = {
    operation: observation.operation,
    repositoryId: observation.repositoryId,
    durationMs: observation.durationMs,
    outcome: observation.outcome,
    counts: observation.counts,
  };
  recordTransition(
    db,
    { type: 'operation.completed', actor: observation.actor, projectId: observation.projectId, payload },
    { action: 'operation.observe', input: payload, decision: observation.outcome },
    at,
  );
}
