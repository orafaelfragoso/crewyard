import {
  type Clock,
  createLogger,
  type LogLevel,
  newId,
  type RailDirs,
  resolveDirs,
  systemClock,
  type ToolEnvelope,
  toRailError,
} from '@agent-rail/core';
import { type Durability, latestSeq, openRailStore, type RailContext } from '@agent-rail/storage';

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: RailDirs;
  clock?: Clock;
  durability?: Durability;
  logLevel?: LogLevel;
}

export function createRailContext(options: ContextOptions = {}): RailContext {
  const env = options.env ?? process.env;
  const dirs = options.dirs ?? resolveDirs(env);
  const clock = options.clock ?? systemClock;
  const durability = options.durability ?? (env.RAIL_DURABILITY === 'normal' ? 'normal' : 'full');
  const store = openRailStore({ dirs, clock, durability });
  const logger = createLogger({ level: options.logLevel ?? ((env.RAIL_LOG_LEVEL as LogLevel | undefined) || 'warn') });
  return { store, dirs, logger, clock };
}

export async function envelope<T>(ctx: RailContext, fn: (operationId: string) => Promise<T> | T): Promise<ToolEnvelope<T>> {
  const operationId = newId('op');
  try {
    const data = await fn(operationId);
    return { ok: true, operationId, data, revision: latestSeq(ctx.store.db) };
  } catch (error) {
    const rail = toRailError(error);
    if (rail.code === 'INTERNAL') ctx.logger.error('operation failed', { operationId, error: rail.message });
    return { ok: false, operationId, error: rail.toJSON(), revision: latestSeq(ctx.store.db) };
  }
}
