import { afterEach, describe, expect, test } from 'bun:test';
import { silentLogger } from '@crewyard/core';
import { staticTokenProvider } from '@crewyard/github';
import {
  createClientFactory,
  enqueueOrReviveInTx,
  type MergeIntent,
  mergeIdempotencyKey,
  processIntegrationOutbox,
  queueTick,
  requestIntegration,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { acquireLeadership, all, type CrewContext, claimDueOutbox, getOutbox, openCrewStore } from '@crewyard/storage';
import { ManualClock } from '../helpers/index.ts';
import { createGitHubFixture, type GitHubFixture } from '../integration/github-fixture.ts';

let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

const agent = { kind: 'agent' as const, id: 'agent-1' };

async function queuedPull(f: GitHubFixture) {
  await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
  const mockPr = f.mock.addPull({ headRef: 'feature' });
  f.mock.passChecks(mockPr.number);
  f.ctx.store.db
    .query(
      `INSERT INTO tasks (id, project_id, title, state, created_at, updated_at, state_changed_at) VALUES ('task_1', ?, 't', 'IN_REVIEW', 'x', 'x', 'x')`,
    )
    .run(f.projectId);
  await syncRepository(f.ctx, f.repositoryId, f.env);
  f.ctx.store.db.query(`UPDATE pull_requests SET task_id = 'task_1' WHERE number = ?`).run(mockPr.number);
  const { entry } = await requestIntegration(
    f.ctx,
    { repositoryId: f.repositoryId, number: mockPr.number, requestedBy: agent },
    f.env,
  );
  return { number: mockPr.number, pr: showPullRequest(f.ctx, { prId: entry.prId }), entry };
}

const mergeCalls = (f: GitHubFixture) => f.mock.countCalls('PUT', /\/pulls\/\d+\/merge$/);

describe('merge side effects under failure', () => {
  test('AT-09: a timeout after GitHub merged is reconciled without a second merge call', async () => {
    const clock = new ManualClock(new Date());
    const timeoutMs = process.platform === 'win32' ? 3_000 : 400;
    fx = await createGitHubFixture({ clock, timeoutMs });
    const f = fx;
    const { number, pr } = await queuedPull(f);
    f.mock.faults.push({ method: 'PUT', path: /\/merge$/, action: 'timeout-after-apply', delayMs: timeoutMs + 1_100 });

    const first = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(first.queues[0]!.notes.join(' ')).toContain('ambiguous');
    expect(f.mock.pull(number).merged).toBe(true);
    expect(showPullRequest(f.ctx, { prId: pr.id }).state).toBe('open');
    const op = all<{ status: string; idempotency_key: string }>(
      f.ctx.store.db,
      `SELECT status, idempotency_key FROM outbox WHERE kind = 'github.merge'`,
    );
    expect(op).toEqual([
      { status: 'ambiguous', idempotency_key: mergeIdempotencyKey(f.repositoryId, pr.id, pr.headSha) },
    ]);

    clock.advance(10);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(mergeCalls(f)).toBe(1);
    const merged = showPullRequest(f.ctx, { prId: pr.id });
    expect(merged.state).toBe('merged');
    expect(merged.mergeCommitSha).toBe(f.mock.pull(number).mergeCommitSha);
    expect(all<{ status: string }>(f.ctx.store.db, `SELECT status FROM outbox WHERE kind = 'github.merge'`)).toEqual([
      { status: 'succeeded' },
    ]);
    expect(f.hookCalls.filter((h) => h.name === 'onMerged')).toEqual([
      { name: 'onMerged', event: expect.objectContaining({ taskId: 'task_1', mergeCommitSha: merged.mergeCommitSha }) },
    ]);
    const remote = all<{ target: string }>(f.ctx.store.db, 'SELECT target FROM remote_operations ORDER BY at, rowid');
    expect(remote.map((r) => r.target)).toContain(`pulls/${number}#reconcile`);
  }, 30_000);
});

describe('AT-18: restart during outbox execution', () => {
  async function crashMidMerge(remoteApplied: boolean) {
    const clock = new ManualClock(new Date());
    fx = await createGitHubFixture({ clock });
    const f = fx;
    const { number, pr, entry } = await queuedPull(f);
    const lease = acquireLeadership(f.ctx.store, `integration:${f.repositoryId}:main`, 'crashed-worker', 60)!;
    const at = clock.now().toISOString();
    const intent: MergeIntent = {
      repositoryId: f.repositoryId,
      prId: pr.id,
      number,
      headSha: pr.headSha,
      baseRef: 'main',
      expectedBaseSha: null,
      mergeMethod: 'squash',
      candidateId: null,
      entryId: entry.id,
      retargetBase: null,
    };
    const op = f.ctx.store.immediate((db) => {
      db.query(`UPDATE queue_entries SET status = 'merging' WHERE id = ?`).run(entry.id);
      return enqueueOrReviveInTx(
        db,
        {
          kind: 'github.merge',
          subjectId: pr.id,
          intent,
          idempotencyKey: mergeIdempotencyKey(f.repositoryId, pr.id, pr.headSha),
          leaderGeneration: lease.generation,
        },
        at,
      );
    });
    expect(
      claimDueOutbox(f.ctx.store, { ownerId: 'crashed-worker', limit: 10, kinds: ['github.merge'], ttlSeconds: 60 }),
    ).toHaveLength(1);
    if (remoteApplied) f.mock.mergeExternally(number);

    clock.advance(120);
    const store = openCrewStore({ dirs: f.ctx.dirs, clock, durability: 'normal' });
    const restarted: CrewContext = { store, dirs: f.ctx.dirs, logger: silentLogger, clock };
    const env = {
      ...f.env,
      github: createClientFactory(restarted, {
        baseUrl: f.mock.url,
        token: staticTokenProvider(f.mock.token),
        retryBaseMs: 1,
      }),
    };
    const report = await processIntegrationOutbox(restarted, { leaderId: 'new-worker', env });
    if (!remoteApplied) {
      expect(report.failed).toEqual([op.operationId]);
      expect(getOutbox(store.db, op.operationId)!.status).toBe('cancelled');
      expect(showPullRequest(restarted, { prId: pr.id }).state).toBe('open');
      store.close();
      return f;
    }
    expect(report.succeeded).toEqual([op.operationId]);
    expect(getOutbox(store.db, op.operationId)!.status).toBe('succeeded');
    const after = showPullRequest(restarted, { prId: pr.id });
    expect(after.state).toBe('merged');
    expect(after.mergeCommitSha).toBe(f.mock.pull(number).mergeCommitSha);
    expect(all(store.db, `SELECT 1 FROM queue_entries WHERE id = ? AND status = 'merged'`, entry.id)).toHaveLength(1);
    expect(
      all(store.db, `SELECT 1 FROM audit_events WHERE action = 'github.merge' AND decision = 'merged'`),
    ).toHaveLength(1);
    const again = await processIntegrationOutbox(restarted, { leaderId: 'new-worker', env });
    expect(again.processed).toBe(0);
    store.close();
    return f;
  }

  test('remote merge applied before the crash is adopted, never repeated', async () => {
    const f = await crashMidMerge(true);
    expect(mergeCalls(f)).toBe(0);
  }, 30_000);

  test('legacy merge not sent before the crash requires fresh admission', async () => {
    const f = await crashMidMerge(false);
    expect(mergeCalls(f)).toBe(0);
  }, 30_000);
});
