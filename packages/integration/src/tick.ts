import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, type AutonomyMode, CrewError, type FailureClass, gitText, nowIso } from '@crewyard/core';
import type { GitHubClient } from '@crewyard/github';
import type { Repository } from '@crewyard/projects';
import { requestInterventionInTx } from '@crewyard/reviews';
import { acquireLeadership, type CrewContext, getOutbox, isLeader, one, recordTransition } from '@crewyard/storage';
import { buildAndValidateCandidate, createCandidate, fetchIntegrationRefs } from './candidates.ts';
import { eligibilityInputFor, evaluateEligibility, mergeApprovalSubject } from './eligibility.ts';
import {
  autonomyFor,
  clientFor,
  configFor,
  leadershipScope,
  type PendingHook,
  repositoryFor,
  runHooks,
} from './env.ts';
import { applyEntryFailure, type FailureInput, REVISION_REQUIRED } from './failures.ts';
import {
  type EnqueueIntent,
  enqueueOrReviveInTx,
  type MergeAsyncIntent,
  type MergeIntent,
  mergeIdempotencyKey,
  type OutboxReport,
  processIntegrationOutbox,
  type UpdatePullRequestIntent,
} from './outbox.ts';
import { type OrderItem, orderQueue, resolveQueueMode, unmergedDependencies } from './queue.ts';
import {
  activeCandidates,
  activeEntries,
  candidateById,
  invalidateCandidatesInTx,
  pullRequestById,
  queueById,
  queuesForRepository,
  setEntryStatus,
} from './records.ts';
import { type SyncResult, syncRepository } from './sync.ts';
import { readFreshness } from './sync-state.ts';
import type {
  Blocker,
  IntegrationCandidate,
  IntegrationEnv,
  IntegrationQueue,
  PullRequestRecord,
  QueueEntry,
  QueueMode,
} from './types.ts';

const TICK_ACTOR: Actor = { kind: 'service', id: 'integration-tick' };
export const DEFAULT_LEASE_TTL = 120;
const APPROVAL_CODES = new Set(['APPROVAL_REQUIRED', 'OPERATOR_MERGE_APPROVAL_REQUIRED']);
const FROZEN: readonly QueueEntry['status'][] = ['quarantined', 'escalated', 'merging', 'merged', 'removed'];
const REVISABLE_CODES = new Set([
  'CHECK_FAILED',
  'REQUIRED_CHECK_FAILED',
  'MERGE_CONFLICT',
  'REVIEW_FINDINGS_OPEN',
  'CHANGES_REQUESTED',
]);
const WAITING_CODES = new Set([
  'MERGEABILITY_UNKNOWN',
  'REQUIRED_CHECK_PENDING',
  'NOT_SYNCED',
  'REMOTE_STATE_STALE',
  'RATE_LIMITED',
  'RULES_UNKNOWN',
]);

export function revisionFor(
  pr: PullRequestRecord,
  hard: readonly Blocker[],
): { failure: Omit<FailureInput, 'subjectKind' | 'subjectId'>; reason: string } | null {
  const fixable = hard.filter((b) => REVISABLE_CODES.has(b.code));
  if (fixable.length === 0 || hard.some((b) => !REVISABLE_CODES.has(b.code) && !WAITING_CODES.has(b.code))) return null;
  const codes = [...new Set(fixable.map((b) => b.code))].sort();
  const failingChecks = pr.checks
    .filter((c) => c.state === 'failure')
    .map((c) => c.name)
    .sort();
  const failureClass: FailureClass = codes.includes('MERGE_CONFLICT')
    ? 'merge_conflict'
    : failingChecks.length > 0
      ? 'test_failure'
      : 'review_findings';
  return {
    failure: {
      fingerprint: `revision:${pr.id}:${codes.join(',')}:${failingChecks.join(',')}`,
      failureClass,
      evidence: { codes, failingChecks, headSha: pr.headSha },
    },
    reason: `PR #${pr.number} needs revision: ${fixable.map((b) => b.message).join('; ')}`,
  };
}

export interface QueueTickOptions {
  leaderId: string;
  env?: IntegrationEnv;
  sync?: boolean;
  maxCandidates?: number;
}

