import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '@crewyard/core';
import { failOrphanedReviews } from '@crewyard/reviews';
import { commitFiles, createTempGitRepo, createTestContext, type TestContext } from '../helpers/index.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('admission barrier deadline');
    await Bun.sleep(10);
  }
}

async function fixture(path: string) {
  const ctx = createTestContext();
  cleanups.push(() => ctx.cleanup());
  const repo = await createTempGitRepo({ [path]: 'export const value = 1;\n' });
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const head = await commitFiles(repo, { [path]: 'export const value = 2;\n' });
  const at = ctx.clock.now().toISOString();
  ctx.store.db
    .query('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('project', 'test', at, at);
  ctx.store.db
    .query(
      'INSERT INTO repositories (id, project_id, canonical_path, default_base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('repo', 'project', repo, 'main', at, at);
  ctx.store.db
    .query(
      'INSERT INTO pull_requests (id, repository_id, number, title, head_ref, head_sha, base_ref, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('pr', 'repo', 1, 'test', 'feature', head, 'main', 'open', at, at);
  return { ctx, repo, base, head, marker: join(ctx.root, 'provider-calls'), release: join(ctx.root, 'release') };
}

function worker(
  fx: Awaited<ReturnType<typeof fixture>>,
  force: boolean,
  options: { cacheEnabled: boolean; type: 'code' | 'security'; crashAfterResult?: boolean },
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'review-admission-worker.ts'),
      dirname(fx.ctx.store.path),
      fx.repo,
      fx.base,
      fx.head,
      fx.marker,
      fx.release,
      String(force),
      String(options.cacheEnabled),
      options.type,
      String(options.crashAfterResult === true),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  cleanups.unshift(() => child.kill());
  return child;
}

function count(ctx: TestContext, table: string): number {
  return (ctx.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function finish(child: ReturnType<typeof worker>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout) as { outcomes: { reviewerInvoked: boolean; review: { status: string } }[] };
}

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'two processes coalesce full executions for force=%s/%s',
  async (firstForce, secondForce) => {
    const fx = await fixture('file.ts');
    const first = worker(fx, firstForce!, { cacheEnabled: true, type: 'code' });
    await waitFor(() => existsSync(fx.marker));
    const second = worker(fx, secondForce!, { cacheEnabled: true, type: 'code' });
    await waitFor(() => count(fx.ctx, 'review_requests') === 2);
    expect(count(fx.ctx, 'review_attempts')).toBe(1);
    writeFileSync(fx.release, 'release');
    const results = await Promise.all([finish(first), finish(second)]);
    expect(results.flatMap((result) => result.outcomes).filter((outcome) => outcome.reviewerInvoked)).toHaveLength(1);
    expect(results.flatMap((result) => result.outcomes).every((outcome) => outcome.review.status === 'passed')).toBe(
      true,
    );
    expect(readFileSync(fx.marker, 'utf8').trim().split('\n')).toHaveLength(1);
    if (secondForce) {
      await finish(worker(fx, true, { cacheEnabled: true, type: 'code' }));
      expect(count(fx.ctx, 'review_attempts')).toBe(2);
    }
  },
  20_000,
);

test('expired ownership is replaced and the stale provider cannot publish', async () => {
  const fx = await fixture('file.ts');
  const first = worker(fx, false, { cacheEnabled: true, type: 'code' });
  await waitFor(() => existsSync(fx.marker));
  fx.ctx.store.db
    .query("UPDATE execution_claims SET expires_at = '2000-01-01T00:00:00.000Z' WHERE scope LIKE 'review:%'")
    .run();
  const second = worker(fx, false, { cacheEnabled: true, type: 'code' });
  await waitFor(() => readFileSync(fx.marker, 'utf8').trim().split('\n').length === 2);
  writeFileSync(fx.release, 'release');
  await Promise.all([finish(first), finish(second)]);
  expect(fx.ctx.store.db.query('SELECT status FROM review_attempts ORDER BY created_at, id').all()).toEqual([
    { status: 'interrupted' },
    { status: 'completed' },
  ]);
  expect(fx.ctx.store.db.query('SELECT status FROM review_artifacts ORDER BY created_at, id').all()).toEqual([
    { status: 'failed' },
    { status: 'passed' },
  ]);
}, 20_000);

test.each([
  { cacheEnabled: false, type: 'code' as const },
  { cacheEnabled: true, type: 'security' as const },
])(
  'disabled reuse coalesces only an active full review',
  async (options) => {
    const fx = await fixture('src/auth/session.ts');
    const first = worker(fx, false, options);
    await waitFor(() => existsSync(fx.marker));
    const second = worker(fx, false, options);
    await waitFor(() => count(fx.ctx, 'review_requests') === 2);
    expect(count(fx.ctx, 'review_attempts')).toBe(1);
    writeFileSync(fx.release, 'release');
    await Promise.all([finish(first), finish(second)]);
    await finish(worker(fx, false, options));
    expect(count(fx.ctx, 'review_attempts')).toBe(2);
  },
  20_000,
);

test('a process crash after provider work is recovered by its own identity and repeats only that attempt', async () => {
  const fx = await fixture('file.ts');
  const first = worker(fx, false, { cacheEnabled: true, type: 'code', crashAfterResult: true });
  await waitFor(() => existsSync(fx.marker));
  writeFileSync(fx.release, 'release');
  expect(await first.exited).toBe(23);
  expect(failOrphanedReviews(fx.ctx)).toHaveLength(1);
  const next = await finish(worker(fx, false, { cacheEnabled: true, type: 'code' }));
  expect(next.outcomes[0]?.review.status).toBe('passed');
  expect(readFileSync(fx.marker, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(fx.ctx.store.db.query('SELECT status FROM review_attempts ORDER BY created_at, id').all()).toEqual([
    { status: 'interrupted' },
    { status: 'completed' },
  ]);
}, 20_000);
