import { describe, expect, test } from 'bun:test';
import { crewConfigSchema } from '@crewyard/config';
import type { BranchRequirements } from '@crewyard/github';
import {
  type EligibilityInput,
  evaluateEligibility,
  type OrderItem,
  orderQueue,
  type PullRequestRecord,
  type QueueEntry,
  selectGroup,
} from '@crewyard/integration';

const config = crewConfigSchema.parse({ version: 1, project: { name: 'p' } });

const requirements: BranchRequirements = {
  branch: 'main',
  requiredChecks: [{ context: 'ci', appId: null }],
  strictChecks: false,
  requiredApprovals: 1,
  requireCodeOwnerReview: true,
  dismissStaleReviews: false,
  requireLastPushApproval: false,
  requireThreadResolution: false,
  requireLinearHistory: false,
  allowedMergeMethods: null,
  mergeQueue: null,
  sources: ['ruleset'],
  protectionVisible: true,
  fingerprint: 'rules-1',
};

function pr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    id: 'pr_1',
    repositoryId: 'repo_1',
    number: 1,
    taskId: null,
    url: null,
    title: 't',
    author: 'a',
    headRef: 'feature',
    headSha: 'h1',
    baseRef: 'main',
    baseSha: 'b1',
    expectedRemoteHead: null,
    state: 'open',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    checksState: 'success',
    checks: [{ name: 'ci', kind: 'check_run', state: 'success', appId: null, headSha: 'h1', detailsUrl: null }],
    reviews: [{ id: '1', reviewer: 'r', state: 'APPROVED', commitSha: 'h1', submittedAt: null }],
    governance: {
      requirements,
      integrationBase: 'main',
      nodeId: 'n',
      isInMergeQueue: false,
      mergeQueueEntry: null,
      stack: null,
      workflowRuns: [],
    },
    changedFiles: [
      { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, blobSha: null },
    ],
    mergeCommitSha: null,
    mergedAt: null,
    stackId: null,
    stackOrder: null,
    imported: false,
    externalDivergence: null,
    remoteUpdatedAt: null,
    lastSyncedAt: '2026-11-02T12:00:00Z',
    createdAt: '2026-11-02T12:00:00Z',
    updatedAt: '2026-11-02T12:00:00Z',
    ...overrides,
  };
}

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    pr: pr(),
    autonomy: 'autopilot',
    config,
    mode: 'crew-managed',
    mergeApproved: false,
    reviews: { commitSha: 'h1', byType: { code: null, security: null, integration: null }, blockingFindings: 0 },
    parents: [],
    entryStatus: 'waiting',
    queuePaused: false,
    freshness: {
      key: 'k',
      lastSuccessAt: '2026-11-02T12:00:00Z',
      lastAttemptAt: null,
      lastError: null,
      offline: false,
      rateLimitResetAt: null,
    },
    ...overrides,
  };
}

const codes = (i: EligibilityInput) => evaluateEligibility(i).blockers.map((b) => b.code);

