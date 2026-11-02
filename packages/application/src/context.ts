import {
  type Clock,
  type CrewDirs,
  createLogger,
  type LogLevel,
  newId,
  resolveDirs,
  systemClock,
  type ToolEnvelope,
  toCrewError,
} from '@crewyard/core';
import { type CrewContext, type Durability, latestSeq, openCrewStore } from '@crewyard/storage';

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: CrewDirs;
  clock?: Clock;
  durability?: Durability;
  logLevel?: LogLevel;
}

export function createCrewContext(options: ContextOptions = {}): CrewContext {
  const env = options.env ?? process.env;
  const dirs = options.dirs ?? resolveDirs(env);
  const clock = options.clock ?? systemClock;
  const durability = options.durability ?? (env.CREW_DURABILITY === 'normal' ? 'normal' : 'full');
  const store = openCrewStore({ dirs, clock, durability });
  const logger = createLogger({ level: options.logLevel ?? ((env.CREW_LOG_LEVEL as LogLevel | undefined) || 'warn') });
  return { store, dirs, logger, clock };
}

export async function envelope<T>(
  ctx: CrewContext,
  fn: (operationId: string) => Promise<T> | T,
): Promise<ToolEnvelope<T>> {
  const operationId = newId('op');
  try {
    const data = await fn(operationId);
    return { ok: true, operationId, data, revision: latestSeq(ctx.store.db) };
  } catch (error) {
    const crew = toCrewError(error);
    if (crew.code === 'INTERNAL') ctx.logger.error('operation failed', { operationId, error: crew.message });
    return { ok: false, operationId, error: crew.toJSON(), revision: latestSeq(ctx.store.db) };
  }
}
