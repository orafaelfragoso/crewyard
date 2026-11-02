import type { QueueActions } from './dashboard-actions.ts';
import type { ServiceOptions } from './service-loop.ts';

export function defaultServiceOptions(): ServiceOptions {
  return { cycles: [], remoteRecovery: [] };
}

export function defaultQueueActions(): QueueActions | null {
  return null;
}
