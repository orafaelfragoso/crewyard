import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, nowIso, type Risk } from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition, toJson } from '@crewyard/storage';
import { type PendingHook, runHooks } from './env.ts';
import {
  ACTIVE_ENTRY_STATUSES,
  type Blocker,
  type CandidateStatus,
  type CandidateStep,
  type ChecksState,
  type Divergence,
  type Governance,
  type IntegrationCandidate,
  type IntegrationEnv,
  type IntegrationQueue,
  type PullRequestRecord,
  type QueueEntry,
  type QueueEntryStatus,
  type QueueMode,
} from './types.ts';

export interface PullRequestRow {
  id: string;
  repository_id: string;
  number: number;
  task_id: string | null;
  url: string | null;
  title: string;
  author: string | null;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string | null;
  expected_remote_head: string | null;
  state: 'open' | 'closed' | 'merged';
  is_draft: number;
  mergeable: string | null;
  merge_state_status: string | null;
  review_decision: string | null;
  checks_state: ChecksState | null;
  checks: string;
  reviews: string;
  rules: string | null;
  changed_files: string | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
  stack_id: string | null;
  stack_order: number | null;
  imported: number;
  external_divergence: string | null;
  remote_updated_at: string | null;
  etag: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export const mapPullRequest = (r: PullRequestRow): PullRequestRecord => ({
  id: r.id,
  repositoryId: r.repository_id,
  number: r.number,
  taskId: r.task_id,
  url: r.url,
  title: r.title,
  author: r.author,
  headRef: r.head_ref,
  headSha: r.head_sha,
  baseRef: r.base_ref,
  baseSha: r.base_sha,
  expectedRemoteHead: r.expected_remote_head,
  state: r.state,
  isDraft: r.is_draft === 1,
  mergeable: r.mergeable,
  mergeStateStatus: r.merge_state_status,
  reviewDecision: r.review_decision,
  checksState: r.checks_state,
  checks: parseJson(r.checks, []),
  reviews: parseJson(r.reviews, []),
  governance: parseJson<Governance | null>(r.rules, null),
  changedFiles: parseJson(r.changed_files, null),
  mergeCommitSha: r.merge_commit_sha,
  mergedAt: r.merged_at,
  stackId: r.stack_id,
  stackOrder: r.stack_order,
  imported: r.imported === 1,
  externalDivergence: parseJson<Divergence | null>(r.external_divergence, null),
  remoteUpdatedAt: r.remote_updated_at,
  lastSyncedAt: r.last_synced_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function pullRequestById(db: Database, id: string): PullRequestRecord | null {
  const row = one<PullRequestRow>(db, 'SELECT * FROM pull_requests WHERE id = ?', id);
  return row ? mapPullRequest(row) : null;
}

export function pullRequestByNumber(db: Database, repositoryId: string, number: number): PullRequestRecord | null {
  const row = one<PullRequestRow>(
    db,
    'SELECT * FROM pull_requests WHERE repository_id = ? AND number = ?',
    repositoryId,
    number,
  );
  return row ? mapPullRequest(row) : null;
}

export function requirePullRequest(db: Database, id: string): PullRequestRecord {
  const pr = pullRequestById(db, id);
  if (!pr) {
    throw new CrewError('NOT_FOUND', `Pull request not found: ${id}`, {
      suggestion: 'Run `crew pr sync` or `crew pr import` first.',
    });
  }
  return pr;
}

interface QueueRow {
  id: string;
  repository_id: string;
  base_branch: string;
  mode: QueueMode;
  paused: number;
  capacity: number;
  created_at: string;
  updated_at: string;
}

export const mapQueue = (r: QueueRow): IntegrationQueue => ({
  id: r.id,
  repositoryId: r.repository_id,
  baseBranch: r.base_branch,
  mode: r.mode,
  paused: r.paused === 1,
  capacity: r.capacity,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function queueById(db: Database, id: string): IntegrationQueue | null {
  const row = one<QueueRow>(db, 'SELECT * FROM integration_queues WHERE id = ?', id);
  return row ? mapQueue(row) : null;
}

export function queueFor(db: Database, repositoryId: string, baseBranch: string): IntegrationQueue | null {
  const row = one<QueueRow>(
    db,
    'SELECT * FROM integration_queues WHERE repository_id = ? AND base_branch = ?',
    repositoryId,
    baseBranch,
  );
  return row ? mapQueue(row) : null;
}

export function queuesForRepository(db: Database, repositoryId: string): IntegrationQueue[] {
  return all<QueueRow>(
    db,
    'SELECT * FROM integration_queues WHERE repository_id = ? ORDER BY base_branch',
    repositoryId,
  ).map(mapQueue);
}

interface EntryRow {
  id: string;
  queue_id: string;
  pr_id: string;
  priority: number;
  risk: Risk;
  stack_id: string | null;
  stack_order: number | null;
  status: QueueEntryStatus;
  blockers: string;
  attempts: number;
  last_validated_base_sha: string | null;
  last_validated_head_sha: string | null;
  requested_by: string;
  enqueued_at: string;
  updated_at: string;
}

export const mapEntry = (r: EntryRow): QueueEntry => ({
  id: r.id,
  queueId: r.queue_id,
  prId: r.pr_id,
  priority: r.priority,
  risk: r.risk,
  stackId: r.stack_id,
  stackOrder: r.stack_order,
  status: r.status,
  blockers: parseJson<Blocker[]>(r.blockers, []),
  attempts: r.attempts,
  lastValidatedBaseSha: r.last_validated_base_sha,
  lastValidatedHeadSha: r.last_validated_head_sha,
  requestedBy: r.requested_by,
  enqueuedAt: r.enqueued_at,
  updatedAt: r.updated_at,
});

const ACTIVE_SQL = ACTIVE_ENTRY_STATUSES.map((s) => `'${s}'`).join(',');

export function activeEntries(db: Database, queueId: string): QueueEntry[] {
  return all<EntryRow>(
    db,
    `SELECT * FROM queue_entries WHERE queue_id = ? AND status IN (${ACTIVE_SQL}) ORDER BY enqueued_at, id`,
    queueId,
  ).map(mapEntry);
}

export function activeEntryForPr(db: Database, prId: string): QueueEntry | null {
  const row = one<EntryRow>(
    db,
    `SELECT * FROM queue_entries WHERE pr_id = ? AND status IN (${ACTIVE_SQL}) ORDER BY enqueued_at DESC LIMIT 1`,
    prId,
  );
  return row ? mapEntry(row) : null;
}

export function entryById(db: Database, id: string): QueueEntry | null {
  const row = one<EntryRow>(db, 'SELECT * FROM queue_entries WHERE id = ?', id);
  return row ? mapEntry(row) : null;
}

export function setEntryStatus(
  db: Database,
  entryId: string,
  status: QueueEntryStatus,
  at: string,
  extra: { blockers?: Blocker[]; attempts?: number; validatedBase?: string | null; validatedHead?: string | null } = {},
): void {
  db.query(
    `UPDATE queue_entries SET status = ?, blockers = COALESCE(?, blockers), attempts = COALESCE(?, attempts),
       last_validated_base_sha = CASE WHEN ? THEN ? ELSE last_validated_base_sha END,
       last_validated_head_sha = CASE WHEN ? THEN ? ELSE last_validated_head_sha END,
       updated_at = ? WHERE id = ?`,
  ).run(
    status,
    extra.blockers ? toJson(extra.blockers) : null,
    extra.attempts ?? null,
    extra.validatedBase !== undefined ? 1 : 0,
    extra.validatedBase ?? null,
    extra.validatedHead !== undefined ? 1 : 0,
    extra.validatedHead ?? null,
    at,
    entryId,
  );
}

interface CandidateRow {
  id: string;
  queue_id: string;
  base_sha: string;
  entries: string;
  tree_sha: string | null;
  commit_sha: string | null;
  policy_revision: number;
  rules_fingerprint: string | null;
  status: CandidateStatus;
  ci_evidence: string;
  integration_validated: number;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export const mapCandidate = (r: CandidateRow): IntegrationCandidate => ({
  id: r.id,
  queueId: r.queue_id,
  baseSha: r.base_sha,
  entries: parseJson<CandidateStep[]>(r.entries, []),
  treeSha: r.tree_sha,
  commitSha: r.commit_sha,
  policyRevision: r.policy_revision,
  rulesFingerprint: r.rules_fingerprint,
  status: r.status,
  ciEvidence: parseJson(r.ci_evidence, {}),
  integrationValidated: r.integration_validated === 1,
  invalidReason: r.invalid_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

export function candidateById(db: Database, id: string): IntegrationCandidate | null {
  const row = one<CandidateRow>(db, 'SELECT * FROM integration_candidates WHERE id = ?', id);
  return row ? mapCandidate(row) : null;
}

export function activeCandidates(db: Database, queueId?: string): IntegrationCandidate[] {
  return all<CandidateRow>(
    db,
    `SELECT * FROM integration_candidates WHERE status IN ('building', 'validating', 'valid') ${queueId ? 'AND queue_id = ?' : ''} ORDER BY created_at, id`,
    ...(queueId ? [queueId] : []),
  ).map(mapCandidate);
}

export function listCandidatesForQueue(db: Database, queueId: string, limit = 20): IntegrationCandidate[] {
  return all<CandidateRow>(
    db,
    `SELECT * FROM integration_candidates WHERE queue_id = ? ORDER BY created_at DESC, id DESC LIMIT ${Math.min(limit, 200)}`,
    queueId,
  ).map(mapCandidate);
}

export function invalidateCandidatesInTx(
  db: Database,
  filter: { prId?: string; queueId?: string; candidateId?: string; rulesFingerprintNot?: string },
  reason: string,
  actor: Actor,
  at: string,
): string[] {
  const affected = activeCandidates(db, filter.queueId).filter(
    (c) =>
      (!filter.candidateId || c.id === filter.candidateId) &&
      (!filter.prId || c.entries.some((e) => e.prId === filter.prId && !e.merged)) &&
      (!filter.rulesFingerprintNot || c.rulesFingerprint !== filter.rulesFingerprintNot),
  );
  for (const candidate of affected) {
    db.query(
      `UPDATE integration_candidates SET status = 'invalid', invalid_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(reason, at, candidate.id);
    for (const step of candidate.entries) {
      if (step.merged) continue;
      db.query(
        `UPDATE queue_entries SET status = 'waiting', last_validated_base_sha = NULL, last_validated_head_sha = NULL, updated_at = ?
         WHERE id = ? AND status IN ('candidate', 'validating', 'eligible')`,
      ).run(at, step.entryId);
    }
    recordTransition(
      db,
      {
        type: 'integration.candidate_invalidated',
        actor,
        payload: { candidateId: candidate.id, queueId: candidate.queueId, reason, baseSha: candidate.baseSha },
      },
      { action: 'integration.candidate_invalidate', input: { candidateId: candidate.id, reason }, decision: 'invalid' },
      at,
    );
  }
  return affected.map((c) => c.id);
}

export function listPullRequests(
  ctx: CrewContext,
  filter: { repositoryId?: string; state?: 'open' | 'closed' | 'merged'; taskId?: string; limit?: number } = {},
): PullRequestRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  for (const [col, value] of [
    ['repository_id', filter.repositoryId],
    ['state', filter.state],
    ['task_id', filter.taskId],
  ] as const) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return all<PullRequestRow>(
    ctx.store.db,
    `SELECT * FROM pull_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY repository_id, number LIMIT ${limit}`,
    ...params,
  ).map(mapPullRequest);
}

export function showPullRequest(
  ctx: CrewContext,
  selector: { prId: string } | { repositoryId: string; number: number },
): PullRequestRecord {
  const pr =
    'prId' in selector
      ? pullRequestById(ctx.store.db, selector.prId)
      : pullRequestByNumber(ctx.store.db, selector.repositoryId, selector.number);
  if (!pr) {
    throw new CrewError('NOT_FOUND', 'Pull request not found', {
      suggestion: 'Run `crew pr sync` or `crew pr import` first.',
    });
  }
  return pr;
}

export function setExpectedRemoteHead(
  ctx: CrewContext,
  prId: string,
  headSha: string,
  actor: Actor,
): PullRequestRecord {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const pr = requirePullRequest(db, prId);
    db.query('UPDATE pull_requests SET expected_remote_head = ?, updated_at = ? WHERE id = ?').run(headSha, at, prId);
    recordTransition(
      db,
      { type: 'pr.expected_head_set', actor, prId, taskId: pr.taskId, payload: { headSha } },
      { action: 'pr.expect_head', input: { prId, headSha }, decision: 'accepted' },
      at,
    );
    return requirePullRequest(db, prId);
  });
}

export async function acknowledgeDivergence(
  ctx: CrewContext,
  prId: string,
  actor: Actor,
  env: IntegrationEnv = {},
): Promise<PullRequestRecord> {
  const at = nowIso(ctx.clock);
  const hooks: PendingHook[] = [];
  const record = ctx.store.immediate((db) => {
    const pr = requirePullRequest(db, prId);
    db.query(
      'UPDATE pull_requests SET external_divergence = NULL, expected_remote_head = CASE WHEN expected_remote_head IS NULL THEN NULL ELSE head_sha END, updated_at = ? WHERE id = ?',
    ).run(at, prId);
    recordTransition(
      db,
      {
        type: 'pr.divergence_acknowledged',
        actor,
        prId,
        taskId: pr.taskId,
        payload: { divergence: pr.externalDivergence, headSha: pr.headSha },
      },
      { action: 'pr.acknowledge_divergence', input: { prId }, decision: 'accepted' },
      at,
    );
    if (pr.taskId && pr.expectedRemoteHead !== null) {
      hooks.push({
        name: 'onRemoteHeadAccepted',
        event: { taskId: pr.taskId, prId, prNumber: pr.number, repositoryId: pr.repositoryId, headSha: pr.headSha },
      });
    }
    return requirePullRequest(db, prId);
  });
  await runHooks(ctx, env.hooks, hooks);
  return record;
}

export function setPullRequestDependency(
  ctx: CrewContext,
  input: { prId: string; dependsOnPrId: string; kind?: 'stack_parent' | 'task_dependency' },
  actor: Actor,
): void {
  if (input.prId === input.dependsOnPrId) throw new CrewError('CYCLE_DETECTED', 'A PR cannot depend on itself');
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    requirePullRequest(db, input.prId);
    requirePullRequest(db, input.dependsOnPrId);
    const seen = new Set<string>();
    const stack = [input.dependsOnPrId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === input.prId) throw new CrewError('CYCLE_DETECTED', 'PR dependency would create a cycle');
      if (seen.has(current)) continue;
      seen.add(current);
      for (const row of all<{ depends_on_pr_id: string }>(
        db,
        'SELECT depends_on_pr_id FROM pr_dependencies WHERE pr_id = ?',
        current,
      )) {
        stack.push(row.depends_on_pr_id);
      }
    }
    db.query('INSERT OR REPLACE INTO pr_dependencies (pr_id, depends_on_pr_id, kind) VALUES (?, ?, ?)').run(
      input.prId,
      input.dependsOnPrId,
      input.kind ?? 'task_dependency',
    );
    recordTransition(
      db,
      { type: 'pr.dependency_set', actor, prId: input.prId, payload: { ...input } },
      { action: 'pr.set_dependency', input, decision: 'accepted' },
      at,
    );
  });
}

export function dependenciesOf(
  db: Database,
  prId: string,
): { prId: string; kind: 'stack_parent' | 'task_dependency' }[] {
  return all<{ depends_on_pr_id: string; kind: 'stack_parent' | 'task_dependency' }>(
    db,
    'SELECT depends_on_pr_id, kind FROM pr_dependencies WHERE pr_id = ? ORDER BY kind, depends_on_pr_id',
    prId,
  ).map((r) => ({ prId: r.depends_on_pr_id, kind: r.kind }));
}
