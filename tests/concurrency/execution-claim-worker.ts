import { isCrewError } from '@crewyard/core';
import {
  acquireExecutionClaim,
  type ClaimedOutboxOperation,
  claimDueOutbox,
  completeOutbox,
  openStore,
} from '@crewyard/storage';

type Action =
  | { kind: 'execution'; ownerId: string }
  | { kind: 'outbox'; ownerId: string }
  | { kind: 'settle'; operation: ClaimedOutboxOperation };

interface WorkerInput {
  path: string;
  at: string;
  action: Action;
}

const input = JSON.parse(process.argv[2]!) as WorkerInput;
const store = openStore({ path: input.path, clock: { now: () => new Date(input.at) } });
await new Promise<void>((resolve) => {
  process.once('message', () => resolve());
  process.send!({ ready: true });
});
const started = performance.now();
try {
  const action = input.action;
  const result =
    action.kind === 'execution'
      ? store.immediate((db) =>
          acquireExecutionClaim(
            db,
            {
              scope: 'shared-execution',
              attemptId: `attempt-${action.ownerId}`,
              ownerId: action.ownerId,
              inputIdentity: 'tree:policy',
              ttlSeconds: 30,
            },
            input.at,
          ),
        )
      : action.kind === 'outbox'
        ? claimDueOutbox(store, { ownerId: action.ownerId, kinds: [], limit: 1, ttlSeconds: 30 })
        : store.immediate((db) => completeOutbox(db, action.operation, { status: 'succeeded' }, input.at));
  process.stdout.write(JSON.stringify({ result: result ?? null, elapsedMs: performance.now() - started }));
} catch (error) {
  if (!isCrewError(error)) throw error;
  process.stdout.write(JSON.stringify({ error: error.code, elapsedMs: performance.now() - started }));
} finally {
  store.close();
  process.disconnect!();
}