describe('eligibility', () => {
  test('a fully satisfied PR is eligible', () => {
    expect(evaluateEligibility(input())).toMatchObject({ eligible: true, blockers: [], risk: 'low' });
  });

  test('a passing AI review never waives a failing required check', () => {
    const failing = pr({
      checks: [{ name: 'ci', kind: 'check_run', state: 'failure', appId: null, headSha: 'h1', detailsUrl: null }],
    });
    const result = evaluateEligibility(
      input({
        pr: failing,
        reviews: {
          commitSha: 'h1',
          byType: { code: { reviewId: 'r', status: 'passed', reused: false }, security: null, integration: null },
          blockingFindings: 0,
        },
        mergeApproved: true,
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(['REQUIRED_CHECK_FAILED']);
  });

  test('reviews, code owners and mergeability come from GitHub', () => {
    expect(codes(input({ pr: pr({ reviews: [] }) }))).toEqual(['REVIEWS_REQUIRED']);
    expect(codes(input({ pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) }))).toEqual(['CODEOWNER_REVIEW_REQUIRED']);
    expect(codes(input({ pr: pr({ mergeable: 'CONFLICTING' }) }))).toEqual(['MERGE_CONFLICT']);
    expect(codes(input({ pr: pr({ mergeable: 'UNKNOWN' }) }))).toEqual(['MERGEABILITY_UNKNOWN']);
    expect(codes(input({ pr: pr({ governance: null }) }))).toEqual(['RULES_UNKNOWN']);
  });

  test('stale approvals do not count when the rules dismiss them', () => {
    const stale = pr({
      reviews: [{ id: '1', reviewer: 'r', state: 'APPROVED', commitSha: 'old', submittedAt: null }],
      governance: { ...pr().governance!, requirements: { ...requirements, dismissStaleReviews: true } },
    });
    expect(codes(input({ pr: stale }))).toEqual(['REVIEWS_REQUIRED']);
  });

  test('Crewyard policies gate autonomy, sensitive paths and high risk changes', () => {
    expect(codes(input({ autonomy: 'observe' }))).toContain('AUTONOMY_OBSERVE');
    expect(codes(input({ autonomy: 'assisted' }))).toEqual(['OPERATOR_MERGE_APPROVAL_REQUIRED']);
    expect(codes(input({ autonomy: 'assisted', mergeApproved: true }))).toEqual([]);
    const sensitive = pr({
      changedFiles: [
        {
          path: 'src/payments/charge.ts',
          previousPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          blobSha: null,
        },
      ],
    });
    expect(codes(input({ pr: sensitive }))).toEqual(['HIGH_RISK_REVIEW_REQUIRED', 'APPROVAL_REQUIRED']);
    expect(
      codes(
        input({
          pr: sensitive,
          mergeApproved: true,
          reviews: {
            commitSha: 'h1',
            byType: { code: null, security: { reviewId: 's', status: 'passed', reused: false }, integration: null },
            blockingFindings: 0,
          },
        }),
      ),
    ).toEqual([]);
  });

  test('stack parents block or order their children', () => {
    const parent = pr({ id: 'pr_0', number: 0 });
    expect(
      evaluateEligibility(input({ parents: [{ pr: parent, kind: 'stack_parent', entryStatus: 'eligible' }] })),
    ).toMatchObject({
      eligible: true,
      blockers: [{ code: 'STACK_PARENT_NOT_MERGED', soft: true }],
    });
    expect(codes(input({ parents: [{ pr: parent, kind: 'stack_parent', entryStatus: 'quarantined' }] }))).toEqual([
      'STACK_PARENT_BLOCKED',
    ]);
    expect(
      codes(input({ parents: [{ pr: { ...parent, state: 'merged' }, kind: 'stack_parent', entryStatus: null }] })),
    ).toEqual([]);
  });

  test('offline state and blocking divergence prevent merges', () => {
    const offline = input({ freshness: { ...input().freshness, offline: true } });
    expect(codes(offline)).toEqual(['REMOTE_STATE_STALE']);
    const diverged = pr({
      externalDivergence: {
        kinds: ['force_push'],
        blocking: true,
        detectedAt: 'x',
        previousHead: 'a',
        observedHead: 'b',
        detail: 'force_push',
      },
    });
    expect(codes(input({ pr: diverged }))).toEqual(['EXTERNAL_DIVERGENCE']);
  });
});

function item(id: string, overrides: Partial<QueueEntry> = {}, extra: Partial<OrderItem> = {}): OrderItem {
  const entry: QueueEntry = {
    id: `qe_${id}`,
    queueId: 'q',
    prId: id,
    priority: 50,
    risk: 'low',
    stackId: null,
    stackOrder: null,
    status: 'eligible',
    blockers: [],
    attempts: 0,
    lastValidatedBaseSha: null,
    lastValidatedHeadSha: null,
    requestedBy: 'x',
    enqueuedAt: '2026-11-02T12:00:00Z',
    updatedAt: '2026-11-02T12:00:00Z',
    ...overrides,
  };
  return {
    entry,
    pr: pr({
      id,
      changedFiles: [
        { path: `src/${id}.ts`, previousPath: null, status: 'added', additions: 1, deletions: 0, blobSha: null },
      ],
    }),
    eligible: entry.status === 'eligible',
    dependsOn: [],
    ...extra,
  };
}

describe('queue ordering', () => {
  const now = new Date('2026-11-02T12:30:00Z');

  test('orders by dependency, eligibility, priority, attempts, unblock value and age deterministically', () => {
    const items = [
      item('child', { priority: 99 }, { dependsOn: ['parent'] }),
      item('parent', { priority: 10 }),
      item('blocked', { priority: 100, status: 'blocked' }),
      item('retried', { priority: 50, attempts: 2 }),
      item('fresh', { priority: 50, enqueuedAt: '2026-11-02T12:10:00Z' }),
      item('old', { priority: 50 }),
    ];
    const order = orderQueue(items, now, 120).map((i) => i.pr.id);
    expect(order).toEqual(['old', 'fresh', 'retried', 'parent', 'child', 'blocked']);
    expect(orderQueue([...items].reverse(), now, 120).map((i) => i.pr.id)).toEqual(order);
  });

  test('aged entries are promoted for fairness', () => {
    const order = orderQueue(
      [item('new', { priority: 90 }), item('aged', { priority: 1, enqueuedAt: '2026-11-02T09:00:00Z' })],
      now,
      120,
    );
    expect(order.map((i) => i.pr.id)).toEqual(['aged', 'new']);
  });

  test('groups contiguous stacks and only speculates over disjoint low-risk changes', () => {
    const stacked = [
      item('s1', {}, { pr: { ...pr({ id: 's1' }), stackId: 'chain:1' } }),
      item(
        's2',
        { blockers: [{ code: 'STACK_PARENT_NOT_MERGED', source: 'stack', soft: true, message: '' }] },
        {
          pr: { ...pr({ id: 's2' }), stackId: 'chain:1' },
          dependsOn: ['s1'],
        },
      ),
      item('other'),
    ];
    expect(selectGroup(stacked, config, 1).map((i) => i.pr.id)).toEqual(['s1']);
    const speculative = crewConfigSchema.parse({
      version: 1,
      project: { name: 'p' },
      integration: { speculative_validation: true },
      validation: { broad: [{ name: 'prefix', command: 'true' }] },
    });
    expect(selectGroup(stacked, speculative, 1).map((i) => i.pr.id)).toEqual(['s1', 's2']);
    const flat = [item('a'), item('b'), item('c', { risk: 'high' })];
    expect(selectGroup(flat, speculative, 3).map((i) => i.pr.id)).toEqual(['a', 'b']);
    expect(selectGroup(flat, speculative, 1).map((i) => i.pr.id)).toEqual(['a']);
  });
});