export interface QueueTickQueueResult {
  queueId: string;
  baseBranch: string;
  mode: QueueMode;
  leader: boolean;
  generation: number | null;
  paused: boolean;
  eligible: string[];
  blocked: string[];
  candidates: string[];
  merged: string[];
  enqueued: string[];
  notes: string[];
}

export interface QueueTickResult {
  repositoryId: string;
  offline: boolean;
  sync: SyncResult | null;
  outbox: OutboxReport | null;
  queues: QueueTickQueueResult[];
}

interface TickScope {
  ctx: CrewContext;
  env: IntegrationEnv;
  repository: Repository;
  config: CrewConfig;
  autonomy: AutonomyMode;
  leaderId: string;
  hooks: PendingHook[];
}

function hookBase(pr: PullRequestRecord) {
  return pr.taskId ? { taskId: pr.taskId, prId: pr.id, prNumber: pr.number, repositoryId: pr.repositoryId } : null;
}

function refreshMode(db: Database, scope: TickScope, queue: IntegrationQueue, at: string): IntegrationQueue {
  if (scope.config.integration.mode !== 'auto' && queue.mode === scope.config.integration.mode) return queue;
  const sample = activeEntries(db, queue.id)
    .map((e) => pullRequestById(db, e.prId))
    .find((pr) => pr?.governance?.requirements);
  const desired =
    scope.config.integration.mode === 'auto'
      ? sample
        ? resolveQueueMode(scope.config, sample)
        : queue.mode
      : scope.config.integration.mode;
  const busy =
    activeCandidates(db, queue.id).length > 0 ||
    activeEntries(db, queue.id).some(
      (e) => e.status === 'merging' || e.status === 'validating' || e.status === 'candidate',
    );
  if (desired === queue.mode || busy) return queue;
  db.query('UPDATE integration_queues SET mode = ?, updated_at = ? WHERE id = ?').run(desired, at, queue.id);
  recordTransition(
    db,
    { type: 'queue.mode_changed', actor: TICK_ACTOR, payload: { queueId: queue.id, from: queue.mode, to: desired } },
    { action: 'queue.mode', input: { queueId: queue.id }, decision: desired },
    at,
  );
  return queueById(db, queue.id)!;
}

function evaluateQueue(
  db: Database,
  scope: TickScope,
  queue: IntegrationQueue,
  at: string,
  result: QueueTickQueueResult,
  only?: ReadonlySet<string>,
) {
  for (const entry of activeEntries(db, queue.id)) {
    if (only && !only.has(entry.id)) continue;
    const pr = pullRequestById(db, entry.prId);
    if (!pr) continue;
    if (pr.state === 'merged') {
      setEntryStatus(db, entry.id, 'merged', at);
      const base = hookBase(pr);
      if (base && pr.mergeCommitSha) {
        scope.hooks.push({ name: 'onMerged', event: { ...base, mergeCommitSha: pr.mergeCommitSha } });
      }
      continue;
    }
    if (FROZEN.includes(entry.status)) continue;
    if (entry.status === 'blocked') {
      const revision = entry.blockers.find((b) => b.code === REVISION_REQUIRED);
      if (revision && revision.details?.headSha === pr.headSha) {
        result.blocked.push(pr.id);
        continue;
      }
    }
    if (entry.status === 'validating' && queue.mode === 'github-managed') {
      if (pr.governance?.isInMergeQueue) continue;
      const failing = pr.checks.filter((c) => c.state === 'failure').map((c) => c.name);
      applyEntryFailure(
        db,
        {
          entry,
          pr,
          projectId: scope.repository.projectId,
          failure: {
            fingerprint: `merge_group:${pr.headSha}:${failing.sort().join(',')}`,
            failureClass: 'test_failure',
            evidence: { failing, headSha: pr.headSha },
          },
          maxRetries: scope.config.agents.max_retries_per_failure,
          reason: 'GitHub removed the pull request from the merge queue',
          actor: TICK_ACTOR,
        },
        at,
        scope.hooks,
      );
      continue;
    }
    if ((entry.status === 'candidate' || entry.status === 'validating') && activeCandidates(db, queue.id).length > 0) {
      continue;
    }
    const evaluation = evaluateEligibility(
      eligibilityInputFor(db, pr, {
        autonomy: scope.autonomy,
        config: scope.config,
        mode: queue.mode,
        queuePaused: queue.paused,
      }),
    );
    const hard = evaluation.blockers.filter((b) => !b.soft);
    const revision = revisionFor(pr, hard);
    if (revision) {
      applyEntryFailure(
        db,
        {
          entry,
          pr,
          projectId: scope.repository.projectId,
          failure: revision.failure,
          maxRetries: scope.config.agents.max_retries_per_failure,
          reason: revision.reason,
          actor: TICK_ACTOR,
          revisable: true,
        },
        at,
        scope.hooks,
      );
      result.blocked.push(pr.id);
      continue;
    }
    const next: QueueEntry['status'] = hard.length === 0 ? 'eligible' : 'blocked';
    if (next === 'blocked' && entry.status !== 'blocked') {
      const base = hookBase(pr);
      if (base) {
        scope.hooks.push({
          name: 'onBlocked',
          event: { ...base, reason: hard[0]!.message, blockers: evaluation.blockers },
        });
      }
    }
    if (hard.some((b) => APPROVAL_CODES.has(b.code))) {
      requestInterventionInTx(
        db,
        {
          projectId: scope.repository.projectId,
          title: `Merge approval needed for PR #${pr.number}`,
          reasons: hard.filter((b) => APPROVAL_CODES.has(b.code)).map((b) => b.message),
          prId: pr.id,
          taskId: pr.taskId,
          approval: { subjectKind: 'merge', subjectId: mergeApprovalSubject(pr.id, pr.headSha) },
        },
        TICK_ACTOR,
        at,
      );
    }
    db.query('UPDATE queue_entries SET risk = ?, stack_id = ?, stack_order = ? WHERE id = ?').run(
      evaluation.risk,
      pr.stackId,
      pr.stackOrder,
      entry.id,
    );
    setEntryStatus(db, entry.id, next, at, { blockers: evaluation.blockers });
    (next === 'eligible' ? result.eligible : result.blocked).push(pr.id);
  }
}

