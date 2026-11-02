import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, nowIso, sleep } from '@crewyard/core';
import type {
  AsyncMergeAction,
  BranchRequirements,
  GitHubClient,
  GitHubPullRequest,
  MergeMethod,
  UpdatePullRequestInput,
} from '@crewyard/github';
import {
  acquireLeadership,
  type CrewContext,
  claimDueOutbox,
  completeOutbox,
  type EnqueueInput,
  enqueueOutbox,
  getOutbox,
  isLeader,
  type OutboxOperation,
  one,
  recordRemoteOperation,
  recordTransition,
  toJson,
} from '@crewyard/storage';
import { clientFor, configFor, leadershipScope, type PendingHook, repositoryFor, runHooks } from './env.ts';
import { applyEntryFailure, classifyError } from './failures.ts';
import {
  activeEntryForPr,
  candidateById,
  invalidateCandidatesInTx,
  pullRequestById,
  setEntryStatus,
} from './records.ts';
import { applyObservation, observePullRequest } from './sync.ts';
import { markSyncFailure } from './sync-state.ts';
import type { CandidateStep, IntegrationEnv } from './types.ts';

export const GITHUB_OUTBOX_KINDS = [
  'github.merge',
  'github.merge_async',
  'github.enqueue',
  'github.create_pr',
  'github.update_pr',
] as const;
export type GitHubOutboxKind = (typeof GITHUB_OUTBOX_KINDS)[number];

export interface MergeIntent extends Record<string, unknown> {
  repositoryId: string;
  prId: string;
  number: number;
  headSha: string;
  baseRef: string;
  expectedBaseSha: string | null;
  mergeMethod: MergeMethod;
  candidateId: string | null;
  entryId: string | null;
  retargetBase: string | null;
}

export interface EnqueueIntent extends Record<string, unknown> {
  repositoryId: string;
  prId: string;
  number: number;
  headSha: string;
  baseRef: string;
  entryId: string | null;
}

export interface MergeAsyncIntent extends Record<string, unknown> {
  repositoryId: string;
  prId: string;
  number: number;
  headSha: string;
  baseRef: string;
  action: AsyncMergeAction;
  mergeMethod: MergeMethod | null;
  prIds: string[];
  candidateId: string | null;
}

