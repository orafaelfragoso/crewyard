import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { git, gitText } from '@crewyard/core';
import {
  decideMergeApproval,
  explainPullRequest,
  getQueueStatus,
  listPullRequests,
  queueTick,
  repositorySyncKey,
  requestIntegration,
  setExpectedRemoteHead,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { type Reviewer, requestReview } from '@crewyard/reviews';
import { all } from '@crewyard/storage';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

const operator = { kind: 'operator' as const, id: 'tester' };
const CHECK = join(import.meta.dir, '../../fixtures/scripts/check-file.ts');
const check = (mode: 'present' | 'absent', path: string) => `"${process.execPath}" "${CHECK}" ${mode} ${path}`;

const agent = { kind: 'agent' as const, id: 'agent-1' };

async function openPull(f: GitHubFixture, branch: string, files: Record<string, string>, base = 'main') {
  await f.pushBranch(branch, files, base);
  const pr = f.mock.addPull({ headRef: branch, baseRef: base });
  f.mock.passChecks(pr.number);
  return pr.number;
}

async function queueAll(f: GitHubFixture, numbers: number[]) {
  await syncRepository(f.ctx, f.repositoryId, f.env);
  for (const number of numbers) {
    await requestIntegration(f.ctx, { repositoryId: f.repositoryId, number, requestedBy: agent }, f.env);
  }
}

async function tickUntilIdle(f: GitHubFixture, max = 12) {
  for (let i = 0; i < max; i++) {
    const result = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    if (result.queues.every((q) => q.merged.length === 0 && q.candidates.length === 0)) return;
  }
}

function mergeCalls(f: GitHubFixture) {
  return f.mock.countCalls('PUT', /\/pulls\/\d+\/merge$/);
}

describe('crew-managed integration queue', () => {
  test('AT-03: ten independent PRs integrate without author rebases', async () => {
    fx = await createGitHubFixture({
      config: { validation: { broad: [{ name: 'smoke', command: check('present', 'README.md') }] } },
    });
    const f = fx;
    f.mock.requireChecks('main', ['ci']);
    const numbers: number[] = [];
    for (let i = 0; i < 10; i++)
      numbers.push(await openPull(f, `feature-${i}`, { [`src/module-${i}.ts`]: `export const v${i} = ${i};\n` }));
    await queueAll(f, numbers);
    await tickUntilIdle(f);
    const prs = listPullRequests(f.ctx, { repositoryId: f.repositoryId });
    expect(prs.filter((p) => p.state === 'merged')).toHaveLength(10);
    expect(prs.every((p) => p.mergeCommitSha !== null)).toBe(true);
    expect(mergeCalls(f)).toBe(10);
    expect(f.mock.countCalls('PATCH', /\/pulls\/\d+$/)).toBe(0);
    const head = await gitText(f.bare, ['rev-parse', 'refs/heads/main']);
    const files = await gitText(f.bare, ['ls-tree', '--name-only', '-r', head]);
    for (let i = 0; i < 10; i++) expect(files).toContain(`src/module-${i}.ts`);
    const runs = all<{ commit_sha: string; tree_sha: string; status: string }>(
      f.ctx.store.db,
      `SELECT commit_sha, tree_sha, status FROM validation_runs WHERE scope = 'broad'`,
    );
    expect(runs.length).toBe(10);
    expect(runs.every((r) => r.status === 'passed' && r.tree_sha.length === 40)).toBe(true);
    const candidates = all<{ integration_validated: number; ci_evidence: string }>(
      f.ctx.store.db,
      `SELECT integration_validated, ci_evidence FROM integration_candidates WHERE status = 'merged'`,
    );
    expect(
      candidates.some((c) => c.integration_validated === 0 && c.ci_evidence.includes('not-yet-integration-validated')),
    ).toBe(true);
  }, 60_000);

  test('AT-04: two PRs changing the same interface are not assumed compatible', async () => {
    fx = await createGitHubFixture({
      files: { 'src/api.ts': 'export function greet(name: string): string {\n  return name;\n}\n' },
    });
    const f = fx;
    const a = await openPull(f, 'polite', {
      'src/api.ts':
        'export function greet(name: string, polite: boolean): string {\n  return polite ? "Dear " + name : name;\n}\n',
    });
    const b = await openPull(f, 'rename', {
      'src/api.ts': 'export function greet(person: string): string {\n  return person.trim();\n}\n',
    });
    await queueAll(f, [a, b]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const prB = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: b });
    expect(showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: a }).state).toBe('merged');
    expect(prB.state).toBe('open');
    const explanation = explainPullRequest(f.ctx, prB.id, f.env);
    expect(explanation.blockers.map((x) => x.code)).toContain('REVISION_REQUIRED');
    expect(explanation.eligible).toBe(false);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(mergeCalls(f)).toBe(1);
    expect(f.mock.countCalls('PATCH', /\/pulls\/\d+$/)).toBe(0);
    const notes = all<{ title: string }>(f.ctx.store.db, 'SELECT title FROM notifications');
    expect(notes.some((n) => n.title.includes(`#${b} needs a revision`))).toBe(true);

    await f.pushBranch(
      'rename',
      {
        'src/api.ts':
          'export function greet(name: string, polite: boolean): string {\n  return polite ? "Dear " + name.trim() : name.trim();\n}\n',
      },
      'main',
    );
    f.mock.passChecks(b);
    await tickUntilIdle(f);
    expect(showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: b }).state).toBe('merged');
  }, 60_000);

  test('AT-05: stacked PRs integrate bottom-up and inherit requirements', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    f.mock.requireChecks('main', ['ci']);
    f.mock.requireReviews('main', 1);
    const one = await openPull(f, 's1', { 'stack/a.ts': 'export const a = 1;\n' });
    const two = await openPull(f, 's2', { 'stack/b.ts': 'export const b = 2;\n' }, 's1');
    const three = await openPull(f, 's3', { 'stack/c.ts': 'export const c = 3;\n' }, 's2');
    f.mock.approve(one);
    f.mock.approve(three);
    await queueAll(f, [three, two, one]);
    const prs = listPullRequests(f.ctx, { repositoryId: f.repositoryId, state: 'open' });
    expect(prs.map((p) => [p.number, p.stackOrder])).toEqual([
      [one, 1],
      [two, 2],
      [three, 3],
    ]);
    expect(new Set(prs.map((p) => p.stackId)).size).toBe(1);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const get = (n: number) => showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    expect(get(one).state).toBe('merged');
    expect(get(two).state).toBe('open');
    expect(get(three).state).toBe('open');
    const upper = explainPullRequest(f.ctx, get(three).id, f.env).blockers.map((x) => x.code);
    expect(upper).toContain('STACK_PARENT_BLOCKED');
    expect(explainPullRequest(f.ctx, get(two).id, f.env).blockers.map((x) => x.code)).toContain('REVIEWS_REQUIRED');

    f.mock.approve(two);
    await tickUntilIdle(f);
    expect(get(two).state).toBe('merged');
    expect(get(three).state).toBe('merged');
    const order = all<{ pr_id: string }>(
      f.ctx.store.db,
      `SELECT pr_id FROM events WHERE type = 'pr.merged' ORDER BY seq`,
    ).map((r) => r.pr_id);
    expect(order).toEqual([get(one).id, get(two).id, get(three).id]);
    expect(mergeCalls(f)).toBe(3);
    const tree = await gitText(f.bare, ['ls-tree', '--name-only', '-r', 'refs/heads/main']);
    expect(tree).toContain('stack/c.ts');
  }, 60_000);

  test('AT-06: base advancing during validation invalidates the candidate before merge', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const advance = await f.pushBranch('upstream-change', { 'docs/notes.md': 'upstream\n' });
    const marker = `${f.ctx.root}/advanced`;
    f.config.validation.broad = [
      {
        name: 'advance-base-once',
        command: `test -f ${marker} || (git --git-dir=${f.bare} update-ref refs/heads/main ${advance} && touch ${marker})`,
        paths: [],
        timeout_seconds: 60,
      },
    ];
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await queueAll(f, [n]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const candidates = all<{ base_sha: string; status: string; invalid_reason: string | null }>(
      f.ctx.store.db,
      'SELECT base_sha, status, invalid_reason FROM integration_candidates ORDER BY created_at, rowid',
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.status).toBe('invalid');
    expect(candidates[0]!.invalid_reason).toStartWith('base_changed');
    expect(candidates[1]!.base_sha).toBe(advance);
    expect(candidates[1]!.status).toBe('merged');
    expect(mergeCalls(f)).toBe(1);
    const tree = await gitText(f.bare, ['ls-tree', '--name-only', '-r', 'refs/heads/main']);
    expect(tree).toContain('docs/notes.md');
    expect(tree).toContain('src/feature.ts');
  }, 60_000);

  test('AT-10: repeated identical failures quarantine one PR while others continue', async () => {
    fx = await createGitHubFixture({
      config: {
        agents: { max_retries_per_failure: 2 },
        validation: { broad: [{ name: 'unit', command: check('absent', 'fail.marker') }] },
      },
    });
    const f = fx;
    const bad = await openPull(f, 'bad', { 'fail.marker': 'x\n' });
    const good = await openPull(f, 'good', { 'src/good.ts': 'export const ok = true;\n' });
    await syncRepository(f.ctx, f.repositoryId, f.env);
    await requestIntegration(
      f.ctx,
      { repositoryId: f.repositoryId, number: bad, priority: 90, requestedBy: agent },
      f.env,
    );
    await requestIntegration(
      f.ctx,
      { repositoryId: f.repositoryId, number: good, priority: 10, requestedBy: agent },
      f.env,
    );
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: good }).state).toBe('merged');
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const badPr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: bad });
    const status = getQueueStatus(f.ctx, { repositoryId: f.repositoryId }, f.env);
    const entry = status.entries.find((e) => e.pr.id === badPr.id)!;
    expect(entry.entry.status).toBe('quarantined');
    const failures = all<{ attempts: number; failure_class: string }>(
      f.ctx.store.db,
      `SELECT attempts, failure_class FROM failure_records WHERE subject_id = ?`,
      badPr.id,
    );
    expect(failures).toEqual([{ attempts: 2, failure_class: 'test_failure' }]);
    const runs = all<{ n: number }>(
      f.ctx.store.db,
      `SELECT COUNT(*) AS n FROM validation_runs WHERE status = 'failed'`,
    );
    expect(runs[0]!.n).toBe(2);
    expect(
      all(f.ctx.store.db, `SELECT 1 FROM notifications WHERE pr_id = ? AND level = 'action_required'`, badPr.id),
    ).toHaveLength(1);
  }, 60_000);

  test('AT-11: rule changes recompute eligibility and approvals never go stale', async () => {
    fx = await createGitHubFixture({ autonomy: 'assisted', config: { integration: { auto_merge_eligible: false } } });
    const f = fx;
    f.mock.requireChecks('main', ['ci']);
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await queueAll(f, [n]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toEqual([
      'OPERATOR_MERGE_APPROVAL_REQUIRED',
    ]);
    expect(
      all(f.ctx.store.db, `SELECT 1 FROM approvals WHERE status = 'pending' AND subject_kind = 'merge'`),
    ).toHaveLength(1);
    decideMergeApproval(f.ctx, { prId: pr.id, approved: true }, operator);

    f.mock.requireChecks('main', ['ci', 'security-scan']);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(mergeCalls(f)).toBe(0);
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toEqual(['REQUIRED_CHECK_MISSING']);
    const observed = all<{ payload: string }>(
      f.ctx.store.db,
      `SELECT payload FROM events WHERE type = 'github.pr_observed'`,
    );
    expect(observed.some((e) => e.payload.includes('rules_changed'))).toBe(true);

    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 2;\n' });
    f.mock.passChecks(n, ['ci', 'security-scan']);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(mergeCalls(f)).toBe(0);
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toEqual([
      'OPERATOR_MERGE_APPROVAL_REQUIRED',
    ]);
    decideMergeApproval(f.ctx, { prId: pr.id, approved: true }, operator);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(showPullRequest(f.ctx, { prId: pr.id }).state).toBe('merged');
  }, 60_000);

  test('speculative grouping validates disjoint PRs together and checks tree equivalence between merges', async () => {
    fx = await createGitHubFixture({
      config: {
        scheduler: { integration_capacity_per_branch: 2 },
        validation: { broad: [{ name: 'smoke', command: check('present', '.') }] },
      },
    });
    const f = fx;
    const a = await openPull(f, 'a', { 'src/a.ts': 'export const a = 1;\n' });
    const b = await openPull(f, 'b', { 'src/b.ts': 'export const b = 1;\n' });
    await queueAll(f, [a, b]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const candidates = all<{ entries: string; status: string }>(
      f.ctx.store.db,
      'SELECT entries, status FROM integration_candidates',
    );
    expect(candidates).toHaveLength(1);
    expect((JSON.parse(candidates[0]!.entries) as unknown[]).length).toBe(2);
    expect(candidates[0]!.status).toBe('merged');
    expect(mergeCalls(f)).toBe(2);
  }, 60_000);

  test('GitHub-native stacks merge contiguously through the asynchronous merge API', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('n1', { 'stack/one.ts': '1\n' });
    await f.pushBranch('n2', { 'stack/two.ts': '2\n' }, 'n1');
    const one = f.mock.addPull({ headRef: 'n1', stack: { id: 77, position: 1, size: 2 } }).number;
    const two = f.mock.addPull({ headRef: 'n2', baseRef: 'n1', stack: { id: 77, position: 2, size: 2 } }).number;
    f.mock.passChecks(one);
    f.mock.passChecks(two);
    await queueAll(f, [one, two]);
    expect(listPullRequests(f.ctx, { repositoryId: f.repositoryId }).map((p) => [p.stackId, p.stackOrder])).toEqual([
      ['gh:77', 1],
      ['gh:77', 2],
    ]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(f.mock.countCalls('PUT', /merge-async$/)).toBe(1);
    expect(mergeCalls(f)).toBe(0);
    expect(listPullRequests(f.ctx, { repositoryId: f.repositoryId }).map((p) => p.state)).toEqual(['merged', 'merged']);
  }, 60_000);

  test('a stored rate limit pauses remote mutations until it resets', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await queueAll(f, [n]);
    f.ctx.store.db
      .query('UPDATE sync_state SET rate_limit_reset_at = ? WHERE key = ?')
      .run(new Date(Date.now() + 3_600_000).toISOString(), repositorySyncKey(f.repositoryId));
    const result = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env, sync: false });
    expect(result.offline).toBe(true);
    expect(mergeCalls(f)).toBe(0);
  }, 30_000);

  test('observe autonomy never merges', async () => {
    fx = await createGitHubFixture({ autonomy: 'observe', config: { integration: { auto_merge_eligible: false } } });
    const f = fx;
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await queueAll(f, [n]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(mergeCalls(f)).toBe(0);
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toContain('AUTONOMY_OBSERVE');
  }, 30_000);
});