function orderedItems(db: Database, queue: IntegrationQueue, scope: TickScope): OrderItem[] {
  const items = activeEntries(db, queue.id)
    .map((entry) => ({ entry, pr: pullRequestById(db, entry.prId) }))
    .filter((i): i is { entry: QueueEntry; pr: PullRequestRecord } => i.pr !== null)
    .map(({ entry, pr }) => ({
      entry,
      pr,
      eligible: entry.status === 'eligible',
      dependsOn: unmergedDependencies(db, pr.id),
    }));
  return orderQueue(items, scope.ctx.clock.now(), scope.config.scheduler.max_queue_age_minutes);
}

function hasSoftOnly(entry: QueueEntry): boolean {
  return entry.blockers.some((b) => b.soft);
}

function filesOf(pr: PullRequestRecord): Set<string> {
  return new Set((pr.changedFiles ?? []).map((f) => f.path));
}

export function selectGroup(items: readonly OrderItem[], config: CrewConfig, capacity: number): OrderItem[] {
  const first = items.find((i) => i.eligible && i.dependsOn.length === 0);
  if (!first) return [];
  const group = [first];
  const inGroup = new Set([first.pr.id]);
  for (const item of items) {
    if (inGroup.has(item.pr.id) || !item.eligible || item.dependsOn.length === 0) continue;
    if (
      item.dependsOn.every((d) => inGroup.has(d)) &&
      item.pr.stackId !== null &&
      item.pr.stackId === first.pr.stackId
    ) {
      group.push(item);
      inGroup.add(item.pr.id);
    }
  }
  if (config.integration.speculative_validation && capacity > 1 && first.pr.stackId === null) {
    const used = filesOf(first.pr);
    for (const item of items) {
      if (group.length >= capacity) break;
      if (inGroup.has(item.pr.id) || !item.eligible || item.dependsOn.length > 0 || item.entry.risk === 'high')
        continue;
      if (item.pr.stackId !== null || hasSoftOnly(item.entry)) continue;
      const files = filesOf(item.pr);
      if ([...files].some((f) => used.has(f))) continue;
      for (const f of files) used.add(f);
      group.push(item);
      inGroup.add(item.pr.id);
    }
  }
  return group;
}