export interface CreatePullRequestIntent extends Record<string, unknown> {
  repositoryId: string;
  taskId: string | null;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface UpdatePullRequestIntent extends Record<string, unknown> {
  repositoryId: string;
  prId: string;
  number: number;
  patch: UpdatePullRequestInput;
}

export function enqueueOrReviveInTx(
  db: Database,
  input: EnqueueInput & { idempotencyKey: string },
  at: string,
): OutboxOperation {
  const existing = one<{ operation_id: string; status: string }>(
    db,
    'SELECT operation_id, status FROM outbox WHERE idempotency_key = ?',
    input.idempotencyKey,
  );
  if (existing && (existing.status === 'failed' || existing.status === 'cancelled')) {
    db.query(
      `UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL, intent = ?, expected_state = ?, leader_generation = ?,
         next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
    ).run(
      toJson(input.intent),
      toJson(input.expectedState ?? {}),
      input.leaderGeneration ?? null,
      at,
      at,
      existing.operation_id,
    );
    return getOutbox(db, existing.operation_id)!;
  }
  return enqueueOutbox(db, input, at);
}

export const mergeIdempotencyKey = (repositoryId: string, prId: string, headSha: string) =>
  `merge:${repositoryId}:${prId}:${headSha}`;

export interface OutboxReport {
  processed: number;
  succeeded: string[];
  ambiguous: string[];
  failed: string[];
  deferred: string[];
}

interface HandlerContext {
  ctx: CrewContext;
  env: IntegrationEnv;
  leaderId: string;
  hooks: PendingHook[];
  report: OutboxReport;
}

const OUTBOX_ACTOR: Actor = { kind: 'service', id: 'integration-outbox' };

function scopeFor(op: OutboxOperation): string | null {
  const intent = op.intent as Record<string, unknown>;
  if (op.kind === 'github.create_pr' || op.kind === 'github.update_pr') return null;
  return leadershipScope(String(intent.repositoryId), String(intent.baseRef));
}

function remote(
  ctx: CrewContext,
  op: OutboxOperation,
  client: GitHubClient,
  method: string,
  target: string,
  request: unknown,
  result: { status: number | null; remoteId?: string | null; body?: unknown },
): void {
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) =>
    recordRemoteOperation(
      db,
      {
        operationId: op.operationId,
        host: client.repository.host,
        method,
        target,
        request,
        responseStatus: result.status,
        remoteId: result.remoteId ?? null,
        result: result.body,
      },
      at,
    ),
  );
}

function settle(
  hc: HandlerContext,
  op: OutboxOperation,
  outcome: Parameters<typeof completeOutbox>[2],
  extra?: (db: Database, at: string) => void,
): void {
  const at = nowIso(hc.ctx.clock);
  hc.ctx.store.immediate((db) => {
    completeOutbox(db, op.operationId, outcome, at);
    extra?.(db, at);
  });
  if (outcome.status === 'succeeded') hc.report.succeeded.push(op.operationId);
  else if (outcome.status === 'ambiguous') hc.report.ambiguous.push(op.operationId);
  else if (outcome.status === 'retry') hc.report.deferred.push(op.operationId);
  else hc.report.failed.push(op.operationId);
}

function defer(hc: HandlerContext, op: OutboxOperation, error: unknown, untilIso?: string | null): void {
  const message = error instanceof Error ? error.message : String(error);
  if (untilIso) {
    const at = nowIso(hc.ctx.clock);
    hc.ctx.store.immediate((db) =>
      db
        .query(
          `UPDATE outbox SET status = CASE WHEN status = 'ambiguous' THEN 'ambiguous' ELSE 'attempted' END, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?`,
        )
        .run(message, untilIso, at, op.operationId),
    );
    hc.report.deferred.push(op.operationId);
    return;
  }
  if (op.status === 'ambiguous') {
    settle(hc, op, { status: 'ambiguous', error: message });
    return;
  }
  settle(hc, op, { status: 'retry', error: message, attempts: op.attempts });
}

function finalizeMergedInTx(
  db: Database,
  hc: HandlerContext,
  op: OutboxOperation,
  observed: GitHubPullRequest,
  prId: string,
  candidateId: string | null,
  at: string,
): void {
  const pr = pullRequestById(db, prId);
  if (!pr || !observed.mergeCommitSha) return;
  db.query(
    `UPDATE pull_requests SET state = 'merged', merge_commit_sha = ?, merged_at = ?, head_sha = ?, updated_at = ? WHERE id = ?`,
  ).run(observed.mergeCommitSha, observed.mergedAt ?? at, observed.headSha, at, prId);
  const entry = activeEntryForPr(db, prId);
  if (entry) {
    setEntryStatus(db, entry.id, 'merged', at, { blockers: [] });
    if (pr.taskId) {
      hc.hooks.push({
        name: 'onMerged',
        event: {
          taskId: pr.taskId,
          prId,
          prNumber: pr.number,
          repositoryId: pr.repositoryId,
          mergeCommitSha: observed.mergeCommitSha,
        },
      });
    }
  }
  if (candidateId) {
    const candidate = candidateById(db, candidateId);
    if (candidate) {
      const steps: CandidateStep[] = candidate.entries.map((s) =>
        s.prId === prId ? { ...s, merged: true, mergeCommitSha: observed.mergeCommitSha } : s,
      );
      const allMerged = steps.every((s) => s.merged);
      db.query('UPDATE integration_candidates SET entries = ?, status = ?, updated_at = ? WHERE id = ?').run(
        toJson(steps),
        allMerged ? 'merged' : candidate.status,
        at,
        candidateId,
      );
    }
  }
  recordTransition(
    db,
    {
      type: 'pr.merged',
      actor: OUTBOX_ACTOR,
      prId,
      taskId: pr.taskId,
      payload: {
        number: pr.number,
        mergeCommitSha: observed.mergeCommitSha,
        headSha: observed.headSha,
        operationId: op.operationId,
        candidateId,
      },
    },
    {
      action: 'github.merge',
      input: op.intent,
      decision: 'merged',
      remoteResult: { mergeCommitSha: observed.mergeCommitSha, operationId: op.operationId },
    },
    at,
  );
}

function failMergeInTx(
  db: Database,
  hc: HandlerContext,
  op: OutboxOperation,
  prId: string,
  error: unknown,
  at: string,
): void {
  const pr = pullRequestById(db, prId);
  if (!pr) return;
  const repository = one<{ project_id: string }>(
    db,
    'SELECT project_id FROM repositories WHERE id = ?',
    pr.repositoryId,
  )!;
  const failureClass = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  const entry = activeEntryForPr(db, prId);
  invalidateCandidatesInTx(db, { prId }, `merge_failed:${failureClass}`, OUTBOX_ACTOR, at);
  if (!entry) return;
  if (error instanceof CrewError && error.code === 'HEAD_MISMATCH') {
    setEntryStatus(db, entry.id, 'waiting', at, { validatedBase: null, validatedHead: null });
    return;
  }
  const config = configFor(hc.ctx, hc.env, repository.project_id);
  applyEntryFailure(
    db,
    {
      entry,
      pr,
      projectId: repository.project_id,
      failure: {
        fingerprint: `merge:${failureClass}:${(error instanceof CrewError ? error.code : 'ERROR').toLowerCase()}`,
        failureClass,
        evidence: { operationId: op.operationId, message },
      },
      maxRetries: config.agents.max_retries_per_failure,
      reason: `GitHub refused the merge: ${message}`,
      actor: OUTBOX_ACTOR,
    },
    at,
    hc.hooks,
  );
}

async function leaderGuard(
  hc: HandlerContext,
  op: OutboxOperation,
): Promise<{ scope: string; generation: number } | null> {
  const scope = scopeFor(op);
  if (!scope) return { scope: '', generation: 0 };
  const lease = acquireLeadership(hc.ctx.store, scope, hc.leaderId, hc.env.leaseTtlSeconds ?? 120);
  if (!lease) {
    defer(hc, op, new CrewError('LEASE_CONFLICT', `Not the integration leader for ${scope}`));
    return null;
  }
  return { scope, generation: lease.generation };
}

function stillLeader(hc: HandlerContext, guard: { scope: string; generation: number }): boolean {
  return guard.scope === '' || isLeader(hc.ctx.store, guard.scope, hc.leaderId, guard.generation);
}

function handleError(
  hc: HandlerContext,
  op: OutboxOperation,
  client: GitHubClient | null,
  error: unknown,
  onFail: (db: Database, at: string) => void,
): void {
  if (error instanceof CrewError) {
    if (error.code === 'OFFLINE' || error.code === 'RATE_LIMITED') {
      const repositoryId = String((op.intent as Record<string, unknown>).repositoryId);
      const at = nowIso(hc.ctx.clock);
      hc.ctx.store.immediate((db) => markSyncFailure(db, repositoryId, error, at));
      defer(hc, op, error, error.code === 'RATE_LIMITED' ? (client?.rateLimitResetAt ?? null) : null);
      return;
    }
    if (error.code === 'AMBIGUOUS_REMOTE_OUTCOME') {
      settle(hc, op, { status: 'ambiguous', error: error.message });
      return;
    }
    if (
      error.code === 'LEASE_CONFLICT' ||
      error.code === 'BUSY' ||
      (error.retryable && error.code !== 'POLICY_DENIED')
    ) {
      defer(hc, op, error);
      return;
    }
  }
  settle(hc, op, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, onFail);
}

async function handleMerge(hc: HandlerContext, op: OutboxOperation): Promise<void> {
  const intent = op.intent as MergeIntent;
  const guard = await leaderGuard(hc, op);
  if (!guard) return;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const observed = await client.getPullRequest(intent.number);
    remote(
      hc.ctx,
      op,
      client,
      'GET',
      `pulls/${intent.number}#reconcile`,
      { number: intent.number },
      {
        status: 200,
        remoteId: observed.mergeCommitSha,
        body: { state: observed.state, headSha: observed.headSha },
      },
    );
    if (observed.state === 'merged') {
      if (!observed.mergeCommitSha) {
        settle(hc, op, { status: 'ambiguous', error: 'merged without observable merge commit yet' });
        return;
      }
      settle(
        hc,
        op,
        { status: 'succeeded', remoteCorrelation: { mergeCommitSha: observed.mergeCommitSha, reconciled: true } },
        (db, at) => finalizeMergedInTx(db, hc, op, observed, intent.prId, intent.candidateId, at),
      );
      return;
    }
    if (observed.state === 'closed') {
      throw new CrewError('INVALID_TRANSITION', `#${intent.number} was closed without merging`, { retryable: false });
    }
    if (observed.headSha !== intent.headSha) {
      throw new CrewError(
        'HEAD_MISMATCH',
        `#${intent.number} head is ${observed.headSha}, expected ${intent.headSha}`,
        {
          retryable: false,
        },
      );
    }
    if (intent.retargetBase && observed.baseRef !== intent.retargetBase) {
      if (!stillLeader(hc, guard)) return defer(hc, op, new CrewError('LEASE_CONFLICT', 'leadership lost'));
      const updated = await client.updatePullRequest(intent.number, { base: intent.retargetBase });
      remote(
        hc.ctx,
        op,
        client,
        'PATCH',
        `pulls/${intent.number}`,
        { base: intent.retargetBase },
        {
          status: 200,
          body: { baseRef: updated.baseRef },
        },
      );
    }
    if (!stillLeader(hc, guard)) return defer(hc, op, new CrewError('LEASE_CONFLICT', 'leadership lost'));
    try {
      const result = await client.mergePullRequest(intent.number, {
        sha: intent.headSha,
        mergeMethod: intent.mergeMethod,
      });
      remote(
        hc.ctx,
        op,
        client,
        'PUT',
        `pulls/${intent.number}/merge`,
        { sha: intent.headSha, method: intent.mergeMethod },
        {
          status: 200,
          remoteId: result.sha,
          body: result,
        },
      );
    } catch (error) {
      remote(
        hc.ctx,
        op,
        client,
        'PUT',
        `pulls/${intent.number}/merge`,
        { sha: intent.headSha, method: intent.mergeMethod },
        {
          status: error instanceof CrewError && typeof error.details?.status === 'number' ? error.details.status : null,
          body: { error: error instanceof CrewError ? error.code : 'ERROR' },
        },
      );
      throw error;
    }
    const confirmed = await client.getPullRequest(intent.number).catch(() => null);
    if (confirmed?.state !== 'merged' || !confirmed.mergeCommitSha) {
      settle(hc, op, { status: 'ambiguous', error: 'merge accepted but not yet observed as merged' });
      return;
    }
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { mergeCommitSha: confirmed.mergeCommitSha } }, (db, at) =>
      finalizeMergedInTx(db, hc, op, confirmed, intent.prId, intent.candidateId, at),
    );
  } catch (error) {
    handleError(hc, op, client, error, (db, at) => failMergeInTx(db, hc, op, intent.prId, error, at));
  }
}

