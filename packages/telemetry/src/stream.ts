import { type CrewContext, type CrewEvent, type EventQuery, latestSeq, listEvents } from '@crewyard/storage';

export interface FollowOptions extends Omit<EventQuery, 'afterSeq' | 'order' | 'beforeSeq'> {
  afterSeq?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface FollowHandlers {
  onEvent(event: CrewEvent): void | Promise<void>;
  onResync?(reason: string, cursor: number): void | Promise<void>;
}

export async function followEvents(
  ctx: CrewContext,
  options: FollowOptions,
  handlers: FollowHandlers,
): Promise<number> {
  let cursor = options.afterSeq ?? latestSeq(ctx.store.db);
  const pollMs = options.pollMs ?? 500;
  while (!options.signal?.aborted) {
    let batch: CrewEvent[];
    try {
      batch = listEvents(ctx.store, { ...options, afterSeq: cursor, limit: options.limit ?? 500, order: 'asc' });
    } catch (error) {
      await handlers.onResync?.(`read failed: ${(error as Error).message}`, cursor);
      await Bun.sleep(pollMs);
      continue;
    }
    for (const event of batch) {
      await handlers.onEvent(event);
      cursor = event.seq;
    }
    if (batch.length === 0) await Bun.sleep(pollMs);
  }
  return cursor;
}

export interface EventPage {
  items: CrewEvent[];
  cursor: { before: number | null; after: number | null };
}

export function pageEvents(
  ctx: CrewContext,
  query: Omit<EventQuery, 'order'> & { direction?: 'older' | 'newer' } = {},
): EventPage {
  const direction = query.direction ?? 'older';
  const limit = Math.min(query.limit ?? 100, 500);
  const items =
    direction === 'older'
      ? listEvents(ctx.store, { ...query, limit, order: 'desc' }).reverse()
      : listEvents(ctx.store, { ...query, limit, order: 'asc' });
  return {
    items,
    cursor: {
      before: items.length > 0 ? items[0]!.seq : null,
      after: items.length > 0 ? items.at(-1)!.seq : null,
    },
  };
}
