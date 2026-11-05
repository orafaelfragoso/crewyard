import { afterEach, expect, test } from 'bun:test';
import {
  decideMergeApproval,
  explainPullRequest,
  queueTick,
  requestIntegration,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { collectPatch, type ReviewContext, requestReview, StaticAnalysisReviewer } from '@crewyard/reviews';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

let fixture: GitHubFixture | undefined;
afterEach(() => fixture?.cleanup());
const actor = { kind: 'operator' as const, id: 'tester' };

test('fresh integration eligibility rejects a review when provider context changes on the same Git head', async () => {
  const f = await createGitHubFixture();
  fixture = f;
  const head = await f.pushBranch('context', { 'src/auth/session.ts': 'export const session = 1;\n' });
  const remote = f.mock.addPull({ headRef: 'context' });
  f.mock.passChecks(remote.number);
  await syncRepository(f.ctx, f.repositoryId, f.env);
  const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: remote.number });
  let current: ReviewContext = {
    contentFingerprint: 'context-A',
    dependencyFingerprint: null,
    interfaceFingerprint: null,
    symbolGraphRevision: null,
    coverage: {
      kind: 'whole-tree',
      depth: null,
      limit: null,
      truncated: false,
      missingPaths: [],
      unresolvedImports: [],
    },
  };
  const reviewer = new StaticAnalysisReviewer();
  f.env.reviewContext = () => current;
  f.env.reviewAcceptance = () => ({ code: reviewer });
  await requestReview(
    f.ctx,
    {
      repositoryId: f.repositoryId,
      prId: pr.id,
      commitSha: head,
      baseSha: pr.baseSha!,
      patch: await collectPatch(f.repo, pr.baseSha!, head),
      types: ['code'],
    },
    { config: f.config, reviewers: { code: reviewer }, context: { collect: async () => current } },
  );
  await requestIntegration(f.ctx, { prId: pr.id, requestedBy: actor }, f.env);
  decideMergeApproval(f.ctx, { prId: pr.id, approved: true }, actor);
  expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).not.toContain(
    'HIGH_RISK_REVIEW_REQUIRED',
  );
  current = { ...current, contentFingerprint: 'context-B' };
  expect(explainPullRequest(f.ctx, pr.id, f.env).blockers.map((b) => b.code)).toContain('HIGH_RISK_REVIEW_REQUIRED');
  await queueTick(f.ctx, f.repositoryId, { leaderId: 'worker', env: f.env });
  expect(f.mock.countCalls('PUT', /merge/)).toBe(0);
}, 30_000);