async function handleEnqueue(hc: HandlerContext, op: OutboxOperation): Promise<void> {
  const intent = op.intent as EnqueueIntent;
  const guard = await leaderGuard(hc, op);
  if (!guard) return;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  const markQueued = (db: Database, at: string) => {
    const entry = activeEntryForPr(db, intent.prId);
    if (entry) setEntryStatus(db, entry.id, 'validating', at, { blockers: [] });
    recordTransition(
      db,
      {
        type: 'queue.github_enqueued',
        actor: OUTBOX_ACTOR,
        prId: intent.prId,
        payload: { number: intent.number, headSha: intent.headSha },
      },
      { action: 'github.enqueue', input: intent, decision: 'enqueued' },
      at,
    );
  };
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const observed = await client.getPullRequest(intent.number);
    if (observed.state === 'merged' && observed.mergeCommitSha) {
      settle(
        hc,
        op,
        { status: 'succeeded', remoteCorrelation: { mergeCommitSha: observed.mergeCommitSha } },
        (db, at) => finalizeMergedInTx(db, hc, op, observed, intent.prId, null, at),
      );
      return;
    }
    if (observed.state === 'closed')
      throw new CrewError('INVALID_TRANSITION', `#${intent.number} is closed`, { retryable: false });
    if (observed.headSha !== intent.headSha) {
      throw new CrewError('HEAD_MISMATCH', `#${intent.number} head changed before enqueue`, { retryable: false });
    }
    const state = await client.getPullRequestState(intent.number);
    if (state.isInMergeQueue) {
      settle(
        hc,
        op,
        {
          status: 'succeeded',
          remoteCorrelation: { mergeQueueEntryId: state.mergeQueueEntry?.id ?? null, reconciled: true },
        },
        markQueued,
      );
      return;
    }
    if (!stillLeader(hc, guard)) return defer(hc, op, new CrewError('LEASE_CONFLICT', 'leadership lost'));
    const entry = await client.enqueuePullRequest(state.nodeId, intent.headSha);
    remote(
      hc.ctx,
      op,
      client,
      'POST',
      'graphql:EnqueuePullRequest',
      { number: intent.number, headSha: intent.headSha },
      {
        status: 200,
        remoteId: entry.id,
        body: entry,
      },
    );
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { mergeQueueEntryId: entry.id } }, markQueued);
  } catch (error) {
    handleError(hc, op, client, error, (db, at) => failMergeInTx(db, hc, op, intent.prId, error, at));
  }
}

