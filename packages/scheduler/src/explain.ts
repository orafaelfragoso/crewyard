import { RailError } from '@agent-rail/core';
import type { RailContext } from '@agent-rail/storage';
import { requireTask, resolveTaskConfig } from '@agent-rail/tasks';
import { type Admission, type AdmissionResult, admitTasks, type Deferral, type IntakeCapacity } from './admit.ts';
import { buildSchedulerSnapshot, type SnapshotOptions } from './snapshot.ts';

export function planDispatch(ctx: RailContext, projectId: string, options: SnapshotOptions = {}): AdmissionResult {
  const config = resolveTaskConfig(ctx, projectId, options.config);
  return admitTasks(buildSchedulerSnapshot(ctx, projectId, { ...options, config }), config);
}

export type DispatchExplanation =
  | { taskId: string; admitted: true; admission: Admission; capacity: IntakeCapacity }
  | { taskId: string; admitted: false; deferral: Deferral; capacity: IntakeCapacity };

export function explainDispatch(ctx: RailContext, taskId: string, options: SnapshotOptions = {}): DispatchExplanation {
  const task = requireTask(ctx.store.db, taskId);
  const result = planDispatch(ctx, task.projectId, options);
  const admission = result.admitted.find((a) => a.taskId === taskId);
  if (admission) return { taskId, admitted: true, admission, capacity: result.capacity };
  const deferral = result.deferred.find((d) => d.taskId === taskId);
  if (deferral) return { taskId, admitted: false, deferral, capacity: result.capacity };
  throw new RailError('NOT_FOUND', `Task ${taskId} is ${task.state} and no longer scheduled`, {
    details: { state: task.state },
  });
}
