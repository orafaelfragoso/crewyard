import { afterEach, describe, expect, test } from 'bun:test';
import { type MergeHealthObservation, mergeHealthState, recordMergeHealth } from '@crewyard/application';
import type { BranchRequirements, CheckResult } from '@crewyard/github';
import { computeMetrics } from '@crewyard/telemetry';
import { createTestContext, type TestContext } from '../../helpers/index.ts';
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
  return { repositoryId, mergeCommitSha: sha, currentBaseSha: sha, requirements, checks, actor: operator };
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
    const f = fixture('observe');
    const obs = observation(f.repositoryId, [check('failure')]);
    expect(recordMergeHealth(f.ctx, obs, f.env)).toMatchObject({ state: 'failed', repairTaskId: null });
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