async function handleMergeAsync(hc: HandlerContext, op: OutboxOperation): Promise<void> {
  const intent = op.intent as MergeAsyncIntent;
  const guard = await leaderGuard(hc, op);
  if (!guard) return;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  const finalizeAll = async (c: GitHubClient) => {
    const observedAll: { prId: string; pr: GitHubPullRequest }[] = [];
    for (const prId of intent.prIds) {
      const record = pullRequestById(hc.ctx.store.db, prId);
      if (record) observedAll.push({ prId, pr: await c.getPullRequest(record.number) });
    }
    if (observedAll.some((o) => o.pr.state !== 'merged' || !o.pr.mergeCommitSha)) return false;
    settle(
      hc,
      op,
      { status: 'succeeded', remoteCorrelation: { merged: observedAll.map((o) => o.pr.number) } },
      (db, at) => {
        for (const o of observedAll) finalizeMergedInTx(db, hc, op, o.pr, o.prId, intent.candidateId, at);
      },
    );
    return true;
  };
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const top = await client.getPullRequest(intent.number);
    if (top.state === 'merged') {
      if (!(await finalizeAll(client))) settle(hc, op, { status: 'ambiguous', error: 'stack partially merged' });
      return;
    }
    if (top.headSha !== intent.headSha) {
      throw new CrewError('HEAD_MISMATCH', `#${intent.number} head changed`, { retryable: false });
    }
    let uuid = typeof op.remoteCorrelation?.uuid === 'string' ? op.remoteCorrelation.uuid : null;
    let result = uuid ? await client.getAsyncMergeResult(intent.number, uuid).catch(() => null) : null;
    if (!result) {
      if (intent.action === 'merge_queue' && (await client.getPullRequestState(intent.number)).isInMergeQueue) {
        settle(hc, op, { status: 'succeeded', remoteCorrelation: { enqueued: true, reconciled: true } });
        return;
      }
      if (!stillLeader(hc, guard)) return defer(hc, op, new CrewError('LEASE_CONFLICT', 'leadership lost'));
      result = await client.mergePullRequestAsync(intent.number, {
        sha: intent.headSha,
        action: intent.action,
        ...(intent.mergeMethod ? { mergeMethod: intent.mergeMethod } : {}),
      });
      uuid = result.uuid;
      remote(
        hc.ctx,
        op,
        client,
        'PUT',
        `pulls/${intent.number}/merge-async`,
        { sha: intent.headSha, action: intent.action },
        {
          status: 202,
          remoteId: uuid,
          body: result,
        },
      );
    }
    for (let i = 0; result.status === 'pending' && uuid && i < 5; i++) {
      await sleep(50 * (i + 1));
      result = await client.getAsyncMergeResult(intent.number, uuid);
    }
    if (result.status === 'merged') {
      if (!(await finalizeAll(client)))
        settle(hc, op, { status: 'ambiguous', error: 'merge reported but not observed', remoteCorrelation: { uuid } });
      return;
    }
    if (result.status === 'enqueued') {
      settle(hc, op, { status: 'succeeded', remoteCorrelation: { uuid, enqueued: true } }, (db, at) => {
        for (const prId of intent.prIds) {
          const entry = activeEntryForPr(db, prId);
          if (entry) setEntryStatus(db, entry.id, 'validating', at, { blockers: [] });
        }
      });
      return;
    }
    if (result.status === 'failed') {
      throw new CrewError('POLICY_DENIED', `GitHub rejected the stack merge: ${result.message ?? 'unknown reason'}`, {
        retryable: false,
      });
    }
    settle(hc, op, { status: 'ambiguous', error: 'asynchronous merge still pending', remoteCorrelation: { uuid } });
  } catch (error) {
    handleError(hc, op, client, error, (db, at) => {
      for (const prId of intent.prIds) failMergeInTx(db, hc, op, prId, error, at);
    });
  }
}