async function verifyStep(
  scope: TickScope,
  client: GitHubClient,
  queue: IntegrationQueue,
  candidate: IntegrationCandidate,
  index: number,
  guard: { scope: string; generation: number },
  stacked: boolean,
): Promise<string | null> {
  const { ctx } = scope;
  const step = candidate.entries[index]!;
  const live = await client.getBranch(queue.baseBranch);
  const previous = index > 0 && !stacked ? candidate.entries[index - 1]! : null;
  if (index === 0 && live.sha !== candidate.baseSha) {
    return `base_changed:${candidate.baseSha.slice(0, 12)}->${live.sha.slice(0, 12)}`;
  }
  if (previous) {
    if (live.sha !== previous.mergeCommitSha) return 'base_changed_between_merges';
    await fetchIntegrationRefs(scope.repository.canonicalPath, queue.baseBranch, []);
    const tree = await gitText(scope.repository.canonicalPath, ['rev-parse', `${live.sha}^{tree}`]);
    if (tree !== previous.treeSha) return 'merged_tree_differs_from_candidate';
  }
  const refreshed = await syncRepository(ctx, scope.repository.id, scope.env, { numbers: [step.number] });
  if (!refreshed.ok) return refreshed.offline ? 'offline' : 'rate_limited';
  const pr = pullRequestById(ctx.store.db, step.prId);
  if (pr?.state !== 'open') return 'pull_request_not_open';
  if (pr.headSha !== step.headSha) return 'head_changed';
  if ((pr.governance?.requirements?.fingerprint ?? null) !== candidate.rulesFingerprint) return 'rules_changed';
  const current = candidateById(ctx.store.db, candidate.id);
  if (current?.status !== 'valid') return current?.invalidReason ?? 'candidate_invalidated';
  const evaluation = evaluateEligibility(
    eligibilityInputFor(ctx.store.db, pr, {
      autonomy: scope.autonomy,
      config: scope.config,
      mode: queue.mode,
      queuePaused:
        queuesForRepository(ctx.store.db, queue.repositoryId).find((q) => q.id === queue.id)?.paused ?? false,
    }),
  );
  const groupIds = new Set(candidate.entries.map((e) => e.prId));
  const hard = evaluation.blockers.filter(
    (b) => !(b.soft && typeof b.details?.parentPrId === 'string' && groupIds.has(b.details.parentPrId)),
  );
  if (hard.length > 0) return `not_eligible:${hard.map((b) => b.code).join(',')}`;
  if (!isLeader(ctx.store, guard.scope, scope.leaderId, guard.generation)) return 'leadership_lost';
  return null;
}

function invalidate(ctx: CrewContext, candidateId: string, reason: string): void {
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => invalidateCandidatesInTx(db, { candidateId }, reason, TICK_ACTOR, at));
}

