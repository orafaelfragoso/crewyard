import { afterEach, expect, test } from 'bun:test';
import { CrewError, gitText, nowIso } from '@crewyard/core';
import {
  buildAndValidateCandidate,
  createCandidate,
  decideMergeApproval,
  enqueueOrReviveInTx,
  fetchIntegrationRefs,
  type MergeIntent,
  mutationExpectedState,
  processIntegrationOutbox,
  queueById,
  requestIntegration,
  setPullRequestDependency,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { getRepository } from '@crewyard/projects';
import { acquireLeadership, all, claimDueOutbox, getOutbox } from '@crewyard/storage';
import { ManualClock } from '../helpers/index.ts';
import { createGitHubFixture, type GitHubFixture } from '../integration/github-fixture.ts';

let fixture: GitHubFixture | undefined;
afterEach(() => fixture?.cleanup());
const actor = { kind: 'operator' as const, id: 'tester' };

async function queuedMutation(retry: boolean) {
  const clock = new ManualClock(new Date());
  const f = await createGitHubFixture({
    clock,
    config: { validation: { broad: [{ name: 'prefix', command: 'test -f feature' }] } },
  });
  fixture = f;
  await f.pushBranch('feature', { feature: 'yes' });
  const pull = f.mock.addPull({ headRef: 'feature' });
  f.mock.passChecks(pull.number);
  await syncRepository(f.ctx, f.repositoryId, f.env);
  const { entry } = await requestIntegration(
    f.ctx,
    { repositoryId: f.repositoryId, number: pull.number, requestedBy: actor },
    f.env,
  );
  const pr = showPullRequest(f.ctx, { prId: entry.prId });
  const queue = queueById(f.ctx.store.db, entry.queueId)!;
  const baseSha = await fetchIntegrationRefs(
    f.ctx,
    getRepository(f.ctx, f.repositoryId),
    await gitText(f.repo, ['rev-parse', 'main']),
    [pr],
    actor,
  );
  const created = createCandidate(
    f.ctx,
    {
      queueId: queue.id,
      baseSha,
      group: [{ pr, entry }],
      policyRevision: 1,
      rulesFingerprint: pr.governance!.requirements!.fingerprint,
    },
    actor,
    600,
  );
  const { candidate } = await buildAndValidateCandidate(f.ctx, created.id, {
    repository: getRepository(f.ctx, f.repositoryId),
    config: f.config,
    actor,
    hooks: [],
  });
  expect(candidate.status).toBe('valid');
  const lease = acquireLeadership(
    f.ctx.store,
    `integration:${f.repositoryId}:main`,
    retry ? 'dead-worker' : 'worker',
    60,
  )!;
  const intent: MergeIntent = {
    repositoryId: f.repositoryId,
    prId: pr.id,
    number: pr.number,
    headSha: pr.headSha,
    baseRef: 'main',
    expectedBaseSha: baseSha,
    mergeMethod: 'squash',
    candidateId: candidate.id,
    entryId: entry.id,
    retargetBase: null,
  };
  const op = f.ctx.store.immediate((db) =>
    enqueueOrReviveInTx(
      db,
      {
        kind: 'github.merge',
        subjectId: pr.id,
        intent,
        expectedState: mutationExpectedState(db, f.config, queue, [pr], baseSha, candidate.id),
        idempotencyKey: `guard:${pr.id}`,
        leaderGeneration: lease.generation,
      },
      nowIso(clock),
    ),
  );
  if (retry) {
    claimDueOutbox(f.ctx.store, { ownerId: 'dead-worker', limit: 1, kinds: ['github.merge'], ttlSeconds: 60 });
    clock.advance(61);
  }
  return { f, clock, pr, entry, queue, candidate, op };
}

type Prepared = Awaited<ReturnType<typeof queuedMutation>>;
const changes: [string, (p: Prepared) => void | Promise<void>][] = [
  [
    'base moved',
    async ({ f }) => {
      await f.advanceBase({ upstream: 'yes' });
    },
  ],
  [
    'head moved',
    async ({ f }) => {
      await f.pushBranch('feature', { feature: 'new' });
    },
  ],
  [
    'target changed',
    ({ f, pr }) => {
      f.mock.pull(pr.number).baseRef = 'feature';
    },
  ],
  [
    'policy revision changed',
    ({ f }) => {
      f.ctx.store.db.query('UPDATE projects SET policy_revision = policy_revision + 1 WHERE id = ?').run(f.projectId);
    },
  ],
  [
    'configuration changed',
    ({ f }) => {
      f.config.validation.broad[0]!.command = 'false';
    },
  ],
  [
    'candidate expired',
    ({ f, candidate }) => {
      f.ctx.store.db
        .query("UPDATE integration_candidates SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
        .run(candidate.id);
    },
  ],
  [
    'candidate invalidated',
    ({ f, candidate }) => {
      f.ctx.store.db.query("UPDATE integration_candidates SET status = 'invalid' WHERE id = ?").run(candidate.id);
    },
  ],
  [
    'prefix evidence removed',
    ({ f, candidate }) => {
      f.ctx.store.db.query("UPDATE integration_candidates SET ci_evidence = '{}' WHERE id = ?").run(candidate.id);
    },
  ],
  [
    'queue paused',
    ({ f, queue }) => {
      f.ctx.store.db.query('UPDATE integration_queues SET paused = 1 WHERE id = ?').run(queue.id);
    },
  ],
  [
    'queue mode changed',
    ({ f, queue }) => {
      f.ctx.store.db.query("UPDATE integration_queues SET mode = 'github-managed' WHERE id = ?").run(queue.id);
    },
  ],
  [
    'observe autonomy',
    ({ f }) => {
      f.ctx.store.db.query("UPDATE projects SET autonomy = 'observe' WHERE id = ?").run(f.projectId);
    },
  ],
  [
    'approval now required',
    ({ f }) => {
      f.ctx.store.db.query("UPDATE projects SET autonomy = 'assisted' WHERE id = ?").run(f.projectId);
    },
  ],
  [
    'approval revoked',
    ({ f, pr }) => {
      f.ctx.store.db.query("UPDATE projects SET autonomy = 'assisted' WHERE id = ?").run(f.projectId);
      decideMergeApproval(f.ctx, { prId: pr.id, approved: true }, actor);
      decideMergeApproval(f.ctx, { prId: pr.id, approved: false }, actor);
    },
  ],
  [
    'checks now failing',
    ({ f, pr }) => {
      f.mock.setCheck(pr.headSha, 'failure', 'failure');
    },
  ],
  [
    'rules changed',
    ({ f }) => {
      f.mock.requireReviews('main', 1);
    },
  ],
  [
    'divergence unresolved',
    ({ f, pr }) => {
      f.ctx.store.db
        .query('UPDATE pull_requests SET external_divergence = ? WHERE id = ?')
        .run(JSON.stringify({ blocking: true, detail: 'external push', kinds: ['external_push'] }), pr.id);
    },
  ],
  [
    'new unmet dependency',
    async ({ f, pr }) => {
      await f.pushBranch('dependency', { dependency: 'yes' });
      const dep = f.mock.addPull({ headRef: 'dependency' });
      await syncRepository(f.ctx, f.repositoryId, f.env);
      const record = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: dep.number });
      setPullRequestDependency(f.ctx, { prId: pr.id, dependsOnPrId: record.id }, actor);
    },
  ],
];

