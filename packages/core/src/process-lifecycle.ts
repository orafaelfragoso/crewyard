import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProcessLifecycle {
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
}

const lifecycle = new AsyncLocalStorage<ProcessLifecycle>();

export function processLifecycle(explicit: ProcessLifecycle): ProcessLifecycle {
  const managed = lifecycle.getStore();
  if (!managed) return explicit;
  const signals = [...new Set([managed.signal, explicit.signal].filter((signal) => signal !== undefined))];
  const observers = [...new Set([managed.onSpawn, explicit.onSpawn].filter((observer) => observer !== undefined))];
  return {
    ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    ...(observers.length
      ? {
          onSpawn: (pid: number) => {
            for (const observe of observers) observe(pid);
          },
        }
      : {}),
  };
}

export function withProcessLifecycle<T>(scope: ProcessLifecycle, work: () => T): T {
  return lifecycle.run(processLifecycle(scope), work);
}