async function mergeCandidate(
  scope: TickScope,
  client: GitHubClient,
  queue: IntegrationQueue,
  candidateId: string,
  guard: { scope: string; generation: number },
  result: QueueTickQueueResult,
): Promise<'merged' | 'invalid' | 'pending' | 'failed'> {
  const { ctx, config } = scope;
  let candidate = candidateById(ctx.store.db, candidateId)!;
  const native = candidate.entries.map((s) => pullRequestById(ctx.store.db, s.prId)?.governance?.stack ?? null);
  const nativeStack = native.length > 1 && native.every((s) => s !== null && s.id === native[0]!.id);
  for (let index = 0; index < candidate.entries.length; index++) {
    candidate = candidateById(ctx.store.db, candidateId)!;
    const step = candidate.entries[index]!;
    if (step.merged) continue;
    let failure: string | null = null;
    for (const i of nativeStack ? candidate.entries.map((_, n) => n) : [index]) {
      failure ??= await verifyStep(scope, client, queue, candidate, i, guard, nativeStack);
    }
    if (failure) {
      invalidate(ctx, candidateId, failure);
      result.notes.push(`candidate ${candidateId} invalidated: ${failure}`);
      return 'invalid';
    }
    const pr = pullRequestById(ctx.store.db, step.prId)!;
    const top = candidate.entries.at(-1)!;
    const at = nowIso(ctx.clock);
    const op = ctx.store.immediate((db) => {
      if (nativeStack) {
        const intent: MergeAsyncIntent = {
          repositoryId: pr.repositoryId,
          prId: top.prId,
          number: top.number,
          headSha: top.headSha,
          baseRef: queue.baseBranch,
          action: 'direct_merge',
          mergeMethod: config.integration.merge_method,
          prIds: candidate.entries.map((e) => e.prId),
          candidateId,
        };
        for (const s of candidate.entries) setEntryStatus(db, s.entryId, 'merging', at);
        return enqueueOrReviveInTx(
          db,
          {
            kind: 'github.merge_async',
            subjectId: top.prId,
            intent,
            expectedState: { headSha: top.headSha, baseSha: candidate.baseSha },
            idempotencyKey: `merge-stack:${pr.repositoryId}:${top.prId}:${top.headSha}`,
            leaderGeneration: guard.generation,
            maxAttempts: 10,
          },
          at,
        );
      }
      const intent: MergeIntent = {
        repositoryId: pr.repositoryId,
        prId: pr.id,
        number: pr.number,
        headSha: step.headSha,
        baseRef: queue.baseBranch,
        expectedBaseSha: index === 0 ? candidate.baseSha : (candidate.entries[index - 1]!.mergeCommitSha ?? null),
        mergeMethod: config.integration.merge_method,
        candidateId,
        entryId: step.entryId,
        retargetBase: pr.baseRef !== queue.baseBranch ? queue.baseBranch : null,
      };
      setEntryStatus(db, step.entryId, 'merging', at);
      return enqueueOrReviveInTx(
        db,
        {
          kind: 'github.merge',
          subjectId: pr.id,
          taskId: pr.taskId,
          intent,
          expectedState: { headSha: step.headSha, baseSha: intent.expectedBaseSha },
          idempotencyKey: mergeIdempotencyKey(pr.repositoryId, pr.id, step.headSha),
          leaderGeneration: guard.generation,
          maxAttempts: 10,
        },
        at,
      );
    });
    await processIntegrationOutbox(ctx, { leaderId: scope.leaderId, env: scope.env });
    const settled = getOutbox(ctx.store.db, op.operationId)!;
    if (settled.status === 'succeeded') {
      result.merged.push(...(nativeStack ? candidate.entries.map((e) => e.prId) : [pr.id]));
      if (nativeStack) break;
      continue;
    }
    if (settled.status === 'failed') return 'failed';
    result.notes.push(`merge of #${pr.number} is ${settled.status}; will reconcile`);
    return 'pending';
  }
  return 'merged';
}

async function crewManaged(
  scope: TickScope,
  client: GitHubClient,
  queue: IntegrationQueue,
  guard: { scope: string; generation: number },
  result: QueueTickQueueResult,
  maxCandidates: number,
): Promise<void> {
  const { ctx, config, repository } = scope;
  for (const stale of activeCandidates(ctx.store.db, queue.id).filter((c) => c.status !== 'valid')) {
    invalidate(ctx, stale.id, 'interrupted');
  }
  for (let built = 0; built < maxCandidates; ) {
    let candidate = activeCandidates(ctx.store.db, queue.id).find((c) => c.status === 'valid') ?? null;
    if (!candidate) {
      const group = selectGroup(orderedItems(ctx.store.db, queue, scope), config, queue.capacity);
      if (group.length === 0) return;
      const live = await client.getBranch(queue.baseBranch);
      const localBase = await fetchIntegrationRefs(
        repository.canonicalPath,
        queue.baseBranch,
        group.map((g) => g.pr),
      );
      if (localBase !== live.sha) {
        result.notes.push('local fetch of base does not match GitHub yet');
        return;
      }
      const policyRevision =
        one<{ policy_revision: number }>(
          ctx.store.db,
          'SELECT policy_revision FROM projects WHERE id = ?',
          repository.projectId,
        )?.policy_revision ?? 1;
      const created = createCandidate(
        ctx,
        {
          queueId: queue.id,
          baseSha: live.sha,
          group: group.map((g) => ({ entry: g.entry, pr: g.pr })),
          rulesFingerprint: group[0]!.pr.governance?.requirements?.fingerprint ?? null,
          policyRevision,
        },
        TICK_ACTOR,
        config.scheduler.max_queue_age_minutes * 60,
      );
      built++;
      result.candidates.push(created.id);
      const outcome = await buildAndValidateCandidate(ctx, created.id, {
        repository,
        config,
        actor: TICK_ACTOR,
        hooks: scope.hooks,
      });
      if (outcome.candidate.status !== 'valid') {
        result.notes.push(
          `candidate ${created.id} ${outcome.candidate.status}: ${outcome.candidate.invalidReason ?? ''}`,
        );
        continue;
      }
      candidate = outcome.candidate;
    }
    const renewed = acquireLeadership(
      ctx.store,
      guard.scope,
      scope.leaderId,
      scope.env.leaseTtlSeconds ?? DEFAULT_LEASE_TTL,
    );
    if (renewed?.generation !== guard.generation) {
      result.notes.push('integration leadership changed during validation; merge deferred');
      return;
    }
    const merged = await mergeCandidate(scope, client, queue, candidate.id, guard, result);
    if (merged === 'pending') return;
    if (merged === 'invalid') {
      const entryIds = new Set(candidate.entries.filter((e) => !e.merged).map((e) => e.entryId));
      const at = nowIso(ctx.clock);
      ctx.store.immediate((db) => evaluateQueue(db, scope, queue, at, result, entryIds));
    }
  }
}