describe('github-managed integration queue', () => {
  test('enqueues through the native merge queue and observes the merge', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    f.mock.enableMergeQueue('main');
    f.mock.requireChecks('main', ['ci']);
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await f.ctx.store.immediate((db) =>
      db
        .query(
          `INSERT INTO tasks (id, project_id, title, state, created_at, updated_at, state_changed_at) VALUES ('task_1', ?, 't', 'IN_REVIEW', 'x', 'x', 'x')`,
        )
        .run(f.projectId),
    );
    await queueAll(f, [n]);
    f.ctx.store.db.query(`UPDATE pull_requests SET task_id = 'task_1'`).run();
    const tick = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(tick.queues[0]!.mode).toBe('github-managed');
    expect(f.mock.countCalls('POST', 'EnqueuePullRequest')).toBe(1);
    expect(f.mock.mergeQueues.get('main')?.map((e) => e.number)).toEqual([n]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(f.mock.countCalls('POST', 'EnqueuePullRequest')).toBe(1);
    f.mock.processMergeQueue('main');
    const result = await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(result.sync?.merged).toEqual([expect.objectContaining({ number: n, outsideCrew: false })]);
    expect(mergeCalls(f)).toBe(0);
    expect(f.hookCalls.filter((h) => h.name === 'onMerged')).toHaveLength(1);
    await git(f.repo, ['fetch', '-q', 'origin']);
  }, 30_000);

  test('failing checks send the PR back for revision, and a fixed head merges', async () => {
    fx = await createGitHubFixture({ config: { agents: { max_retries_per_failure: 2 } } });
    const f = fx;
    const sha = await f.pushBranch('fix', { 'src/a.ts': 'export const a = 1;\n' });
    const pr = f.mock.addPull({ headRef: 'fix', baseRef: 'main' });
    f.mock.setCheck(sha, 'ci', 'failure');
    await queueAll(f, [pr.number]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number });
    const entryOf = () =>
      getQueueStatus(f.ctx, { repositoryId: f.repositoryId }, f.env).entries.find((e) => e.pr.id === record.id)!.entry;
    expect(entryOf().status).toBe('blocked');
    expect(entryOf().blockers.map((b) => b.code)).toEqual(['REVISION_REQUIRED']);

    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    expect(all(f.ctx.store.db, 'SELECT attempts FROM failure_records WHERE subject_id = ?', record.id)).toEqual([
      { attempts: 1 },
    ]);

    await f.pushBranch('fix', { 'src/a.ts': 'export const a = 2;\n' }, 'fix');
    f.mock.passChecks(pr.number);
    await syncRepository(f.ctx, f.repositoryId, f.env);
    await tickUntilIdle(f);
    expect(showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number }).state).toBe('merged');
  }, 60_000);

  test('failing checks on a high-risk PR without a review still send it back for revision', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const sha = await f.pushBranch('deps', { 'pkg/Cargo.toml': '[package]\nname = "pkg"\n' });
    const pr = f.mock.addPull({ headRef: 'deps', baseRef: 'main' });
    f.mock.setCheck(sha, 'ci', 'failure');
    await queueAll(f, [pr.number]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number });
    const entry = getQueueStatus(f.ctx, { repositoryId: f.repositoryId }, f.env).entries.find(
      (e) => e.pr.id === record.id,
    )!.entry;
    expect(entry.blockers.map((b) => b.code)).toEqual(['REVISION_REQUIRED']);
  }, 60_000);

  test('the same failing checks on a revised head quarantine the PR after the retry limit', async () => {
    fx = await createGitHubFixture({ config: { agents: { max_retries_per_failure: 2 } } });
    const f = fx;
    const sha = await f.pushBranch('fix', { 'src/a.ts': 'export const a = 1;\n' });
    const pr = f.mock.addPull({ headRef: 'fix', baseRef: 'main' });
    f.mock.setCheck(sha, 'ci', 'failure');
    await queueAll(f, [pr.number]);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });

    const again = await f.pushBranch('fix', { 'src/a.ts': 'export const a = 2;\n' }, 'fix');
    f.mock.setCheck(again, 'ci', 'failure');
    await syncRepository(f.ctx, f.repositoryId, f.env);
    await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
    const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number });
    const entry = getQueueStatus(f.ctx, { repositoryId: f.repositoryId }, f.env).entries.find(
      (e) => e.pr.id === record.id,
    )!.entry;
    expect(entry.status).toBe('quarantined');
    expect(all(f.ctx.store.db, 'SELECT attempts FROM failure_records WHERE subject_id = ?', record.id)).toEqual([
      { attempts: 2 },
    ]);
  }, 60_000);
});