for (const retry of [false, true]) {
  for (const [label, change] of changes) {
    test(`${retry ? 'retry' : 'first delivery'} refuses mutation after ${label}`, async () => {
      const prepared = await queuedMutation(retry);
      await change(prepared);
      const { f, op } = prepared;
      await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env });
      expect(f.mock.countCalls('PUT', /\/merge$/)).toBe(0);
      expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('cancelled');
      expect(all(f.ctx.store.db, "SELECT 1 FROM events WHERE type = 'integration.mutation_refused'")).toHaveLength(1);
    }, 30_000);
  }
}

test('stale validation cannot prevent adopting an already observed remote merge', async () => {
  const { f, candidate, op, pr } = await queuedMutation(true);
  f.mock.mergeExternally(pr.number);
  f.ctx.store.db
    .query("UPDATE integration_candidates SET status = 'invalid', integration_validated = 0 WHERE id = ?")
    .run(candidate.id);
  f.ctx.store.db.query("UPDATE projects SET autonomy = 'observe' WHERE id = ?").run(f.projectId);
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env });
  expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('succeeded');
  expect(showPullRequest(f.ctx, { prId: pr.id }).state).toBe('merged');
  expect(
    all(f.ctx.store.db, 'SELECT status, integration_validated FROM integration_candidates WHERE id = ?', candidate.id),
  ).toEqual([{ status: 'invalid', integration_validated: 0 }]);
  expect(f.mock.countCalls('PUT', /\/merge$/)).toBe(0);
}, 30_000);