async function handleCreatePullRequest(hc: HandlerContext, op: OutboxOperation): Promise<void> {
  const intent = op.intent as CreatePullRequestIntent;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const existing = (await client.findPullRequestsForHead(intent.headRef)).filter((p) => p.state === 'open');
    let pr = existing.find((p) => p.baseRef === intent.baseRef) ?? existing[0] ?? null;
    if (!pr) {
      try {
        pr = await client.createPullRequest({
          title: intent.title,
          head: intent.headRef,
          base: intent.baseRef,
          body: intent.body,
          draft: intent.draft,
        });
        remote(
          hc.ctx,
          op,
          client,
          'POST',
          'pulls',
          { head: intent.headRef, base: intent.baseRef },
          {
            status: 201,
            remoteId: String(pr.number),
          },
        );
      } catch (error) {
        remote(
          hc.ctx,
          op,
          client,
          'POST',
          'pulls',
          { head: intent.headRef, base: intent.baseRef },
          {
            status:
              error instanceof CrewError && typeof error.details?.status === 'number' ? error.details.status : null,
          },
        );
        throw error;
      }
    }
    const created = pr;
    const observed = await observePullRequest(
      client,
      created,
      created.baseRef,
      new Map<string, BranchRequirements>(),
      null,
    );
    settle(
      hc,
      op,
      { status: 'succeeded', remoteCorrelation: { number: created.number, reconciled: existing.length > 0 } },
      (db, at) => {
        const change = applyObservation(
          db,
          intent.repositoryId,
          observed,
          at,
          { taskId: intent.taskId, expectedRemoteHead: intent.headSha ?? created.headSha },
          hc.hooks,
        );
        recordTransition(
          db,
          {
            type: 'pr.submitted',
            actor: OUTBOX_ACTOR,
            prId: change.prId,
            taskId: intent.taskId,
            payload: {
              number: created.number,
              url: created.url,
              headRef: intent.headRef,
              attached: existing.length > 0,
            },
          },
          {
            action: 'github.create_pr',
            input: intent,
            decision: existing.length > 0 ? 'attached' : 'created',
            remoteResult: { number: created.number },
          },
          at,
        );
      },
    );
  } catch (error) {
    handleError(hc, op, client, error, () => {});
  }
}