async function githubManaged(
  scope: TickScope,
  queue: IntegrationQueue,
  guard: { scope: string; generation: number },
  result: QueueTickQueueResult,
): Promise<void> {
  const { ctx } = scope;
  const items = orderedItems(ctx.store.db, queue, scope);
  const at = nowIso(ctx.clock);
  const ready = items.filter((i) => i.eligible && i.dependsOn.length === 0);
  ctx.store.immediate((db) => {
    for (const item of ready) {
      const pr = item.pr;
      const stack = pr.governance?.stack ?? null;
      if (stack) {
        const members = items
          .filter(
            (i) => i.pr.governance?.stack?.id === stack.id && (i.pr.governance?.stack?.position ?? 0) >= stack.position,
          )
          .sort((a, b) => (a.pr.governance?.stack?.position ?? 0) - (b.pr.governance?.stack?.position ?? 0));
        const chain: OrderItem[] = [];
        for (const member of members) {
          if (!member.eligible || (member.pr.governance?.stack?.position ?? 0) !== stack.position + chain.length) break;
          chain.push(member);
        }
        const top = chain.at(-1)!;
        const intent: MergeAsyncIntent = {
          repositoryId: pr.repositoryId,
          prId: top.pr.id,
          number: top.pr.number,
          headSha: top.pr.headSha,
          baseRef: queue.baseBranch,
          action: 'merge_queue',
          mergeMethod: null,
          prIds: chain.map((c) => c.pr.id),
          candidateId: null,
        };
        enqueueOrReviveInTx(
          db,
          {
            kind: 'github.merge_async',
            subjectId: top.pr.id,
            intent,
            idempotencyKey: `enqueue-stack:${pr.repositoryId}:${top.pr.id}:${top.pr.headSha}`,
            leaderGeneration: guard.generation,
            maxAttempts: 10,
          },
          at,
        );
        for (const c of chain) setEntryStatus(db, c.entry.id, 'merging', at);
        result.enqueued.push(...chain.map((c) => c.pr.id));
        continue;
      }
      const intent: EnqueueIntent = {
        repositoryId: pr.repositoryId,
        prId: pr.id,
        number: pr.number,
        headSha: pr.headSha,
        baseRef: queue.baseBranch,
        entryId: item.entry.id,
      };
      enqueueOrReviveInTx(
        db,
        {
          kind: 'github.enqueue',
          subjectId: pr.id,
          taskId: pr.taskId,
          intent,
          expectedState: { headSha: pr.headSha },
          idempotencyKey: `enqueue:${pr.repositoryId}:${pr.id}:${pr.headSha}`,
          leaderGeneration: guard.generation,
          maxAttempts: 10,
        },
        at,
      );
      setEntryStatus(db, item.entry.id, 'merging', at);
      result.enqueued.push(pr.id);
    }
  });
  if (ready.length > 0) await processIntegrationOutbox(ctx, { leaderId: scope.leaderId, env: scope.env });
}