describe('branches behind a strict base', () => {
  for (const rebasing of ['only_when_required', 'never'] as const) {
    test(`a branch behind a strict base is ${rebasing === 'never' ? 'left alone' : 'updated by GitHub'} when rebasing is ${rebasing}`, async () => {
      fx = await createGitHubFixture({ config: { integration: { rebasing } } });
      const f = fx;
      f.mock.requireChecks('main', ['ci'], true);
      const head = await f.pushBranch('behind', { 'src/b.ts': 'export const b = 1;\n' });
      const pr = f.mock.addPull({ headRef: 'behind', baseRef: 'main' });
      f.mock.passChecks(pr.number);
      await f.advanceBase({ 'docs/base.md': 'moved\n' });
      await queueAll(f, [pr.number]);
      const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number });
      setExpectedRemoteHead(f.ctx, record.id, head, agent);
      await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
      expect(explainPullRequest(f.ctx, record.id, f.env).blockers.map((b) => b.code)).toContain('BRANCH_BEHIND_BASE');
      await queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });
      await syncRepository(f.ctx, f.repositoryId, f.env);

      const updates = f.mock.countCalls('PUT', /\/pulls\/\d+\/update-branch$/);
      const after = showPullRequest(f.ctx, { prId: record.id });
      if (rebasing === 'never') {
        expect(updates).toBe(0);
        expect(after.headSha).toBe(head);
        return;
      }
      expect(updates).toBe(1);
      const merged = f.mock.branchSha('behind')!;
      expect(merged).not.toBe(head);
      expect(after).toMatchObject({ headSha: merged, expectedRemoteHead: merged, externalDivergence: null });
    }, 60_000);
  }
});