test('a base race inside the host merge request is detected afterward and pauses later local merges', async () => {
  const { f, op, pr, queue } = await queuedMutation(false);
  const upstream = await f.pushBranch('upstream', { upstream: 'yes' });
  const client = f.env.github!(getRepository(f.ctx, f.repositoryId));
  const merge = client.mergePullRequest.bind(client);
  client.mergePullRequest = async (number, input) => {
    f.mock.setBranch('main', upstream);
    return merge(number, input);
  };
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env });
  expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('succeeded');
  expect(showPullRequest(f.ctx, { prId: pr.id }).state).toBe('merged');
  expect(queueById(f.ctx.store.db, queue.id)!.paused).toBe(true);
  const incidents = all<{ payload: string }>(
    f.ctx.store.db,
    "SELECT payload FROM events WHERE type = 'integration.merge_tree_observed'",
  );
  expect(incidents).toHaveLength(1);
  expect(JSON.parse(incidents[0]!.payload)).toMatchObject({
    repositoryId: f.repositoryId,
    prId: pr.id,
    matched: false,
    mergeCommitSha: f.mock.pull(pr.number).mergeCommitSha,
  });
}, 30_000);

test('expired delivery and leadership cannot mutate or settle after the final remote observation', async () => {
  const { f, clock, op } = await queuedMutation(false);
  const client = f.env.github!(getRepository(f.ctx, f.repositoryId));
  const getBranch = client.getBranch.bind(client);
  client.getBranch = async (branch) => {
    const observed = await getBranch(branch);
    clock.advance(121);
    acquireLeadership(f.ctx.store, `integration:${f.repositoryId}:main`, 'successor', 120);
    return observed;
  };
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env, limit: 1 });
  expect(f.mock.countCalls('PUT', /\/merge$/)).toBe(0);
  expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('attempted');
}, 30_000);

for (const kind of ['github.enqueue', 'github.merge_async', 'github.update_pr'] as const) {
  test(`${kind} rechecks queue pause on the mutation boundary`, async () => {
    const { f, op, queue, pr, clock } = await queuedMutation(false);
    const intent =
      kind === 'github.update_pr'
        ? { repositoryId: f.repositoryId, prId: pr.id, number: pr.number, patch: { base: 'main' } }
        : kind === 'github.merge_async'
          ? { ...op.intent, action: 'direct_merge', prIds: [pr.id] }
          : op.intent;
    if (kind === 'github.update_pr') {
      f.mock.pull(pr.number).baseRef = 'upstream';
      await f.pushBranch('upstream', { upstream: 'yes' });
      f.ctx.store.db.query("UPDATE pull_requests SET base_ref = 'upstream' WHERE id = ?").run(pr.id);
    }
    const current = showPullRequest(f.ctx, { prId: pr.id });
    const state = mutationExpectedState(
      f.ctx.store.db,
      f.config,
      queue,
      [current],
      String(op.expectedState.baseSha),
      kind === 'github.update_pr' ? null : String(op.intent.candidateId),
    );
    f.ctx.store.db
      .query('UPDATE outbox SET kind = ?, intent = ?, expected_state = ? WHERE operation_id = ?')
      .run(kind, JSON.stringify(intent), JSON.stringify(state), op.operationId);
    f.ctx.store.db
      .query('UPDATE integration_queues SET paused = 1, updated_at = ? WHERE id = ?')
      .run(nowIso(clock), queue.id);
    await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env });
    expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('cancelled');
    expect(f.mock.countCalls('PUT', /merge/)).toBe(0);
    expect(f.mock.countCalls('PATCH', /\/pulls\//)).toBe(0);
    expect(f.mock.countCalls('POST', 'EnqueuePullRequest')).toBe(0);
  }, 30_000);
}

