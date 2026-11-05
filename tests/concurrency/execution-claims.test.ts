import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { type ClaimedOutboxOperation, type ExecutionClaim, enqueueOutbox, getOutbox } from '@crewyard/storage';
import { createTestContext, ManualClock, type TestContext } from '../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

interface WorkerReport {
  result: ExecutionClaim | ClaimedOutboxOperation[] | null;
  error?: string;
  elapsedMs: number;
}

type WorkerAction =
  | { kind: 'execution'; ownerId: string }
  | { kind: 'outbox'; ownerId: string }
  | { kind: 'settle'; operation: ClaimedOutboxOperation };

function worker(c: TestContext, at: string, action: WorkerAction) {
  const proc = spawn(
    process.execPath,
    [
      join(import.meta.dir, 'execution-claim-worker.ts'),
      JSON.stringify({
        path: c.dirs.database,
        at,
        action,
      }),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr!.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    proc.once('message', () => resolve());
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(`worker exited before ready (${code}): ${stderr}`)));
  });
  const report = new Promise<WorkerReport>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0) reject(new Error(`worker failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout) as WorkerReport);
    });
  });
  return { ready, report, start: () => proc.send('go'), stop: () => proc.kill() };
}

async function runWorkers(c: TestContext, at: string, actions: WorkerAction[]): Promise<WorkerReport[]> {
  const workers = actions.map((action) => worker(c, at, action));
  try {
    await Promise.all(workers.map((w) => w.ready));
    for (const w of workers) w.start();
    return await Promise.all(workers.map((w) => w.report));
  } finally {
    for (const w of workers) w.stop();
  }
}

describe('multiprocess execution ownership', () => {
  test('two processes racing for one scope admit exactly one immutable attempt', async () => {
    ctx = createTestContext({ clock: new ManualClock(), durability: 'full' });
    const reports = await runWorkers(ctx, '2026-11-02T12:00:00Z', [
      { kind: 'execution', ownerId: 'one' },
      { kind: 'execution', ownerId: 'two' },
    ]);
    expect(reports.map((r) => r.error)).toEqual([undefined, undefined]);
    expect(reports.filter((r) => r.result !== null)).toHaveLength(1);
    expect(ctx.store.db.query('SELECT COUNT(*) AS n FROM execution_claims WHERE released_at IS NULL').get()).toEqual({
      n: 1,
    });
    expect(ctx.store.db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    expect(ctx.store.db.query('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
  });

  test('delivery takeover in another process rejects settlement from the previous attempt', async () => {
    ctx = createTestContext({ clock: new ManualClock(), durability: 'full' });
    ctx.store.immediate((db) => enqueueOutbox(db, { kind: 'test.effect', intent: {} }, '2026-11-02T12:00:00Z'));
    const reports = await runWorkers(ctx, '2026-11-02T12:00:00Z', [
      { kind: 'outbox', ownerId: 'one' },
      { kind: 'outbox', ownerId: 'two' },
    ]);
    const operations = reports.flatMap((r) => r.result as ClaimedOutboxOperation[]);
    expect(operations).toHaveLength(1);
    const original = operations[0]!;
    const [takeover] = await runWorkers(ctx, '2026-11-02T12:00:30Z', [{ kind: 'outbox', ownerId: 'successor' }]);
    const successor = (takeover!.result as ClaimedOutboxOperation[])[0]!;
    expect(successor.claim.generation).toBe(2);
    expect(successor.claim.attemptId).not.toBe(original.claim.attemptId);
    const [stale] = await runWorkers(ctx, '2026-11-02T12:00:31Z', [{ kind: 'settle', operation: original }]);
    expect(stale!.error).toBe('STALE_LEASE');
    expect(getOutbox(ctx.store.db, original.operationId)?.status).toBe('attempted');
    const [settled] = await runWorkers(ctx, '2026-11-02T12:00:31Z', [{ kind: 'settle', operation: successor }]);
    expect(settled!.error).toBeUndefined();
    expect(getOutbox(ctx.store.db, original.operationId)?.status).toBe('succeeded');
  });

  test('a locked database returns bounded BUSY without publishing a claim', async () => {
    ctx = createTestContext({ durability: 'full' });
    const child = worker(ctx, '2026-11-02T12:00:00Z', { kind: 'execution', ownerId: 'blocked' });
    try {
      await child.ready;
      ctx.store.db.exec('BEGIN IMMEDIATE');
      child.start();
      const report = await child.report;
      expect(report.error).toBe('BUSY');
      expect(report.elapsedMs).toBeGreaterThanOrEqual(1_000);
      expect(report.elapsedMs).toBeLessThan(2_000);
    } finally {
      if (ctx.store.db.inTransaction) ctx.store.db.exec('ROLLBACK');
      child.stop();
    }
    expect(ctx.store.db.query('SELECT COUNT(*) AS n FROM execution_claims').get()).toEqual({ n: 0 });
  }, 10_000);
});