async function handleUpdatePullRequest(hc: HandlerContext, op: OutboxOperation): Promise<void> {
  const intent = op.intent as UpdatePullRequestIntent;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const updated = await client.updatePullRequest(intent.number, intent.patch);
    remote(hc.ctx, op, client, 'PATCH', `pulls/${intent.number}`, intent.patch, { status: 200 });
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { baseRef: updated.baseRef } }, (db, at) => {
      db.query('UPDATE pull_requests SET title = ?, base_ref = ?, updated_at = ? WHERE id = ?').run(
        updated.title,
        updated.baseRef,
        at,
        intent.prId,
      );
    });
  } catch (error) {
    handleError(hc, op, client, error, () => {});
  }
}

const HANDLERS: Record<GitHubOutboxKind, (hc: HandlerContext, op: OutboxOperation) => Promise<void>> = {
  'github.merge': handleMerge,
  'github.merge_async': handleMergeAsync,
  'github.enqueue': handleEnqueue,
  'github.create_pr': handleCreatePullRequest,
  'github.update_pr': handleUpdatePullRequest,
};

export interface ProcessOutboxOptions {
  leaderId: string;
  env?: IntegrationEnv;
  limit?: number;
}

export async function processIntegrationOutbox(ctx: CrewContext, options: ProcessOutboxOptions): Promise<OutboxReport> {
  const env = options.env ?? {};
  const report: OutboxReport = { processed: 0, succeeded: [], ambiguous: [], failed: [], deferred: [] };
  const hooks: PendingHook[] = [];
  const hc: HandlerContext = { ctx, env, leaderId: options.leaderId, hooks, report };
  const claimed = claimDueOutbox(ctx.store, options.limit ?? 10, [...GITHUB_OUTBOX_KINDS]);
  for (const op of claimed) {
    report.processed++;
    if (op.attempts > op.maxAttempts) {
      const intent = op.intent as Record<string, unknown>;
      settle(
        hc,
        op,
        { status: 'failed', error: `gave up after ${op.attempts - 1} attempts: ${op.lastError ?? ''}` },
        (db, at) => {
          if (typeof intent.prId === 'string') {
            failMergeInTx(
              db,
              hc,
              op,
              intent.prId,
              new CrewError(
                op.status === 'ambiguous' ? 'AMBIGUOUS_REMOTE_OUTCOME' : 'EXTERNAL_FAILURE',
                op.lastError ?? 'exhausted',
                {
                  retryable: false,
                },
              ),
              at,
            );
          }
        },
      );
      continue;
    }
    const handler = HANDLERS[op.kind as GitHubOutboxKind];
    try {
      await handler(hc, op);
    } catch (error) {
      ctx.logger.error('outbox handler crashed', { operationId: op.operationId, kind: op.kind, error: String(error) });
      defer(hc, op, error);
    }
  }
  await runHooks(ctx, env.hooks, hooks);
  return report;
}