function retargetChildren(db: Database, queue: IntegrationQueue, guard: { generation: number }, at: string): void {
  for (const entry of activeEntries(db, queue.id)) {
    const pr = pullRequestById(db, entry.prId);
    if (pr?.state !== 'open' || pr.baseRef === queue.baseBranch || pr.governance?.stack) continue;
    if (unmergedDependencies(db, pr.id).length > 0) continue;
    const parentMerged = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pr_dependencies d JOIN pull_requests p ON p.id = d.depends_on_pr_id WHERE d.pr_id = ? AND d.kind = 'stack_parent' AND p.state = 'merged'`,
      pr.id,
    )!.n;
    const orphan = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pull_requests WHERE repository_id = ? AND head_ref = ? AND state = 'merged'`,
      pr.repositoryId,
      pr.baseRef,
    )!.n;
    if (parentMerged === 0 && orphan === 0) continue;
    const intent: UpdatePullRequestIntent = {
      repositoryId: pr.repositoryId,
      prId: pr.id,
      number: pr.number,
      patch: { base: queue.baseBranch },
    };
    enqueueOrReviveInTx(
      db,
      {
        kind: 'github.update_pr',
        subjectId: pr.id,
        intent,
        idempotencyKey: `retarget:${pr.repositoryId}:${pr.id}:${queue.baseBranch}`,
        leaderGeneration: guard.generation,
      },
      at,
    );
  }
}

export async function queueTick(
  ctx: CrewContext,
  repositoryId: string,
  options: QueueTickOptions,
): Promise<QueueTickResult> {
  const env = options.env ?? {};
  const repository = repositoryFor(ctx, repositoryId);
  const scope: TickScope = {
    ctx,
    env,
    repository,
    config: configFor(ctx, env, repository.projectId),
    autonomy: autonomyFor(ctx, repository.projectId),
    leaderId: options.leaderId,
    hooks: [],
  };
  const sync = options.sync === false ? null : await syncRepository(ctx, repositoryId, env);
  const freshness = readFreshness(ctx.store.db, repositoryId);
  const offline = freshness.offline || (sync !== null && !sync.ok);
  const outbox = offline ? null : await processIntegrationOutbox(ctx, { leaderId: options.leaderId, env });
  const results: QueueTickQueueResult[] = [];
  for (const initial of queuesForRepository(ctx.store.db, repositoryId)) {
    const result: QueueTickQueueResult = {
      queueId: initial.id,
      baseBranch: initial.baseBranch,
      mode: initial.mode,
      leader: false,
      generation: null,
      paused: initial.paused,
      eligible: [],
      blocked: [],
      candidates: [],
      merged: [],
      enqueued: [],
      notes: [],
    };
    results.push(result);
    const lease = acquireLeadership(
      ctx.store,
      leadershipScope(repositoryId, initial.baseBranch),
      options.leaderId,
      env.leaseTtlSeconds ?? DEFAULT_LEASE_TTL,
    );
    if (!lease) {
      result.notes.push('another worker holds integration leadership');
      continue;
    }
    result.leader = true;
    result.generation = lease.generation;
    const guard = { scope: lease.scope, generation: lease.generation };
    const at = nowIso(ctx.clock);
    const queue = ctx.store.immediate((db) => {
      const q = refreshMode(db, scope, initial, at);
      evaluateQueue(db, scope, q, at, result);
      if (!offline && !q.paused) retargetChildren(db, q, guard, at);
      return q;
    });
    result.mode = queue.mode;
    if (offline) {
      result.notes.push(`remote mutations paused; last seen ${freshness.lastSuccessAt ?? 'never'}`);
      continue;
    }
    if (queue.paused || scope.autonomy === 'observe') continue;
    try {
      const client = await clientFor(ctx, env, repository);
      if (queue.mode === 'github-managed') await githubManaged(scope, queue, guard, result);
      else await crewManaged(scope, client, queue, guard, result, options.maxCandidates ?? 3);
    } catch (error) {
      if (error instanceof CrewError && (error.code === 'OFFLINE' || error.code === 'RATE_LIMITED')) {
        result.notes.push(`paused: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
  await runHooks(ctx, env.hooks, scope.hooks);
  return { repositoryId, offline, sync, outbox, queues: results };
}
