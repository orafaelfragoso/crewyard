import { afterEach, describe, expect, test } from 'bun:test';
import { git } from '@crewyard/core';
import {
  acknowledgeDivergence,
  explainPullRequest,
  importPullRequests,
  integrationStatus,
  listPullRequests,
  queueTick,
  requestIntegration,
  setExpectedRemoteHead,
  showPullRequest,
  submitPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { getRepository } from '@crewyard/projects';
import { listReviews, requestReview, StaticAnalysisReviewer } from '@crewyard/reviews';
import { all } from '@crewyard/storage';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

const operator = { kind: 'operator' as const, id: 'tester' };
const agent = { kind: 'agent' as const, id: 'agent-1' };

describe('GitHub synchronization', () => {
  test('FR-GH-09: force pushes are flagged, evidence invalidated and GitHub adopted as authoritative', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const head = await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const n = f.mock.addPull({ headRef: 'feature' }).number;
    f.mock.passChecks(n);
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    setExpectedRemoteHead(f.ctx, pr.id, head, agent);
    await requestReview(
      f.ctx,
      {
        repositoryId: f.repositoryId,
        prId: pr.id,
        commitSha: head,
        baseSha: pr.baseSha!,
        patch: (await git(f.repo, ['diff', `${pr.baseSha}...${head}`])).stdout,
        types: ['code'],
      },
      { reviewers: { code: new StaticAnalysisReviewer() }, config: f.config },
    );

    const rewritten = await f.pushBranch('feature', { 'src/other.ts': 'export const o = 1;\n' });
    const result = await syncRepository(f.ctx, f.repositoryId, f.env);
    expect(result.changed[0]!.divergence).toContain('force_push');
    const after = showPullRequest(f.ctx, { prId: pr.id });
    expect(after.headSha).toBe(rewritten);
    expect(after.externalDivergence).toMatchObject({ blocking: true, previousHead: head, observedHead: rewritten });
    expect(listReviews(f.ctx, { prId: pr.id })).toHaveLength(0);
    expect(listReviews(f.ctx, { prId: pr.id, includeInvalidated: true })[0]!.invalidatedReason).toBe('head_changed');
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toContain('EXTERNAL_DIVERGENCE');
    await acknowledgeDivergence(f.ctx, pr.id, operator);
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).not.toContain('EXTERNAL_DIVERGENCE');
    expect(f.mock.countCalls('PATCH', /pulls/)).toBe(0);
  }, 30_000);

  test('a GitHub update-branch merge is accepted as the expected head instead of an external push', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const head = await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const n = f.mock.addPull({ headRef: 'feature' }).number;
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    setExpectedRemoteHead(f.ctx, pr.id, head, agent);
    await f.advanceBase({ 'docs/base.md': 'base moved\n' });
    const repository = getRepository(f.ctx, f.repositoryId);
    await f.env.github!(repository).updatePullRequestBranch(n, head);
    const merged = f.mock.branchSha('feature')!;

    const result = await syncRepository(f.ctx, f.repositoryId, f.env);
    expect(result.changed[0]).toMatchObject({ changes: expect.arrayContaining(['head_changed', 'base_merged']) });
    expect(result.changed[0]!.divergence).toEqual([]);
    const after = showPullRequest(f.ctx, { prId: pr.id });
    expect(after).toMatchObject({ headSha: merged, expectedRemoteHead: merged, externalDivergence: null });

    const outside = await f.pushBranch('feature', { 'src/outside.ts': 'export const o = 1;\n' }, 'feature');
    await syncRepository(f.ctx, f.repositoryId, f.env);
    expect(showPullRequest(f.ctx, { prId: pr.id })).toMatchObject({
      headSha: outside,
      expectedRemoteHead: merged,
      externalDivergence: { blocking: true, kinds: ['external_push'] },
    });
  }, 30_000);

  test('merges outside Crewyard are adopted with the actual merge commit', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const n = f.mock.addPull({ headRef: 'feature' }).number;
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const { entry } = await requestIntegration(
      f.ctx,
      { repositoryId: f.repositoryId, number: n, requestedBy: agent },
      f.env,
    );
    const sha = f.mock.mergeExternally(n);
    const result = await syncRepository(f.ctx, f.repositoryId, f.env);
    expect(result.merged).toEqual([{ prId: entry.prId, number: n, mergeCommitSha: sha, outsideCrew: true }]);
    expect(showPullRequest(f.ctx, { prId: entry.prId }).externalDivergence?.kinds).toContain('merged_outside_crew');
    expect(
      all(f.ctx.store.db, `SELECT 1 FROM queue_entries WHERE id = ? AND status = 'merged'`, entry.id),
    ).toHaveLength(1);
  }, 30_000);

  test('conditional requests reuse ETags persisted in sync_state', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    f.mock.addPull({ headRef: 'feature' });
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const before = f.mock.calls.length;
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const second = f.mock.calls.slice(before);
    expect(
      second.filter((c) => c.method === 'GET').every((c) => c.status === 304 || c.path.endsWith('/protection')),
    ).toBe(true);
    const etags = all(f.ctx.store.db, `SELECT 1 FROM sync_state WHERE key LIKE 'github:etag:%' AND etag IS NOT NULL`);
    expect(etags.length).toBeGreaterThan(5);
  }, 30_000);

  test('AT-12: offline pauses remote mutations, shows last-seen state and sync restores truth', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const n = f.mock.addPull({ headRef: 'feature' }).number;
    f.mock.passChecks(n);
    const online = await syncRepository(f.ctx, f.repositoryId, f.env);
    f.mock.goOffline();

    const queued = await requestIntegration(
      f.ctx,
      { repositoryId: f.repositoryId, number: n, requestedBy: agent },
      f.env,
    );
    expect(queued.created).toBe(true);
    await f.pushBranch('second', { 'src/second.ts': 'export const s = 1;\n' });
    const submitted = await submitPullRequest(
      f.ctx,
      { repositoryId: f.repositoryId, headRef: 'second', title: 'Second', actor: agent },
      { leaderId: 'leader-1', env: f.env },
    );
    expect(submitted.status).toBe('attempted');
    const tick = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(tick.offline).toBe(true);
    expect(tick.queues[0]!.notes.join(' ')).toContain(`last seen ${online.freshness.lastSuccessAt}`);
    const status = integrationStatus(f.ctx, f.repositoryId, f.env);
    expect(status.remote).toMatchObject({ offline: true, lastSuccessAt: online.freshness.lastSuccessAt });
    expect(status.pendingRemoteOperations.map((o) => o.kind)).toEqual(['github.create_pr']);
    expect(explainPullRequest(f.ctx, queued.entry.prId, f.env).blockers.map((b) => b.code)).toContain(
      'REMOTE_STATE_STALE',
    );
    expect(showPullRequest(f.ctx, { prId: queued.entry.prId }).state).toBe('open');

    f.mock.goOnline();
    f.ctx.store.db.query(`UPDATE outbox SET next_attempt_at = '2000-01-01T00:00:00Z'`).run();
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(integrationStatus(f.ctx, f.repositoryId, f.env).remote.offline).toBe(false);
    expect(showPullRequest(f.ctx, { prId: queued.entry.prId }).state).toBe('merged');
    const created = listPullRequests(f.ctx, { repositoryId: f.repositoryId }).find((p) => p.headRef === 'second');
    expect(created?.state).toBe('open');
    expect(f.mock.countCalls('POST', '/repos/acme/widgets/pulls')).toBe(1);
  }, 30_000);

  test('submit reconciles an existing PR for the head branch instead of creating a duplicate', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    f.mock.faults.push({ method: 'POST', path: /\/pulls$/, action: 'timeout-after-apply', delayMs: 1_500 });
    const env = { ...f.env };
    const first = await submitPullRequest(
      f.ctx,
      { repositoryId: f.repositoryId, headRef: 'feature', title: 'Feature', taskId: null, actor: agent },
      { leaderId: 'leader-1', env },
    );
    expect(['ambiguous', 'succeeded']).toContain(first.status);
    f.ctx.store.db.query(`UPDATE outbox SET next_attempt_at = '2000-01-01T00:00:00Z'`).run();
    const second = await submitPullRequest(
      f.ctx,
      { repositoryId: f.repositoryId, headRef: 'feature', title: 'Feature', actor: agent },
      { leaderId: 'leader-1', env },
    );
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(second.status).toBe('succeeded');
    expect(second.pullRequest?.expectedRemoteHead).toBe(second.pullRequest?.headSha);
    expect(f.mock.pulls.size).toBe(1);
  }, 30_000);

  test('J-03: import classifies low-risk candidates, blockers and stacks', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    f.mock.requireChecks('main', ['ci']);
    await f.pushBranch('docs', { 'docs/guide.md': '# guide\n' });
    const low = f.mock.addPull({ headRef: 'docs' }).number;
    f.mock.passChecks(low);
    await f.pushBranch('failing', { 'src/fail.ts': 'export const x = 1;\n' });
    const failing = f.mock.addPull({ headRef: 'failing' }).number;
    f.mock.setCheck(f.mock.pull(failing).headSha, 'ci', 'failure');
    await f.pushBranch('auth', { 'src/auth/login.ts': 'export const login = 1;\n' });
    const sensitive = f.mock.addPull({ headRef: 'auth' }).number;
    f.mock.passChecks(sensitive);
    await f.pushBranch('base-1', { 'stack/one.ts': '1\n' });
    const s1 = f.mock.addPull({ headRef: 'base-1' }).number;
    await f.pushBranch('base-2', { 'stack/two.ts': '2\n' }, 'base-1');
    const s2 = f.mock.addPull({ headRef: 'base-2', baseRef: 'base-1' }).number;

    const result = await importPullRequests(f.ctx, f.repositoryId, f.env);
    expect(result.lowRiskCandidates).toEqual([low]);
    expect(result.blocked).toContain(failing);
    expect(result.blocked).toContain(s2);
    expect(result.pullRequests.find((p) => p.number === sensitive)?.risk).toBe('high');
    expect(result.pullRequests.find((p) => p.number === sensitive)?.blockers.map((b) => b.code)).toContain(
      'APPROVAL_REQUIRED',
    );
    expect(result.stacks).toEqual([{ stackId: `chain:${s1}`, numbers: [s1, s2] }]);
    expect(listPullRequests(f.ctx, { repositoryId: f.repositoryId }).every((p) => p.imported)).toBe(true);
  }, 30_000);

  test('refuses to talk to GitHub when the configured remote no longer matches', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await git(f.repo, ['remote', 'set-url', 'origin', 'https://github.com/evil/fork.git']);
    await expect(syncRepository(f.ctx, f.repositoryId, f.env)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.mock.calls).toHaveLength(0);
  }, 30_000);
});
