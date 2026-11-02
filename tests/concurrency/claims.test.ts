import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addTask } from '@crewyard/tasks';
import { createTestContext, type TestContext } from '../helpers/index.ts';
import { operator, seedProject, testConfig } from '../unit/tasks/fixtures.ts';
import type { WorkerReport } from './claim-worker.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const WORKER = join(import.meta.dir, 'claim-worker.ts');

async function runWorkers(
  c: TestContext,
  count: number,
  input: { taskIds: string[]; targetClaims: number; mode: 'single' | 'stress' },
): Promise<WorkerReport[]> {
  const lockDir = join(c.root, 'locks');
  mkdirSync(lockDir, { recursive: true });
  const startAt = Date.now() + 750;
  const procs = Array.from({ length: count }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        WORKER,
        JSON.stringify({ ...input, dataDir: c.dirs.data, lockDir, agentId: `agent-${i}`, startAt }),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ),
  );
  return Promise.all(
    procs.map(async (proc) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`worker failed (${exitCode}): ${stderr}`);
      return JSON.parse(stdout.trim()) as WorkerReport;
    }),
  );
}

function seedTasks(c: TestContext, count: number): string[] {
  const { projectId } = seedProject(c);
  const config = testConfig();
  return Array.from(
    { length: count },
    (_, i) => addTask(c, { projectId, title: `task ${i}`, actor: operator }, { config }).id,
  );
}

describe('multiprocess claims', () => {
  test('AT-01: ten processes race for one READY task and exactly one token is accepted', async () => {
    ctx = createTestContext();
    const [taskId] = seedTasks(ctx, 1);
    const reports = await runWorkers(ctx, 10, { taskIds: [taskId!], targetClaims: 1, mode: 'single' });
    const winners = reports.filter((r) => r.claims.length === 1);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.claims[0]!.generation).toBe(1);
    const losers = reports.filter((r) => r.claims.length === 0).map((r) => Object.keys(r.outcomes));
    expect(losers).toEqual(Array.from({ length: 9 }, () => ['LEASE_CONFLICT']));
    const active = ctx.store.db.query('SELECT holder_id FROM leases WHERE released_at IS NULL').all() as {
      holder_id: string;
    }[];
    expect(active.map((a) => a.holder_id)).toEqual([winners[0]!.agentId]);
  }, 30_000);

  test('1,000-claim stress: eight processes never hold two valid leases for the same task', async () => {
    ctx = createTestContext();
    const taskIds = seedTasks(ctx, 5);
    const started = performance.now();
    const reports = await runWorkers(ctx, 8, { taskIds, targetClaims: 125, mode: 'stress' });
    const elapsedMs = Math.round(performance.now() - started);

    const claims = reports.flatMap((r) => r.claims);
    const conflicts = reports.reduce((sum, r) => sum + (r.outcomes.LEASE_CONFLICT ?? 0), 0);
    expect(reports.flatMap((r) => r.violations)).toEqual([]);
    expect(reports.every((r) => (r.outcomes.UNEXPECTED ?? 0) === 0)).toBe(true);
    expect(claims.length).toBeGreaterThanOrEqual(1000);

    const db = ctx.store.db;
    const perTask = new Map<string, number[]>();
    for (const claim of claims) perTask.set(claim.taskId, [...(perTask.get(claim.taskId) ?? []), claim.generation]);
    for (const [taskId, generations] of perTask) {
      const sorted = [...generations].sort((a, b) => a - b);
      expect(sorted).toEqual(sorted.map((_, i) => i + 1));
      const row = db.query('SELECT lease_generation FROM tasks WHERE id = ?').get(taskId) as {
        lease_generation: number;
      };
      expect(row.lease_generation).toBe(sorted.length);
    }
    expect(db.query('SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: claims.length });
    const overlaps = db
      .query(
        `SELECT a.task_id FROM leases a JOIN leases b ON a.task_id = b.task_id AND b.generation = a.generation + 1
         WHERE a.released_at > b.acquired_at`,
      )
      .all();
    expect(overlaps).toEqual([]);
    console.info(`stress: ${claims.length} claims, ${conflicts} conflicts, ${elapsedMs}ms`);
  }, 60_000);
});