test('a known async operation is polled after read failure without resubmitting the stack', async () => {
  const { f, clock, op, pr } = await queuedMutation(false);
  const client = f.env.github!(getRepository(f.ctx, f.repositoryId));
  f.ctx.store.db
    .query('UPDATE outbox SET kind = ?, intent = ? WHERE operation_id = ?')
    .run(
      'github.merge_async',
      JSON.stringify({ ...op.intent, action: 'direct_merge', prIds: [pr.id] }),
      op.operationId,
    );
  let sends = 0;
  let polls = 0;
  client.mergePullRequestAsync = async () => {
    sends++;
    return {
      status: 'pending',
      uuid: 'known-operation',
      sha: null,
      message: null,
      expectedHeadSha: pr.headSha,
      action: 'direct_merge',
    };
  };
  client.getAsyncMergeResult = async () => {
    polls++;
    if (polls === 1) throw new CrewError('OFFLINE', 'temporary result read failure');
    return {
      status: 'pending',
      uuid: 'known-operation',
      sha: null,
      message: null,
      expectedHeadSha: pr.headSha,
      action: 'direct_merge',
    };
  };
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env, limit: 1 });
  clock.advance(61);
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env, limit: 1 });
  expect(sends).toBe(1);
  expect(polls).toBeGreaterThan(1);
  expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('ambiguous');
}, 30_000);

test('partial stack landing adopts the historical prefix and holds the unknown remainder', async () => {
  const { f, clock, op, pr, entry, queue } = await queuedMutation(false);
  f.mock.pull(pr.number).stack = { id: 77, position: 1, size: 2 };
  await f.pushBranch('upper', { upper: 'yes' }, 'feature');
  const upper = f.mock.addPull({ headRef: 'upper', baseRef: 'feature', stack: { id: 77, position: 2, size: 2 } });
  f.mock.passChecks(upper.number);
  await syncRepository(f.ctx, f.repositoryId, f.env);
  const { entry: upperEntry } = await requestIntegration(
    f.ctx,
    { repositoryId: f.repositoryId, number: upper.number, requestedBy: actor },
    f.env,
  );
  const current = showPullRequest(f.ctx, { prId: pr.id });
  const upperPr = showPullRequest(f.ctx, { prId: upperEntry.prId });
  const candidate = createCandidate(
    f.ctx,
    {
      queueId: queue.id,
      baseSha: String(op.expectedState.baseSha),
      group: [
        { entry, pr: current },
        { entry: upperEntry, pr: upperPr },
      ],
      policyRevision: 1,
      rulesFingerprint: current.governance!.requirements!.fingerprint,
    },
    actor,
    600,
  );
  await buildAndValidateCandidate(f.ctx, candidate.id, {
    repository: getRepository(f.ctx, f.repositoryId),
    config: f.config,
    actor,
    hooks: [],
  });
  const intent = {
    ...op.intent,
    candidateId: candidate.id,
    prId: upperPr.id,
    number: upperPr.number,
    headSha: upperPr.headSha,
    action: 'direct_merge',
    prIds: [pr.id, upperPr.id],
  };
  const expected = mutationExpectedState(
    f.ctx.store.db,
    f.config,
    queue,
    [current, upperPr],
    candidate.baseSha,
    candidate.id,
  );
  f.ctx.store.db
    .query('UPDATE outbox SET kind = ?, intent = ?, expected_state = ? WHERE operation_id = ?')
    .run('github.merge_async', JSON.stringify(intent), JSON.stringify(expected), op.operationId);
  f.mock.mergeExternally(pr.number);
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env, limit: 1 });
  expect(showPullRequest(f.ctx, { prId: pr.id }).state).toBe('merged');
  expect(showPullRequest(f.ctx, { prId: upperPr.id }).state).toBe('open');
  expect(getOutbox(f.ctx.store.db, op.operationId)!.status).toBe('ambiguous');
  expect(all(f.ctx.store.db, 'SELECT status FROM queue_entries WHERE id = ?', upperEntry.id)).toEqual([
    { status: 'merging' },
  ]);
  clock.advance(6);
  await processIntegrationOutbox(f.ctx, { leaderId: 'worker', env: f.env, limit: 1 });
  expect(all(f.ctx.store.db, "SELECT 1 FROM events WHERE type = 'pr.merged' AND pr_id = ?", pr.id)).toHaveLength(1);
  expect(f.mock.countCalls('PUT', /merge/)).toBe(0);
}, 30_000);
