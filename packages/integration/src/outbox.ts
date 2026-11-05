import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, addSeconds, CrewError, git, gitText, newId, nowIso, sleep } from '@crewyard/core';
import type {
  AsyncMergeAction,
  BranchRequirements,
  GitHubClient,
  GitHubPullRequest,
  MergeMethod,
  MergeResult,
  UpdatePullRequestInput,
} from '@crewyard/github';
import { invalidateUnusableReviewEvidenceInTx } from '@crewyard/reviews';
import {
  acquireLeadership,
  assertOutboxClaim,
  type ClaimedOutboxOperation,
  type CrewContext,
  claimDueOutbox,
  completeOutbox,
  type EnqueueInput,
  enqueueOutbox,
  getExecutionClaim,
  getOutbox,
  isLeader,
  type OutboxOperation,
  one,
  recordRemoteOperation,
  recordTransition,
  renewOutboxClaim,
  toJson,
} from '@crewyard/storage';
import {
  CANDIDATE_EVIDENCE_VERSION,
  candidateConfigFingerprint,
  candidateEnvironmentFingerprint,
} from './candidates.ts';
import { eligibilityInputFor, evaluateEligibility, integrationReviewAcceptance } from './eligibility.ts';
import {
  autonomyFor,
  clientFor,
  configFor,
  INTEGRATION_HOOK_KIND,
  leadershipScope,
  type PendingHook,
  processIntegrationHook,
  repositoryFor,
  runHooks,
} from './env.ts';
import { applyEntryFailure, classifyError } from './failures.ts';
import { resolveQueueMode } from './queue.ts';
import {
  activeEntryForPr,
  candidateById,
  dependenciesOf,
  invalidateCandidatesInTx,
  pullRequestById,
  queueById,
  setEntryStatus,
} from './records.ts';
import { applyObservation, observePullRequest } from './sync.ts';
import { markSyncFailure, markSyncSuccess, readFreshness, remoteUnavailable } from './sync-state.ts';
import type {
  CandidateStep,
  IntegrationCandidate,
  IntegrationEnv,
  IntegrationQueue,
  PrefixEvidence,
  PullRequestRecord,
} from './types.ts';