describe('queue routing', () => {
  const entryFor = (f: GitHubFixture, number: number) => {
    const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number });
    return getQueueStatus(f.ctx, { repositoryId: f.repositoryId }, f.env).entries.find((e) => e.pr.id === record.id)!
      .entry;
  };
  const tick = (f: GitHubFixture) => queueTick(f.ctx, f.repositoryId, { leaderId: 'leader-1', env: f.env });

  test('failing checks are revised while reviews and merge approval are still outstanding', async () => {
    fx = await createGitHubFixture({ config: { integration: { auto_merge_eligible: false } } });
    const f = fx;
    f.mock.requireReviews('main', 1);
    const sha = await f.pushBranch('fix', { 'src/a.ts': 'export const a = 1;\n' });
    const pr = f.mock.addPull({ headRef: 'fix', baseRef: 'main' });
    f.mock.setCheck(sha, 'ci', 'failure');
    await queueAll(f, [pr.number]);
    await tick(f);
    expect(entryFor(f, pr.number).blockers.map((b) => b.code)).toEqual(['REVISION_REQUIRED']);
  }, 30_000);

  test('blockers only an operator can resolve raise one intervention', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    f.mock.requireReviews('main', 1);
    const n = await openPull(f, 'feature', { 'src/feature.ts': 'export const f = 1;\n' });
    await queueAll(f, [n]);
    await tick(f);
    await tick(f);
    expect(entryFor(f, n).blockers.map((b) => b.code)).toContain('REVIEWS_REQUIRED');
    expect(
      all(f.ctx.store.db, 'SELECT body FROM notifications WHERE title = ?', `PR #${n} needs operator action`),
    ).toEqual([{ body: '- 0/1 required approvals' }]);
  }, 30_000);

  test('a failing check that turns green on the same head leaves revision without a new failure', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const sha = await f.pushBranch('fix', { 'src/a.ts': 'export const a = 1;\n' });
    const pr = f.mock.addPull({ headRef: 'fix', baseRef: 'main' });
    f.mock.setCheck(sha, 'ci', 'failure');
    await queueAll(f, [pr.number]);
    await tick(f);
    expect(entryFor(f, pr.number).blockers.map((b) => b.code)).toEqual(['REVISION_REQUIRED']);
    f.mock.setCheck(sha, 'ci', 'success');
    await syncRepository(f.ctx, f.repositoryId, f.env);
    await tickUntilIdle(f);
    expect(showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: pr.number }).state).toBe('merged');
    expect(all(f.ctx.store.db, 'SELECT attempts FROM failure_records')).toEqual([{ attempts: 1 }]);
  }, 60_000);

  test('a high-risk PR without a review on its head requests one, and a failed review asks an operator', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    const n = await openPull(f, 'deps', { 'pkg/Cargo.toml': '[package]\nname = "pkg"\n' });
    await queueAll(f, [n]);
    await tick(f);
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    const requested = () => f.hookCalls.filter((h) => h.name === 'onReviewRequired').map((h) => h.event.headSha);
    expect(requested()).toEqual([pr.headSha]);

    const failing: Reviewer = {
      identity: 'broken',
      model: null,
      promptVersion: 'p1',
      review: () => Promise.reject(new Error('reviewer crashed')),
    };
    await requestReview(
      f.ctx,
      { repositoryId: f.repositoryId, prId: pr.id, commitSha: pr.headSha, baseSha: 'base', patch: '', types: ['code'] },
      { reviewers: { code: failing }, config: f.config },
    );
    await tick(f);
    await tick(f);
    expect(requested()).toEqual([pr.headSha]);
    expect(
      all(f.ctx.store.db, 'SELECT 1 FROM notifications WHERE title = ?', `Crewyard review failed for PR #${n}`),
    ).toHaveLength(1);
  }, 30_000);
});
