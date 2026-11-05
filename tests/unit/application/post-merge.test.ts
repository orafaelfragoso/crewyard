import { afterEach, describe, expect, test } from 'bun:test';
import {
  type MergeHealthObservation,
  mergeHealthState,
  recordMergeHealth,
  scanPostMergeHealth,
} from '@crewyard/application';
import { git } from '@crewyard/core';
import { type BranchRequirements, type CheckResult, GitHubClient, staticTokenProvider } from '@crewyard/github';
import { computeMetrics, overviewProjection } from '@crewyard/telemetry';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
import { startMockGitHub } from '../../helpers/mock-github.ts';
import { operator, seedProject, testConfig } from '../tasks/fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());
const sha = 'a'.repeat(40);
const requirements: BranchRequirements = {
  branch: 'main',
  requiredChecks: [{ context: 'ci', appId: 1 }],
  strictChecks: true,
  requiredApprovals: 1,
  requireCodeOwnerReview: false,
  dismissStaleReviews: false,
  requireLastPushApproval: false,
  requireThreadResolution: false,
  requireLinearHistory: false,
  allowedMergeMethods: ['squash'],
  mergeQueue: null,
  sources: ['ruleset'],
  protectionVisible: true,
  fingerprint: 'rules',
};
function check(state: CheckResult['state']): CheckResult {
  return { name: 'ci', kind: 'check_run', state, appId: 1, headSha: sha, detailsUrl: null };
}
function observation(repositoryId: string, checks: CheckResult[]): MergeHealthObservation {
  return {
    repositoryId,
    mergeCommitSha: sha,
    baseBranch: 'main',
    currentBaseSha: sha,
    requirements,
    checks,
    actor: operator,
  };
}
function fixture(autonomy: 'observe' | 'guarded') {
  ctx = createTestContext();
  const { projectId, repositoryId } = seedProject(ctx, { autonomy });
  const at = ctx.clock.now().toISOString();
  ctx.store.db
    .query(`INSERT INTO pull_requests
    (id, repository_id, number, title, head_ref, head_sha, base_ref, state, merge_commit_sha, merged_at, created_at, updated_at)
    VALUES ('pr', ?, 1, 'change', 'topic', 'head', 'main', 'merged', ?, ?, ?, ?)`)
    .run(repositoryId, sha, at, at, at);
  return { ctx, projectId, repositoryId, env: { config: testConfig({ project: { name: 'sample', autonomy } }) } };
}

