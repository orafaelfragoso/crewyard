import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, git, newId, nowIso } from '@crewyard/core';
import type {
  BranchRequirements,
  CheckResult,
  GitHubClient,
  GitHubPullRequest,
  PullRequestFile,
  PullRequestGraphState,
  PullRequestReview,
  WorkflowRun,
} from '@crewyard/github';
import type { Repository } from '@crewyard/projects';
import { invalidateReviewsInTx } from '@crewyard/reviews';
import { all, type CrewContext, one, recordTransition, toJson } from '@crewyard/storage';
import { fetchIntegrationRefs } from './candidates.ts';
import { clientFor, type PendingHook, repositoryFor, runHooks } from './env.ts';
import {
  activeEntryForPr,
  invalidateCandidatesInTx,
  mapPullRequest,
  type PullRequestRow,
  pullRequestByNumber,
  setEntryStatus,
} from './records.ts';
import { markSyncFailure, markSyncSuccess, type RemoteFreshness, readFreshness } from './sync-state.ts';
import type {
  ChecksState,
  Divergence,
  DivergenceKind,
  Governance,
  IntegrationEnv,
  PullRequestRecord,
} from './types.ts';

export const CREW_MERGE_KINDS = ['github.merge', 'github.merge_async', 'github.enqueue'] as const;

export interface ObservedPullRequest {
  pr: GitHubPullRequest;
  files: PullRequestFile[] | null;
  reviews: PullRequestReview[] | null;
  checks: CheckResult[] | null;
  workflowRuns: WorkflowRun[];
  graph: PullRequestGraphState | null;
  requirements: BranchRequirements | null;
  integrationBase: string;
  forcePushed: boolean | null;
  baseMergeParent: string | null;
}

export interface PullRequestChange {
  prId: string;
  number: number;
  changes: string[];
  divergence: DivergenceKind[];
}

export interface SyncResult {
  repositoryId: string;
  ok: boolean;
  offline: boolean;
  rateLimited: boolean;
  observed: number;
  changed: PullRequestChange[];
  merged: { prId: string; number: number; mergeCommitSha: string | null; outsideCrew: boolean }[];
  freshness: RemoteFreshness;
  error: string | null;
}

