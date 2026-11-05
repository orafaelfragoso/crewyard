import { nowIso } from '@crewyard/core';
import type { CrewContext, ExecutionScope } from './context.ts';
import { assertExecutionClaim } from './execution-claims.ts';

export function executionContext(ctx: CrewContext, execution: ExecutionScope): CrewContext {
  return {
    ...ctx,
    execution,
    store: {
      ...ctx.store,
      immediate: (fn) =>
        ctx.store.immediate((db) => {
          assertExecutionClaim(db, execution.claim, nowIso(ctx.clock));
          return fn(db);
        }),
      preview: (fn) =>
        ctx.store.preview((db) => {
          assertExecutionClaim(db, execution.claim, nowIso(ctx.clock));
          return fn(db);
        }),
    },
  };
}
