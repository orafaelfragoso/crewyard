import type { ServiceOptions } from './service-loop.ts';

export function defaultServiceOptions(): ServiceOptions {
  return { cycles: [], remoteRecovery: [] };
}