export function aggregateChecks(checks: readonly CheckResult[]): ChecksState {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

async function isCleanMerge(
  ctx: CrewContext,
  repository: Repository,
  pr: GitHubPullRequest,
  parents: readonly [string, string],
): Promise<boolean> {
  try {
    await fetchIntegrationRefs(ctx, repository, pr.baseSha, [pr], { kind: 'service', id: 'sync' });
  } catch {
    return false;
  }
  const merged = await git(repository.canonicalPath, ['merge-tree', '--write-tree', ...parents], {
    allowFailure: true,
  });
  if (merged.exitCode !== 0) return false;
  const tree = await git(repository.canonicalPath, ['rev-parse', '--verify', '--quiet', `${pr.headSha}^{tree}`], {
    allowFailure: true,
  });
  return tree.exitCode === 0 && merged.stdout.split('\n')[0]!.trim() === tree.stdout.trim();
}

async function detectBaseMerge(
  ctx: CrewContext,
  client: GitHubClient,
  pr: GitHubPullRequest,
  repository: Repository,
): Promise<string | null> {
  try {
    const commit = await client.getCommit(pr.headSha);
    if (commit.parents.length !== 2) return null;
    const parents = commit.parents as [string, string];
    const result = await client.compareCommits(parents[1], pr.baseRef);
    if (result.status !== 'ahead' && result.status !== 'identical') return null;
    return (await isCleanMerge(ctx, repository, pr, parents)) ? parents[0] : null;
  } catch (error) {
    if (error instanceof CrewError && (error.code === 'OFFLINE' || error.code === 'RATE_LIMITED')) throw error;
    return null;
  }
}

async function detectForcePush(client: GitHubClient, previous: string, next: string): Promise<boolean | null> {
  try {
    const result = await client.compareCommits(previous, next);
    return result.status !== 'ahead' && result.status !== 'identical';
  } catch (error) {
    if (error instanceof CrewError && error.code === 'NOT_FOUND') return true;
    if (error instanceof CrewError && (error.code === 'OFFLINE' || error.code === 'RATE_LIMITED')) throw error;
    return null;
  }
}

export async function observePullRequest(
  ctx: CrewContext,
  client: GitHubClient,
  pr: GitHubPullRequest,
  integrationBase: string,
  requirementsCache: Map<string, BranchRequirements>,
  previousHead: string | null,
  repository: Repository | null,
): Promise<ObservedPullRequest> {
  if (pr.state !== 'open') {
    return {
      pr,
      files: null,
      reviews: null,
      checks: null,
      workflowRuns: [],
      graph: null,
      requirements: requirementsCache.get(integrationBase) ?? null,
      integrationBase,
      forcePushed: null,
      baseMergeParent: null,
    };
  }
  let requirements = requirementsCache.get(integrationBase) ?? null;
  if (!requirements) {
    requirements = await client.getBranchRequirements(integrationBase);
    requirementsCache.set(integrationBase, requirements);
  }
  const [files, reviews, checks, workflowRuns, graph] = await Promise.all([
    client.listPullRequestFiles(pr.number),
    client.listReviews(pr.number),
    client.listChecks(pr.headSha),
    client.listWorkflowRuns(pr.headSha),
    client.getPullRequestState(pr.number),
  ]);
  const moved = previousHead !== null && previousHead !== pr.headSha;
  const forcePushed = moved ? await detectForcePush(client, previousHead, pr.headSha) : null;
  const baseMergeParent =
    moved && forcePushed === false && repository ? await detectBaseMerge(ctx, client, pr, repository) : null;
  return {
    pr,
    files,
    reviews,
    checks,
    workflowRuns,
    graph,
    requirements,
    integrationBase,
    forcePushed,
    baseMergeParent,
  };
}

function crewMergeRecorded(db: Database, prId: string): boolean {
  return (
    one(
      db,
      `SELECT 1 FROM outbox WHERE subject_id = ? AND kind IN (${CREW_MERGE_KINDS.map(() => '?').join(',')}) AND status NOT IN ('failed', 'cancelled') LIMIT 1`,
      prId,
      ...CREW_MERGE_KINDS,
    ) !== null
  );
}

function reviewKey(reviews: readonly PullRequestReview[]): string {
  const latest = new Map<string, string>();
  for (const review of reviews) if (review.state !== 'COMMENTED') latest.set(review.reviewer, review.state);
  return [...latest.entries()]
    .sort()
    .map(([who, state]) => `${who}:${state}`)
    .join(',');
}

export interface ApplyOptions {
  imported?: boolean;
  taskId?: string | null;
  expectedRemoteHead?: string | null;
}

export function applyObservation(
  db: Database,
  repositoryId: string,
  obs: ObservedPullRequest,
  at: string,
  options: ApplyOptions,
  hooks: PendingHook[],
): PullRequestChange {
  const actor: Actor = { kind: 'github', id: 'sync' };
  const previous = pullRequestByNumber(db, repositoryId, obs.pr.number);
  const pr = obs.pr;
  const changes: string[] = [];
  const kinds: DivergenceKind[] = [];
  let blocking = false;
  const governance: Governance | null =
    pr.state === 'open'
      ? {
          requirements: obs.requirements,
          integrationBase: obs.integrationBase,
          nodeId: obs.graph?.nodeId ?? null,
          isInMergeQueue: obs.graph?.isInMergeQueue ?? false,
          mergeQueueEntry: obs.graph?.mergeQueueEntry ?? null,
          stack: pr.stack,
          workflowRuns: obs.workflowRuns.map((r) => ({
            name: r.name,
            event: r.event,
            status: r.status,
            conclusion: r.conclusion,
          })),
        }
      : (previous?.governance ?? null);
  const checks = obs.checks ?? previous?.checks ?? [];
  const reviews = obs.reviews ?? previous?.reviews ?? [];
  const expected = options.expectedRemoteHead ?? previous?.expectedRemoteHead ?? null;
  const mergeable = pr.mergeable === 'UNKNOWN' && obs.graph ? obs.graph.mergeable : pr.mergeable;

  let acceptedHead: string | null = null;
  if (previous && previous.headSha !== pr.headSha && previous.state === 'open') {
    changes.push('head_changed');
    if (obs.forcePushed === true) kinds.push('force_push');
    if (expected !== null && pr.headSha !== expected) {
      if (obs.baseMergeParent === expected) {
        acceptedHead = pr.headSha;
        changes.push('base_merged');
      } else {
        blocking = true;
        if (obs.forcePushed !== true) kinds.push('external_push');
      }
    }
  }
  if (previous && previous.baseRef !== pr.baseRef) {
    changes.push('base_retargeted');
    kinds.push('base_retargeted');
  }
  const prevRules = previous?.governance?.requirements?.fingerprint ?? null;
  const nextRules = governance?.requirements?.fingerprint ?? null;
  if (previous && pr.state === 'open' && prevRules !== null && nextRules !== null && prevRules !== nextRules) {
    changes.push('rules_changed');
  }
  if (previous && obs.reviews && reviewKey(previous.reviews) !== reviewKey(obs.reviews)) {
    changes.push('reviews_changed');
    if (previous.reviews.some((r) => r.state === 'APPROVED') && !obs.reviews.some((r) => r.state === 'APPROVED')) {
      kinds.push('reviewers_changed');
    }
  }
  if (previous && obs.checks && aggregateChecks(previous.checks) !== aggregateChecks(obs.checks)) {
    changes.push('checks_changed');
  }
  if (previous && previous.mergeable !== mergeable) changes.push('mergeability_changed');
  const becameMerged = pr.state === 'merged' && previous?.state !== 'merged';
  const becameClosed = pr.state === 'closed' && previous?.state === 'open';
  let outsideCrew = false;
  if (becameMerged) {
    changes.push('merged');
    outsideCrew = !previous || !crewMergeRecorded(db, previous.id);
    if (outsideCrew && previous) kinds.push('merged_outside_crew');
  }
  if (becameClosed) {
    changes.push('closed');
    kinds.push('closed_outside_crew');
  }
  if (!previous) changes.push('discovered');

  const previousDivergence = previous?.externalDivergence ?? null;
  let divergence: Divergence | null = previousDivergence;
  if (kinds.length > 0) {
    divergence = {
      kinds: [...new Set([...(previousDivergence?.kinds ?? []), ...kinds])].sort() as DivergenceKind[],
      blocking: blocking || (previousDivergence?.blocking ?? false),
      detectedAt: at,
      previousHead: previous?.headSha ?? null,
      observedHead: pr.headSha,
      detail: kinds.join(', '),
    };
  }

  const values = {
    url: pr.url,
    title: pr.title,
    author: pr.author,
    head_ref: pr.headRef,
    head_sha: pr.headSha,
    base_ref: pr.baseRef,
    base_sha: pr.baseSha,
    state: pr.state,
    is_draft: pr.isDraft ? 1 : 0,
    mergeable,
    merge_state_status: obs.graph?.mergeStateStatus ?? pr.mergeStateStatus,
    review_decision: obs.graph ? obs.graph.reviewDecision : (previous?.reviewDecision ?? null),
    checks_state: aggregateChecks(checks),
    checks: toJson(checks),
    reviews: toJson(reviews),
    rules: governance ? toJson(governance) : null,
    changed_files: obs.files ? toJson(obs.files) : previous?.changedFiles ? toJson(previous.changedFiles) : null,
    merge_commit_sha: pr.mergeCommitSha ?? previous?.mergeCommitSha ?? null,
    merged_at: pr.mergedAt,
    external_divergence: divergence ? toJson(divergence) : null,
    remote_updated_at: pr.updatedAt,
    last_synced_at: at,
  };
  let prId: string;
  if (previous) {
    prId = previous.id;
    db.query(
      `UPDATE pull_requests SET url = ?, title = ?, author = ?, head_ref = ?, head_sha = ?, base_ref = ?, base_sha = ?, state = ?, is_draft = ?,
         mergeable = ?, merge_state_status = ?, review_decision = ?, checks_state = ?, checks = ?, reviews = ?, rules = ?, changed_files = ?,
         merge_commit_sha = ?, merged_at = ?, external_divergence = ?, remote_updated_at = ?, last_synced_at = ?,
         task_id = COALESCE(?, task_id), expected_remote_head = COALESCE(?, expected_remote_head), updated_at = ? WHERE id = ?`,
    ).run(...Object.values(values), options.taskId ?? null, options.expectedRemoteHead ?? acceptedHead, at, prId);
  } else {
    prId = newId('pr');
    db.query(
      `INSERT INTO pull_requests (url, title, author, head_ref, head_sha, base_ref, base_sha, state, is_draft, mergeable, merge_state_status,
         review_decision, checks_state, checks, reviews, rules, changed_files, merge_commit_sha, merged_at, external_divergence, remote_updated_at,
         last_synced_at, id, repository_id, number, task_id, expected_remote_head, imported, created_at, updated_at)
       VALUES (${Array(30).fill('?').join(', ')})`,
    ).run(
      ...Object.values(values),
      prId,
      repositoryId,
      pr.number,
      options.taskId ?? null,
      options.expectedRemoteHead ?? null,
      options.imported ? 1 : 0,
      at,
      at,
    );
  }

  const record = mapPullRequest(one<PullRequestRow>(db, 'SELECT * FROM pull_requests WHERE id = ?', prId)!);
  if (changes.includes('head_changed')) {
    invalidateReviewsInTx(db, { prId, exceptCommitSha: pr.headSha, reason: 'head_changed' }, actor, at);
    invalidateCandidatesInTx(db, { prId }, 'head_changed', actor, at);
    const entry = activeEntryForPr(db, prId);
    if (entry && ['eligible', 'candidate', 'validating'].includes(entry.status)) {
      setEntryStatus(db, entry.id, 'waiting', at, { validatedBase: null, validatedHead: null });
    }
  }
  if (acceptedHead && record.taskId) {
    hooks.push({
      name: 'onRemoteHeadAccepted',
      event: { taskId: record.taskId, prId, prNumber: record.number, repositoryId, headSha: acceptedHead },
    });
  }
  if (changes.includes('base_retargeted')) invalidateCandidatesInTx(db, { prId }, 'base_retargeted', actor, at);
  if (changes.includes('rules_changed') && nextRules) {
    invalidateCandidatesInTx(db, { rulesFingerprintNot: nextRules }, 'rules_changed', actor, at);
  }
  if (becameMerged || becameClosed) {
    const entry = activeEntryForPr(db, prId);
    if (entry) {
      setEntryStatus(db, entry.id, becameMerged ? 'merged' : 'removed', at);
      if (becameClosed && record.taskId) {
        hooks.push({
          name: 'onBlocked',
          event: {
            taskId: record.taskId,
            prId,
            prNumber: record.number,
            repositoryId,
            reason: 'pull request closed on GitHub',
            blockers: [],
          },
        });
      }
    }
    invalidateCandidatesInTx(db, { prId }, becameMerged ? 'merged_elsewhere' : 'closed', actor, at);
  }
  if (record.state === 'merged' && record.mergeCommitSha && !previous?.mergeCommitSha && record.taskId) {
    hooks.push({
      name: 'onMerged',
      event: {
        taskId: record.taskId,
        prId,
        prNumber: record.number,
        repositoryId,
        mergeCommitSha: record.mergeCommitSha,
      },
    });
  }
  if (changes.length > 0) {
    recordTransition(
      db,
      {
        type: becameMerged ? 'pr.merged' : 'github.pr_observed',
        actor,
        prId,
        taskId: record.taskId,
        payload: {
          number: pr.number,
          changes,
          headSha: pr.headSha,
          baseRef: pr.baseRef,
          baseSha: pr.baseSha,
          state: pr.state,
          mergeCommitSha: record.mergeCommitSha,
          rulesFingerprint: nextRules,
          remoteUpdatedAt: pr.updatedAt,
          divergence: kinds,
          outsideCrew,
        },
      },
      { action: 'github.observe', input: { number: pr.number, headSha: pr.headSha }, decision: changes.join(',') },
      at,
    );
  }
  return { prId, number: pr.number, changes, divergence: kinds };
}

export function deriveStacks(db: Database, repositoryId: string): void {
  const open = all<PullRequestRow>(
    db,
    `SELECT * FROM pull_requests WHERE repository_id = ? AND state = 'open' ORDER BY number`,
    repositoryId,
  ).map(mapPullRequest);
  const byHead = new Map(open.map((p) => [p.headRef, p]));
  const parentOf = new Map<string, PullRequestRecord>();
  for (const pr of open) {
    const stack = pr.governance?.stack ?? null;
    let parent: PullRequestRecord | undefined;
    if (stack && stack.position > 1) {
      parent = open.find(
        (p) => p.governance?.stack?.id === stack.id && p.governance.stack.position === stack.position - 1,
      );
    } else if (!stack) {
      parent = byHead.get(pr.baseRef);
    }
    db.query(`DELETE FROM pr_dependencies WHERE pr_id = ? AND kind = 'stack_parent'`).run(pr.id);
    if (parent && parent.id !== pr.id) {
      parentOf.set(pr.id, parent);
      db.query(
        `INSERT OR REPLACE INTO pr_dependencies (pr_id, depends_on_pr_id, kind) VALUES (?, ?, 'stack_parent')`,
      ).run(pr.id, parent.id);
    }
  }
  const hasChild = new Set([...parentOf.values()].map((p) => p.id));
  for (const pr of open) {
    let bottom = pr;
    let depth = 1;
    const seen = new Set<string>([pr.id]);
    while (parentOf.has(bottom.id)) {
      const next = parentOf.get(bottom.id)!;
      if (seen.has(next.id)) break;
      seen.add(next.id);
      bottom = next;
      depth++;
    }
    const native = pr.governance?.stack ?? null;
    const stackId = native
      ? `gh:${native.id}`
      : parentOf.has(pr.id) || hasChild.has(pr.id)
        ? `chain:${bottom.number}`
        : null;
    const order = native ? native.position : stackId ? depth : null;
    db.query('UPDATE pull_requests SET stack_id = ?, stack_order = ? WHERE id = ?').run(stackId, order, pr.id);
    db.query(
      `UPDATE queue_entries SET stack_id = ?, stack_order = ? WHERE pr_id = ? AND status NOT IN ('merged', 'removed')`,
    ).run(stackId, order, pr.id);
  }
}

interface BaseShape {
  number: number;
  headRef: string;
  baseRef: string;
  state: string;
  stack: { baseRef: string } | null;
}

function integrationBases(prs: readonly BaseShape[]): Map<number, string> {
  const byHead = new Map<string, BaseShape>();
  for (const pr of prs) if (pr.state === 'merged' && !byHead.has(pr.headRef)) byHead.set(pr.headRef, pr);
  for (const pr of prs) if (pr.state === 'open') byHead.set(pr.headRef, pr);
  const out = new Map<number, string>();
  for (const pr of prs) {
    if (pr.stack?.baseRef) {
      out.set(pr.number, pr.stack.baseRef);
      continue;
    }
    let current = pr;
    const seen = new Set<number>();
    while (byHead.has(current.baseRef) && !seen.has(current.number)) {
      seen.add(current.number);
      current = byHead.get(current.baseRef)!;
    }
    out.set(pr.number, current.baseRef);
  }
  return out;
}

export interface SyncOptions {
  numbers?: number[];
  imported?: boolean;
}

export async function syncRepository(
  ctx: CrewContext,
  repositoryId: string,
  env: IntegrationEnv = {},
  options: SyncOptions = {},
): Promise<SyncResult> {
  const repository = repositoryFor(ctx, repositoryId);
  const client = await clientFor(ctx, env, repository);
  const attemptAt = nowIso(ctx.clock);
  let observations: ObservedPullRequest[];
  try {
    let prs: GitHubPullRequest[];
    if (options.numbers) {
      prs = await Promise.all(options.numbers.map((n) => client.getPullRequest(n)));
    } else {
      prs = await client.listPullRequests('open');
      const listed = new Set(prs.map((p) => p.number));
      const stale = all<{ number: number }>(
        ctx.store.db,
        `SELECT number FROM pull_requests WHERE repository_id = ? AND (state = 'open' OR (state = 'merged' AND merge_commit_sha IS NULL))`,
        repositoryId,
      ).filter((r) => !listed.has(r.number));
      for (const row of stale) prs.push(await client.getPullRequest(row.number));
    }
    const known: BaseShape[] = all<PullRequestRow>(
      ctx.store.db,
      `SELECT * FROM pull_requests WHERE repository_id = ? AND state IN ('open', 'merged')`,
      repositoryId,
    )
      .map(mapPullRequest)
      .filter((p) => !prs.some((q) => q.number === p.number))
      .map((p) => ({ ...p, stack: p.governance?.stack ?? null }));
    const bases = integrationBases([...prs, ...known]);
    const requirementsCache = new Map<string, BranchRequirements>();
    observations = [];
    for (const pr of prs) {
      const previous = pullRequestByNumber(ctx.store.db, repositoryId, pr.number);
      observations.push(
        await observePullRequest(
          ctx,
          client,
          pr,
          bases.get(pr.number) ?? pr.baseRef,
          requirementsCache,
          previous?.state === 'open' ? previous.headSha : null,
          repository,
        ),
      );
    }
  } catch (error) {
    ctx.store.immediate((db) => markSyncFailure(db, repositoryId, error, attemptAt));
    const freshness = readFreshness(ctx.store.db, repositoryId);
    if (error instanceof CrewError && (error.code === 'OFFLINE' || error.code === 'RATE_LIMITED')) {
      return {
        repositoryId,
        ok: false,
        offline: error.code === 'OFFLINE',
        rateLimited: error.code === 'RATE_LIMITED',
        observed: 0,
        changed: [],
        merged: [],
        freshness,
        error: error.message,
      };
    }
    throw error;
  }
  const at = nowIso(ctx.clock);
  const hooks: PendingHook[] = [];
  const changed = ctx.store.immediate((db) => {
    const results = observations.map((obs) =>
      applyObservation(db, repositoryId, obs, at, { imported: options.imported ?? false }, hooks),
    );
    deriveStacks(db, repositoryId);
    markSyncSuccess(db, repositoryId, at);
    return results;
  });
  await runHooks(ctx, env.hooks, hooks);
  const merged = changed
    .filter((c) => c.changes.includes('merged'))
    .map((c) => {
      const record = pullRequestByNumber(ctx.store.db, repositoryId, c.number)!;
      return {
        prId: c.prId,
        number: c.number,
        mergeCommitSha: record.mergeCommitSha,
        outsideCrew: c.divergence.includes('merged_outside_crew'),
      };
    });
  return {
    repositoryId,
    ok: true,
    offline: false,
    rateLimited: false,
    observed: observations.length,
    changed: changed.filter((c) => c.changes.length > 0),
    merged,
    freshness: readFreshness(ctx.store.db, repositoryId),
    error: null,
  };
}