describe('post-merge health', () => {
  test('scans each observed target branch with its own SHA, requirements and repair base', async () => {
    const f = fixture('guarded');
    f.ctx.store.db.query("UPDATE pull_requests SET base_ref = 'release' WHERE id = 'pr'").run();
    const mock = startMockGitHub();
    try {
      await git(f.ctx.root, ['init', '-q']);
      await git(f.ctx.root, ['remote', 'add', 'origin', `https://github.com/${mock.owner}/${mock.name}.git`]);
      f.ctx.store.db
        .query(
          'UPDATE repositories SET canonical_path = ?, remote_host = ?, remote_owner = ?, remote_name = ? WHERE id = ?',
        )
        .run(f.ctx.root, 'github.com', mock.owner, mock.name, f.repositoryId);
      mock.setBranch('main', 'b'.repeat(40));
      mock.setBranch('release', sha);
      mock.requireChecks('release', ['release-ci']);
      mock.setCheck(sha, 'release-ci', 'failure');
      const client = new GitHubClient({
        repository: { host: 'github.com', owner: mock.owner, name: mock.name },
        token: staticTokenProvider(mock.token),
        baseUrl: mock.url,
      });
      const result = await scanPostMergeHealth(
        f.ctx,
        { repositoryId: f.repositoryId, actor: operator, limit: 10 },
        { ...f.env, github: () => client },
      );
      expect(result).toEqual([expect.objectContaining({ state: 'failed', repairTaskId: expect.any(String) })]);
      expect(f.ctx.store.db.query('SELECT base_branch FROM tasks').get()).toEqual({ base_branch: 'release' });
      f.ctx.store.db
        .query(`INSERT INTO pull_requests
        (id, repository_id, number, title, head_ref, head_sha, base_ref, state, merge_commit_sha, merged_at, created_at, updated_at)
        SELECT 'gone', repository_id, 2, title, head_ref, head_sha, 'deleted-target', state, merge_commit_sha, merged_at, created_at, updated_at FROM pull_requests WHERE id = 'pr'`)
        .run();
      const repeated = await scanPostMergeHealth(
        f.ctx,
        { repositoryId: f.repositoryId, actor: operator, limit: 10 },
        { ...f.env, github: () => client },
      );
      expect(repeated.map((result) => result.state).sort()).toEqual(['branch_unavailable', 'failed']);
    } finally {
      mock.stop();
    }
  });

  test('requires complete commit-bound required checks and visible protection before declaring success', () => {
    const obs = observation('repo', [check('success')]);
    expect(mergeHealthState(obs)).toBe('passed');
    expect(mergeHealthState({ ...obs, checks: [] })).toBe('unknown');
    expect(mergeHealthState({ ...obs, checks: [check('pending')] })).toBe('pending');
    expect(mergeHealthState({ ...obs, checks: [check('failure')] })).toBe('failed');
    expect(mergeHealthState({ ...obs, requirements: null })).toBe('unknown');
    expect(mergeHealthState({ ...obs, requirements: { ...requirements, protectionVisible: false } })).toBe('unknown');
    expect(mergeHealthState({ ...obs, requirements: { ...requirements, requiredChecks: [] } })).toBe('unknown');
    expect(mergeHealthState({ ...obs, checks: [{ ...check('success'), appId: 2 }] })).toBe('unknown');
    expect(mergeHealthState({ ...obs, currentBaseSha: 'b'.repeat(40) })).toBe('superseded');
    expect(mergeHealthState({ ...obs, currentBaseSha: null })).toBe('branch_unavailable');
    expect(() => mergeHealthState({ ...obs, requirements: { ...requirements, branch: 'release' } })).toThrow(
      'observed target branch',
    );
    expect(() => mergeHealthState({ ...obs, checks: [{ ...check('success'), headSha: 'other' }] })).toThrow(
      'observed merge commit',
    );
  });

  test('repeated failure observations create one approved-workflow draft and one alert', () => {
    const f = fixture('guarded');
    const obs = observation(f.repositoryId, [check('failure')]);
    const first = recordMergeHealth(f.ctx, obs, f.env);
    const second = recordMergeHealth(f.ctx, obs, f.env);
    expect(first.state).toBe('failed');
    expect(first.repairTaskId).toBeString();
    expect(second).toEqual({ ...first, changed: false });
    expect(overviewProjection(f.ctx, f.projectId).alerts).toEqual([
      expect.objectContaining({ prId: 'pr', taskId: first.repairTaskId }),
    ]);
    expect(f.ctx.store.db.query('SELECT state, risk, origin_ref FROM tasks').all()).toEqual([
      { state: 'DRAFT', risk: 'high', origin_ref: `postmerge:${first.incidentId}` },
    ]);
    expect(
      f.ctx.store.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'postmerge.intervention_required'").get(),
    ).toEqual({ n: 1 });
    expect(
      f.ctx.store.db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'postmerge.intervention'").get(),
    ).toEqual({ n: 1 });
    expect(recordMergeHealth(f.ctx, { ...obs, checks: [check('success')] }, f.env)).toMatchObject({
      state: 'passed',
      changed: true,
      repairTaskId: first.repairTaskId,
    });
    expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  test('observe mode emits an actionable alert without admitting repair work; superseded commits do not open repairs', () => {
    const f = fixture('guarded');
    f.ctx.store.db.query("UPDATE projects SET autonomy = 'observe' WHERE id = ?").run(f.projectId);
    const obs = observation(f.repositoryId, [check('failure')]);
    expect(recordMergeHealth(f.ctx, obs, f.env)).toMatchObject({ state: 'failed', repairTaskId: null });
    recordMergeHealth(f.ctx, obs, f.env);
    expect(overviewProjection(f.ctx, f.projectId).alerts).toHaveLength(1);
    expect(recordMergeHealth(f.ctx, { ...obs, currentBaseSha: 'b'.repeat(40) }, f.env)).toMatchObject({
      state: 'superseded',
      repairTaskId: null,
    });
    expect(f.ctx.store.db.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  test('records each provider check execution once and does not label partial observation as total hosted CI', () => {
    const f = fixture('guarded');
    const timed = {
      ...check('success'),
      execution: { id: 12, startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:02:00Z' },
    };
    const obs = observation(f.repositoryId, [timed]);
    recordMergeHealth(f.ctx, obs, f.env);
    recordMergeHealth(f.ctx, obs, f.env);
    const metrics = computeMetrics(f.ctx, { projectId: f.projectId });
    expect(metrics.observedHostedCheckMinutes).toEqual({ status: 'measured', value: 2 });
    expect(metrics.hostedCiMinutesPerMerge.status).toBe('unknown');
    expect(
      f.ctx.store.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'postmerge.check_recorded'").get(),
    ).toEqual({ n: 1 });
    expect(() =>
      recordMergeHealth(
        f.ctx,
        observation(f.repositoryId, [{ ...timed, execution: { ...timed.execution, id: 13, completedAt: 'invalid' } }]),
        f.env,
      ),
    ).toThrow('invalid check execution timestamps');
  });
});