export const GITHUB_OUTBOX_KINDS = [
  'github.merge',
  'github.merge_async',
  'github.enqueue',
  'github.create_pr',
  'github.update_pr',
  'github.update_branch',
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

export interface UpdateBranchIntent extends Record<string, unknown> {
  repositoryId: string;
  prId: string;
  number: number;
  headSha: string;
  baseRef: string;
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
    if (input.expectedState?.guardVersion !== 2 && input.kind !== 'github.create_pr')
      return getOutbox(db, existing.operation_id)!;
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
    recordTransition(
      db,
      {
        type: 'integration.mutation_readmitted',
        actor: OUTBOX_ACTOR,
        payload: { operationId: existing.operation_id, previousStatus: existing.status },
      },
      {
        action: 'integration.readmit',
        input: { operationId: existing.operation_id, expectedState: input.expectedState },
        decision: 'pending',
      },
      at,
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

function scopeFor(op: ClaimedOutboxOperation): string | null {
  const intent = op.intent as Record<string, unknown>;
  if (
    op.kind === 'github.create_pr' ||
    (op.kind === 'github.update_pr' && !(intent.patch as UpdatePullRequestInput).base)
  )
    return null;
  if (op.kind === 'github.update_pr')
    return leadershipScope(String(intent.repositoryId), String((intent.patch as UpdatePullRequestInput).base));
  return leadershipScope(String(intent.repositoryId), String(intent.baseRef));
}

function remote(
  ctx: CrewContext,
  op: ClaimedOutboxOperation,
  client: GitHubClient,
  method: string,
  target: string,
  request: unknown,
  result: { status: number | null; remoteId?: string | null; body?: unknown },
): void {
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    assertOutboxClaim(db, op, at);
    return recordRemoteOperation(
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
    );
  });
}

function settle(
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
  outcome: Parameters<typeof completeOutbox>[2],
  extra?: (db: Database, at: string) => void,
): void {
  const at = nowIso(hc.ctx.clock);
  hc.ctx.store.immediate((db) => {
    completeOutbox(db, op, outcome, at);
    extra?.(db, at);
  });
  if (outcome.status === 'succeeded') hc.report.succeeded.push(op.operationId);
  else if (outcome.status === 'ambiguous') hc.report.ambiguous.push(op.operationId);
  else if (outcome.status === 'retry') hc.report.deferred.push(op.operationId);
  else hc.report.failed.push(op.operationId);
}

function defer(hc: HandlerContext, op: ClaimedOutboxOperation, error: unknown, untilIso?: string | null): void {
  const message = error instanceof Error ? error.message : String(error);
  if (op.status === 'ambiguous') {
    settle(hc, op, { status: 'ambiguous', error: message, ...(untilIso ? { nextAttemptAt: untilIso } : {}) });
    return;
  }
  settle(hc, op, {
    status: 'retry',
    error: message,
    attempts: op.attempts,
    nextAttemptAt: untilIso ?? addSeconds(nowIso(hc.ctx.clock), 1),
  });
}

function acceptedMergeSha(db: Database, operationId: string): string | null {
  return (
    one<{ remote_id: string }>(
      db,
      `SELECT remote_id FROM remote_operations WHERE operation_id = ? AND method = 'PUT' AND remote_id IS NOT NULL
         AND json_extract(result, '$.merged') = 1 ORDER BY at DESC LIMIT 1`,
      operationId,
    )?.remote_id ?? null
  );
}

function startedMutation(db: Database, operationId: string): boolean {
  const row = one<{ response_status: number | null }>(
    db,
    "SELECT response_status FROM remote_operations WHERE operation_id = ? AND method IN ('PUT', 'POST') ORDER BY rowid DESC LIMIT 1",
    operationId,
  );
  return row !== null && (row.response_status === null || row.response_status < 400 || row.response_status >= 500);
}

function acceptedAsyncUuid(db: Database, operationId: string): string | null {
  return (
    one<{ remote_id: string }>(
      db,
      "SELECT remote_id FROM remote_operations WHERE operation_id = ? AND method = 'PUT' AND json_extract(result, '$.uuid') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      operationId,
    )?.remote_id ?? null
  );
}

function finalizeMergedInTx(
  db: Database,
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
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
  if (entry) setEntryStatus(db, entry.id, 'merged', at, { blockers: [] });
  if (pr.taskId && !pr.mergeCommitSha) {
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
  if (candidateId) {
    const candidate = candidateById(db, candidateId);
    if (candidate) {
      const steps: CandidateStep[] = candidate.entries.map((s) =>
        s.prId === prId ? { ...s, merged: true, mergeCommitSha: observed.mergeCommitSha } : s,
      );
      const allMerged = steps.every((s) => s.merged);
      db.query('UPDATE integration_candidates SET entries = ?, status = ?, updated_at = ? WHERE id = ?').run(
        toJson(steps),
        allMerged && candidate.status === 'valid' ? 'merged' : candidate.status,
        at,
        candidateId,
      );
    }
  }
  if (pr.mergeCommitSha === observed.mergeCommitSha) return;
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
  op: ClaimedOutboxOperation,
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
  op: ClaimedOutboxOperation,
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
  op: ClaimedOutboxOperation,
  client: GitHubClient | null,
  error: unknown,
  onFail: (db: Database, at: string) => void,
): void {
  if (error instanceof CrewError) {
    if (error.code === 'STALE_LEASE') return;
    if (error.details?.admissionDenied) {
      settle(hc, op, { status: 'cancelled', error: error.message }, (db, at) => {
        const intent = op.intent as Record<string, unknown>;
        if (typeof intent.candidateId === 'string')
          invalidateCandidatesInTx(db, { candidateId: intent.candidateId }, error.message, OUTBOX_ACTOR, at);
        const ids = Array.isArray(intent.prIds) ? intent.prIds : [intent.prId];
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          const entry = activeEntryForPr(db, id);
          if (entry && entry.status === 'merging')
            setEntryStatus(db, entry.id, 'waiting', at, { validatedBase: null, validatedHead: null });
        }
        recordTransition(
          db,
          {
            type: 'integration.mutation_refused',
            actor: OUTBOX_ACTOR,
            payload: { operationId: op.operationId, reason: error.message },
          },
          { action: op.kind, input: op.intent, decision: 'cancelled' },
          at,
        );
      });
      return;
    }
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

export function mutationExpectedState(
  db: Database,
  config: CrewConfig,
  queue: IntegrationQueue,
  prs: readonly PullRequestRecord[],
  baseSha: string,
  candidateId: string | null,
): Record<string, unknown> {
  const project = one<{ policy_revision: number }>(
    db,
    'SELECT p.policy_revision FROM projects p JOIN repositories r ON r.project_id = p.id WHERE r.id = ?',
    queue.repositoryId,
  )!;
  return {
    guardVersion: 2,
    admissionId: newId('op'),
    queueId: queue.id,
    mode: queue.mode,
    policyRevision: project.policy_revision,
    configFingerprint: candidateConfigFingerprint(config),
    baseSha,
    baseRef: queue.baseBranch,
    candidateId,
    heads: prs.map((pr) => ({ prId: pr.id, headSha: pr.headSha, baseRef: pr.baseRef })),
  };
}

function refuse(reason: string): never {
  throw new CrewError('POLICY_DENIED', reason, { retryable: false, details: { admissionDenied: true } });
}

function assertDelivery(
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
  guard: { scope: string; generation: number },
): void {
  hc.ctx.store.immediate((db) => assertOutboxClaim(db, op, nowIso(hc.ctx.clock)));
  if (!stillLeader(hc, guard)) throw new CrewError('LEASE_CONFLICT', 'integration leadership lost');
}

interface ExpectedHead {
  prId: string;
  headSha: string;
  baseRef: string;
}

function expectedHeads(op: ClaimedOutboxOperation): ExpectedHead[] {
  if (
    op.expectedState.guardVersion !== 2 ||
    !Array.isArray(op.expectedState.heads) ||
    op.expectedState.heads.length === 0
  ) {
    return refuse('legacy_intent_requires_readmission');
  }
  return op.expectedState.heads.map((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('prId' in value) ||
      typeof value.prId !== 'string' ||
      !('headSha' in value) ||
      typeof value.headSha !== 'string' ||
      !('baseRef' in value) ||
      typeof value.baseRef !== 'string'
    )
      return refuse('invalid_expected_heads');
    return { prId: value.prId, headSha: value.headSha, baseRef: value.baseRef };
  });
}

function checkCandidate(
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
  config: CrewConfig,
  queue: IntegrationQueue,
  prs: readonly PullRequestRecord[],
): IntegrationCandidate | null {
  const candidateId = op.expectedState.candidateId;
  if (
    candidateId === null &&
    op.kind !== 'github.merge' &&
    !(op.kind === 'github.merge_async' && op.intent.action === 'direct_merge')
  )
    return null;
  if (typeof candidateId !== 'string' || op.intent.candidateId !== candidateId) return refuse('candidate_required');
  const candidate = candidateById(hc.ctx.store.db, candidateId);
  const at = nowIso(hc.ctx.clock);
  if (!candidate || candidate.queueId !== queue.id || candidate.status !== 'valid')
    return refuse('candidate_not_valid');
  if (
    !candidate.expiresAt ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.parse(at)
  )
    return refuse('candidate_expired');
  if (candidate.policyRevision !== op.expectedState.policyRevision) return refuse('candidate_policy_changed');
  if (candidate.ciEvidence.version !== CANDIDATE_EVIDENCE_VERSION || !Array.isArray(candidate.ciEvidence.prefixes))
    return refuse('candidate_evidence_unsupported');
  const execution = getExecutionClaim(hc.ctx.store.db, `integration:candidate:${candidate.id}`);
  if (
    !execution ||
    execution.attemptId !== candidate.ciEvidence.attemptId ||
    execution.generation !== candidate.ciEvidence.generation ||
    execution.releasedAt === null
  )
    return refuse('candidate_execution_not_completed');
  const prefixes = candidate.ciEvidence.prefixes as PrefixEvidence[];
  if (op.kind === 'github.merge_async' && candidate.entries.filter((entry) => !entry.merged).length !== prs.length)
    return refuse('candidate_stack_incomplete');
  for (const pr of prs) {
    const index = candidate.entries.findIndex((s) => s.prId === pr.id && s.headSha === pr.headSha && !s.merged);
    if (index < 0) return refuse('candidate_head_changed');
    const step = candidate.entries[index]!;
    const evidence = prefixes[index];
    if (
      !evidence ||
      evidence.prId !== step.prId ||
      evidence.headSha !== step.headSha ||
      evidence.treeSha !== step.treeSha ||
      evidence.commitSha !== step.commitSha ||
      evidence.configFingerprint !== candidateConfigFingerprint(config) ||
      evidence.envFingerprint !== candidateEnvironmentFingerprint(config) ||
      evidence.policyRevision !== candidate.policyRevision ||
      evidence.expiresAt !== candidate.expiresAt ||
      !['passed', 'not_configured'].includes(evidence.status)
    )
      return refuse('prefix_evidence_invalid');
    if (evidence.status === 'passed') {
      const run = one<{
        status: string;
        tree_sha: string;
        commit_sha: string;
        env_fingerprint: string;
        candidate_id: string;
      }>(
        hc.ctx.store.db,
        'SELECT status, tree_sha, commit_sha, env_fingerprint, candidate_id FROM validation_runs WHERE id = ?',
        evidence.validationId,
      );
      if (
        run?.status !== 'passed' ||
        run.tree_sha !== evidence.treeSha ||
        run.commit_sha !== evidence.commitSha ||
        run.env_fingerprint !== evidence.envFingerprint ||
        run.candidate_id !== candidate.id
      )
        return refuse('prefix_validation_missing');
    } else if (config.validation.broad.length > 0 || evidence.validationId !== null)
      return refuse('prefix_validation_required');
    if (candidate.entries.length > 1 && evidence.status !== 'passed' && evidence.attestation !== 'exact-head-checks')
      return refuse('prefix_validation_required');
    if ((pr.governance?.requirements?.fingerprint ?? null) !== candidate.rulesFingerprint)
      return refuse('rules_changed');
    if (op.kind === 'github.merge') {
      const previous = candidate.entries[index - 1];
      const expectedBase = previous ? previous.merged && previous.mergeCommitSha : candidate.baseSha;
      if (!expectedBase || op.expectedState.baseSha !== expectedBase || op.intent.expectedBaseSha !== expectedBase)
        return refuse('candidate_prefix_base_changed');
    }
  }
  return candidate;
}

async function admitMutation(
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
  client: GitHubClient,
  guard: { scope: string; generation: number },
  retargeted: boolean,
): Promise<void> {
  const heads = expectedHeads(op);
  const ownHead = heads.find((head) => head.prId === op.intent.prId);
  const ownRecord = ownHead ? pullRequestById(hc.ctx.store.db, ownHead.prId) : null;
  if (
    !ownHead ||
    !ownRecord ||
    ownRecord.number !== op.intent.number ||
    ('headSha' in op.intent && ownHead.headSha !== op.intent.headSha)
  )
    return refuse('intent_target_changed');
  if (
    op.kind === 'github.merge_async' &&
    (!Array.isArray(op.intent.prIds) ||
      op.intent.prIds.length !== heads.length ||
      op.intent.prIds.some((id) => !heads.some((head) => head.prId === id)))
  )
    return refuse('stack_members_changed');
  const repository = repositoryFor(hc.ctx, String(op.intent.repositoryId));
  const baseRef = op.expectedState.baseRef;
  const expectedBase = op.expectedState.baseSha;
  if (op.kind === 'github.merge' && op.intent.retargetBase !== null && op.intent.retargetBase !== baseRef)
    return refuse('retarget_changed');
  if (op.kind === 'github.merge' && ownHead.baseRef !== baseRef && op.intent.retargetBase !== baseRef)
    return refuse('merge_target_changed');
  if (typeof baseRef !== 'string' || typeof expectedBase !== 'string') return refuse('expected_base_required');
  if (op.attempts > op.maxAttempts) return refuse('mutation_retry_budget_exhausted');
  if (remoteUnavailable(readFreshness(hc.ctx.store.db, repository.id), hc.ctx.clock.now()))
    return refuse('remote_state_stale');
  const observations: Awaited<ReturnType<typeof observePullRequest>>[] = [];
  for (const expected of heads) {
    const record = pullRequestById(hc.ctx.store.db, expected.prId);
    if (!record || record.repositoryId !== repository.id) return refuse('pull_request_missing');
    const observed = await client.getPullRequest(record.number);
    if (observed.state !== 'open' || observed.headSha !== expected.headSha) return refuse('head_or_state_changed');
    const target = retargeted ? baseRef : expected.baseRef;
    if (observed.baseRef !== target) return refuse('target_changed');
    observations.push(
      await observePullRequest(
        hc.ctx,
        client,
        observed,
        baseRef,
        new Map<string, BranchRequirements>(),
        record.headSha,
        repository,
      ),
    );
    for (const dependency of dependenciesOf(hc.ctx.store.db, record.id)) {
      if (heads.some((h) => h.prId === dependency.prId) && op.kind === 'github.merge_async') continue;
      const parent = pullRequestById(hc.ctx.store.db, dependency.prId);
      if (!parent || (await client.getPullRequest(parent.number)).state !== 'merged')
        return refuse('dependency_not_merged');
    }
  }
  const live = await client.getBranch(baseRef);
  if (live.sha !== expectedBase) return refuse(`base_changed:${expectedBase.slice(0, 12)}->${live.sha.slice(0, 12)}`);
  assertDelivery(hc, op, guard);
  hc.ctx.store.immediate((db) => {
    assertOutboxClaim(db, op, nowIso(hc.ctx.clock));
    for (const observation of observations)
      applyObservation(db, repository.id, observation, nowIso(hc.ctx.clock), {}, hc.hooks);
    markSyncSuccess(db, repository.id, nowIso(hc.ctx.clock));
  });
  const config = configFor(hc.ctx, hc.env, repository.projectId);
  const queue =
    typeof op.expectedState.queueId === 'string' ? queueById(hc.ctx.store.db, op.expectedState.queueId) : null;
  const policy = one<{ policy_revision: number }>(
    hc.ctx.store.db,
    'SELECT policy_revision FROM projects WHERE id = ?',
    repository.projectId,
  )!;
  if (!queue || queue.repositoryId !== repository.id || queue.baseBranch !== baseRef || queue.paused)
    return refuse('queue_missing_or_paused');
  if (
    policy.policy_revision !== op.expectedState.policyRevision ||
    candidateConfigFingerprint(config) !== op.expectedState.configFingerprint
  )
    return refuse('policy_changed');
  const prs = heads.map((head) => pullRequestById(hc.ctx.store.db, head.prId)!);
  for (const pr of prs) {
    const entry = activeEntryForPr(hc.ctx.store.db, pr.id);
    if (!entry || entry.queueId !== queue.id || ['removed', 'quarantined', 'escalated'].includes(entry.status))
      return refuse('entry_not_actionable');
    if (queue.mode !== op.expectedState.mode || resolveQueueMode(config, pr) !== queue.mode)
      return refuse('queue_mode_changed');
    if (
      (op.kind === 'github.merge' || (op.kind === 'github.merge_async' && op.intent.action === 'direct_merge')) &&
      (queue.mode !== 'crew-managed' || op.intent.mergeMethod !== config.integration.merge_method)
    )
      return refuse('merge_method_or_mode_changed');
    if (
      (op.kind === 'github.enqueue' || (op.kind === 'github.merge_async' && op.intent.action === 'merge_queue')) &&
      queue.mode !== 'github-managed'
    )
      return refuse('queue_mode_changed');
    hc.ctx.store.immediate((db) => {
      assertOutboxClaim(db, op, nowIso(hc.ctx.clock));
      invalidateUnusableReviewEvidenceInTx(
        db,
        pr.id,
        pr.headSha,
        integrationReviewAcceptance(hc.ctx, hc.env, config, repository.id, pr.baseSha),
        OUTBOX_ACTOR,
      );
    });
    const evaluation = evaluateEligibility(
      eligibilityInputFor(hc.ctx.store.db, pr, {
        autonomy: autonomyFor(hc.ctx, repository.projectId),
        config,
        mode: queue.mode,
        queuePaused: queue.paused,
        reviewAcceptance: integrationReviewAcceptance(hc.ctx, hc.env, config, repository.id, pr.baseSha),
      }),
    );
    const blockers = evaluation.blockers.filter((b) => {
      if (
        b.soft &&
        typeof b.details?.parentPrId === 'string' &&
        op.kind === 'github.merge_async' &&
        heads.some((h) => h.prId === b.details!.parentPrId)
      )
        return false;
      if (
        op.kind === 'github.update_branch' &&
        b.code === 'BRANCH_BEHIND_BASE' &&
        config.integration.rebasing !== 'never'
      )
        return false;
      return true;
    });
    if (blockers.length > 0) return refuse(`not_eligible:${blockers.map((b) => b.code).join(',')}`);
  }
  checkCandidate(hc, op, config, queue, prs);
  assertDelivery(hc, op, guard);
}

async function verifyMergedTree(
  hc: HandlerContext,
  op: ClaimedOutboxOperation,
  prId: string,
  mergeSha: string,
): Promise<void> {
  const candidateId = op.intent.candidateId;
  if (typeof candidateId !== 'string') return;
  const candidate = candidateById(hc.ctx.store.db, candidateId);
  const step = candidate?.entries.find((entry) => entry.prId === prId);
  if (!candidate || !step?.treeSha) return;
  const repository = repositoryFor(hc.ctx, String(op.intent.repositoryId));
  await git(repository.canonicalPath, ['fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', mergeSha]);
  const tree = await gitText(repository.canonicalPath, ['rev-parse', `${mergeSha}^{tree}`]);
  hc.ctx.store.immediate((db) => {
    assertOutboxClaim(db, op, nowIso(hc.ctx.clock));
    const at = nowIso(hc.ctx.clock);
    recordTransition(
      db,
      {
        type: 'integration.merge_tree_observed',
        actor: OUTBOX_ACTOR,
        prId,
        payload: {
          repositoryId: repository.id,
          prId,
          mergeCommitSha: mergeSha,
          candidateId,
          mergeSha,
          expectedTree: step.treeSha,
          observedTree: tree,
          matched: tree === step.treeSha,
        },
      },
      {
        action: 'integration.compare_merge_tree',
        input: { candidateId, mergeSha },
        decision: tree === step.treeSha ? 'matched' : 'mismatch',
      },
      at,
    );
    if (tree !== step.treeSha) {
      invalidateCandidatesInTx(db, { candidateId }, 'merged_tree_differs_from_candidate', OUTBOX_ACTOR, at);
      db.query('UPDATE integration_queues SET paused = 1, updated_at = ? WHERE id = ?').run(at, candidate.queueId);
    }
  });
}

async function handleMerge(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
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
      const mergeCommitSha = observed.mergeCommitSha ?? acceptedMergeSha(hc.ctx.store.db, op.operationId);
      if (!mergeCommitSha) {
        settle(hc, op, { status: 'ambiguous', error: 'merged without observable merge commit yet' });
        return;
      }
      const merged = { ...observed, mergeCommitSha };
      await verifyMergedTree(hc, op, intent.prId, mergeCommitSha);
      settle(hc, op, { status: 'succeeded', remoteCorrelation: { mergeCommitSha, reconciled: true } }, (db, at) =>
        finalizeMergedInTx(db, hc, op, merged, intent.prId, intent.candidateId, at),
      );
      return;
    }
    if (observed.state === 'closed') {
      throw new CrewError('INVALID_TRANSITION', `#${intent.number} was closed without merging`, { retryable: false });
    }
    if (op.status === 'ambiguous' || startedMutation(hc.ctx.store.db, op.operationId)) {
      settle(hc, op, { status: 'ambiguous', error: 'merge outcome not yet observed; refusing a duplicate mutation' });
      return;
    }
    await admitMutation(hc, op, client, guard, observed.baseRef === intent.retargetBase);
    if (intent.retargetBase && observed.baseRef !== intent.retargetBase) {
      assertDelivery(hc, op, guard);
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
      hc.ctx.store.immediate((db) => {
        assertOutboxClaim(db, op, nowIso(hc.ctx.clock));
        db.query('UPDATE pull_requests SET base_ref = ?, updated_at = ? WHERE id = ?').run(
          updated.baseRef,
          nowIso(hc.ctx.clock),
          intent.prId,
        );
      });
      await admitMutation(hc, op, client, guard, true);
    }
    assertDelivery(hc, op, guard);
    let result: MergeResult;
    remote(
      hc.ctx,
      op,
      client,
      'PUT',
      `pulls/${intent.number}/merge`,
      { sha: intent.headSha },
      { status: null, body: { phase: 'started' } },
    );
    try {
      result = await client.mergePullRequest(intent.number, {
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
    const confirmed = await client.getPullRequest(intent.number);
    const mergeCommitSha =
      (confirmed?.state === 'merged' ? confirmed.mergeCommitSha : null) ?? (result.merged ? result.sha : null);
    if (!mergeCommitSha) {
      settle(hc, op, { status: 'ambiguous', error: 'merge accepted but not yet observed as merged' });
      return;
    }
    const merged: GitHubPullRequest = { ...confirmed, state: 'merged', mergeCommitSha };
    await verifyMergedTree(hc, op, intent.prId, mergeCommitSha);
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { mergeCommitSha } }, (db, at) =>
      finalizeMergedInTx(db, hc, op, merged, intent.prId, intent.candidateId, at),
    );
  } catch (error) {
    handleError(hc, op, client, error, (db, at) => failMergeInTx(db, hc, op, intent.prId, error, at));
  }
}

async function handleEnqueue(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
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
    if (startedMutation(hc.ctx.store.db, op.operationId)) {
      settle(hc, op, { status: 'ambiguous', error: 'enqueue outcome unknown; operator reconciliation required' });
      return;
    }
    await admitMutation(hc, op, client, guard, false);
    remote(
      hc.ctx,
      op,
      client,
      'POST',
      'graphql:EnqueuePullRequest',
      { headSha: intent.headSha },
      { status: null, body: { phase: 'started' } },
    );
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

async function handleMergeAsync(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
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
    const merged = observedAll.filter((o) => o.pr.state === 'merged' && o.pr.mergeCommitSha !== null);
    if (merged.length === 0) return false;
    const complete = merged.length === intent.prIds.length;
    for (const o of merged) await verifyMergedTree(hc, op, o.prId, o.pr.mergeCommitSha!);
    settle(
      hc,
      op,
      complete
        ? { status: 'succeeded', remoteCorrelation: { merged: merged.map((o) => o.pr.number) } }
        : {
            status: 'ambiguous',
            error: 'stack partially merged; remaining outcomes require reconciliation',
            remoteCorrelation: {
              uuid: acceptedAsyncUuid(hc.ctx.store.db, op.operationId),
              merged: merged.map((o) => o.pr.number),
            },
          },
      (db, at) => {
        for (const o of merged) finalizeMergedInTx(db, hc, op, o.pr, o.prId, intent.candidateId, at);
        if (!complete) {
          if (intent.candidateId)
            invalidateCandidatesInTx(
              db,
              { candidateId: intent.candidateId },
              'stack_partially_merged',
              OUTBOX_ACTOR,
              at,
            );
          for (const id of intent.prIds) {
            if (merged.some((item) => item.prId === id)) continue;
            const entry = activeEntryForPr(db, id);
            if (entry)
              setEntryStatus(db, entry.id, 'merging', at, {
                blockers: [
                  {
                    code: 'REMOTE_OUTCOME_UNKNOWN',
                    source: 'queue',
                    message: 'A partial stack merge is still being reconciled',
                  },
                ],
              });
          }
        }
      },
    );
    return true;
  };
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    if (await finalizeAll(client)) return;
    let uuid =
      typeof op.remoteCorrelation?.uuid === 'string'
        ? op.remoteCorrelation.uuid
        : acceptedAsyncUuid(hc.ctx.store.db, op.operationId);
    let result = uuid ? await client.getAsyncMergeResult(intent.number, uuid) : null;
    if (!result) {
      if (intent.action === 'merge_queue' && (await client.getPullRequestState(intent.number)).isInMergeQueue) {
        settle(hc, op, { status: 'succeeded', remoteCorrelation: { enqueued: true, reconciled: true } });
        return;
      }
      if (op.status === 'ambiguous' || startedMutation(hc.ctx.store.db, op.operationId)) {
        settle(hc, op, {
          status: 'ambiguous',
          error: 'asynchronous outcome unknown; operator reconciliation required',
        });
        return;
      }
      await admitMutation(hc, op, client, guard, false);
      remote(
        hc.ctx,
        op,
        client,
        'PUT',
        `pulls/${intent.number}/merge-async`,
        { sha: intent.headSha },
        { status: null, body: { phase: 'started' } },
      );
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

async function handleCreatePullRequest(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
  const intent = op.intent as CreatePullRequestIntent;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const existing = (await client.findPullRequestsForHead(intent.headRef)).filter((p) => p.state === 'open');
    let pr = existing.find((p) => p.baseRef === intent.baseRef) ?? existing[0] ?? null;
    if (!pr) {
      try {
        hc.ctx.store.immediate((db) => assertOutboxClaim(db, op, nowIso(hc.ctx.clock)));
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
      hc.ctx,
      client,
      created,
      created.baseRef,
      new Map<string, BranchRequirements>(),
      null,
      repository,
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

async function handleUpdatePullRequest(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
  const intent = op.intent as UpdatePullRequestIntent;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  const guard = await leaderGuard(hc, op);
  if (!guard) return;
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const observed = await client.getPullRequest(intent.number);
    const applied = Object.entries(intent.patch).every(([key, value]) =>
      key === 'base' ? observed.baseRef === value : key === 'title' ? observed.title === value : false,
    );
    if (applied) {
      settle(hc, op, { status: 'succeeded', remoteCorrelation: { reconciled: true, baseRef: observed.baseRef } });
      return;
    }
    if (intent.patch.base) await admitMutation(hc, op, client, guard, false);
    assertDelivery(hc, op, guard);
    const updated = await client.updatePullRequest(intent.number, intent.patch);
    remote(hc.ctx, op, client, 'PATCH', `pulls/${intent.number}`, intent.patch, { status: 200 });
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { baseRef: updated.baseRef } }, (db, at) => {
      db.query('UPDATE pull_requests SET title = ?, base_ref = ?, updated_at = ? WHERE id = ?').run(
        updated.title,
        updated.baseRef,
        at,
        intent.prId,
      );
      invalidateCandidatesInTx(db, { prId: intent.prId }, 'base_retargeted', OUTBOX_ACTOR, at);
      recordTransition(
        db,
        { type: 'pr.updated', actor: OUTBOX_ACTOR, prId: intent.prId, payload: { patch: intent.patch } },
        { action: 'github.update_pr', input: intent, decision: 'updated' },
        at,
      );
    });
  } catch (error) {
    handleError(hc, op, client, error, () => {});
  }
}

async function handleUpdateBranch(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
  const intent = op.intent as UpdateBranchIntent;
  const guard = await leaderGuard(hc, op);
  if (!guard) return;
  const repository = repositoryFor(hc.ctx, intent.repositoryId);
  let client: GitHubClient | null = null;
  try {
    client = await clientFor(hc.ctx, hc.env, repository);
    const current = await client.getPullRequest(intent.number);
    if (current.headSha !== intent.headSha) {
      settle(hc, op, { status: 'succeeded', remoteCorrelation: { headSha: current.headSha, reconciled: true } });
      return;
    }
    await admitMutation(hc, op, client, guard, false);
    await client.updatePullRequestBranch(intent.number, intent.headSha);
    remote(hc.ctx, op, client, 'PUT', `pulls/${intent.number}/update-branch`, intent, { status: 202 });
    const observed = await client.getPullRequest(intent.number);
    const updated =
      observed.headSha !== intent.headSha && (await client.getCommit(observed.headSha)).parents[0] === intent.headSha;
    settle(hc, op, { status: 'succeeded', remoteCorrelation: { headSha: observed.headSha } }, (db, at) => {
      if (!updated) return;
      const pr = pullRequestById(db, intent.prId);
      if (!pr || pr.expectedRemoteHead !== intent.headSha) return;
      db.query('UPDATE pull_requests SET expected_remote_head = ?, updated_at = ? WHERE id = ?').run(
        observed.headSha,
        at,
        pr.id,
      );
      recordTransition(
        db,
        {
          type: 'pr.expected_head_set',
          actor: OUTBOX_ACTOR,
          prId: pr.id,
          taskId: pr.taskId,
          payload: { headSha: observed.headSha, reason: 'update_branch' },
        },
        { action: 'pr.expect_head', input: { prId: pr.id, headSha: observed.headSha }, decision: 'accepted' },
        at,
      );
      if (pr.taskId) {
        hc.hooks.push({
          name: 'onRemoteHeadAccepted',
          event: {
            taskId: pr.taskId,
            prId: pr.id,
            prNumber: pr.number,
            repositoryId: pr.repositoryId,
            headSha: observed.headSha,
          },
        });
      }
    });
  } catch (error) {
    handleError(hc, op, client, error, () => {});
  }
}

async function handleHook(hc: HandlerContext, op: ClaimedOutboxOperation): Promise<void> {
  const status = await processIntegrationHook(hc.ctx, hc.env.hooks, op);
  if (status === 'succeeded') hc.report.succeeded.push(op.operationId);
  else if (status === 'retry') hc.report.deferred.push(op.operationId);
  else hc.report.failed.push(op.operationId);
}

const HANDLERS: Record<
  GitHubOutboxKind | typeof INTEGRATION_HOOK_KIND,
  (hc: HandlerContext, op: ClaimedOutboxOperation) => Promise<void>
> = {
  [INTEGRATION_HOOK_KIND]: handleHook,
  'github.merge': handleMerge,
  'github.merge_async': handleMergeAsync,
  'github.enqueue': handleEnqueue,
  'github.create_pr': handleCreatePullRequest,
  'github.update_pr': handleUpdatePullRequest,
  'github.update_branch': handleUpdateBranch,
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
  for (let i = 0; i < (options.limit ?? 10); i++) {
    const op = claimDueOutbox(ctx.store, {
      ownerId: options.leaderId,
      limit: 1,
      kinds: [...GITHUB_OUTBOX_KINDS, INTEGRATION_HOOK_KIND],
      ttlSeconds: env.leaseTtlSeconds ?? 120,
    })[0];
    if (!op) break;
    report.processed++;
    const handler = HANDLERS[op.kind as keyof typeof HANDLERS];
    const renewal = setInterval(
      () => {
        try {
          renewOutboxClaim(ctx.store, op, env.leaseTtlSeconds ?? 120);
        } catch (error) {
          ctx.logger.warn('outbox claim renewal failed', { operationId: op.operationId, error: String(error) });
        }
      },
      Math.max(1_000, ((env.leaseTtlSeconds ?? 120) * 1_000) / 3),
    );
    try {
      await handler(hc, op);
    } catch (error) {
      ctx.logger.error('outbox handler crashed', { operationId: op.operationId, kind: op.kind, error: String(error) });
      if (!(error instanceof CrewError && error.code === 'STALE_LEASE')) defer(hc, op, error);
    } finally {
      clearInterval(renewal);
    }
  }
  await runHooks(ctx, env.hooks, hooks);
  return report;
}
