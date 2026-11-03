import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, type AutonomyMode, CrewError, newId, nowIso, type Risk } from '@crewyard/core';
import { classifyPaths, type PathClassification, type ReviewSummary, reviewSummary } from '@crewyard/reviews';
import { type CrewContext, one, recordTransition } from '@crewyard/storage';
import { autonomyFor, configFor, repositoryFor } from './env.ts';
import { activeEntryForPr, dependenciesOf, pullRequestById, queueById, requirePullRequest } from './records.ts';
import { type RemoteFreshness, readFreshness } from './sync-state.ts';
import type { Blocker, IntegrationEnv, PullRequestRecord, QueueEntryStatus, QueueMode } from './types.ts';

export interface ParentState {
  pr: PullRequestRecord;
  kind: 'stack_parent' | 'task_dependency';
  entryStatus: QueueEntryStatus | null;
}

export interface EligibilityInput {
  pr: PullRequestRecord;
  autonomy: AutonomyMode;
  config: Pick<CrewConfig, 'integration' | 'review' | 'security'>;
  mode: QueueMode;
  mergeApproved: boolean;
  reviews: ReviewSummary;
  parents: ParentState[];
  entryStatus: QueueEntryStatus | null;
  queuePaused: boolean;
  freshness: RemoteFreshness;
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: Blocker[];
  risk: Risk;
  classification: PathClassification;
}

export const mergeApprovalSubject = (prId: string, headSha: string) => `${prId}@${headSha}`;

export function classifyPullRequest(
  config: Pick<CrewConfig, 'security'>,
  pr: Pick<PullRequestRecord, 'changedFiles'>,
): PathClassification {
  const files = pr.changedFiles ?? [];
  const paths = [...new Set(files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])))];
  return classifyPaths(config.security, paths, {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  });
}

function approvalsOnHead(pr: PullRequestRecord, onlyCurrentHead: boolean): { approved: number; changes: boolean } {
  const latest = new Map<string, { state: string; commitSha: string | null }>();
  for (const review of pr.reviews) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(review.reviewer, { state: review.state, commitSha: review.commitSha });
  }
  let approved = 0;
  let changes = false;
  for (const review of latest.values()) {
    if (review.state === 'APPROVED' && (!onlyCurrentHead || review.commitSha === pr.headSha)) approved++;
    if (review.state === 'CHANGES_REQUESTED') changes = true;
  }
  return { approved, changes };
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { pr, config } = input;
  const blockers: Blocker[] = [];
  const add = (code: string, source: Blocker['source'], message: string, details?: Record<string, unknown>) =>
    blockers.push({ code, source, message, ...(details ? { details } : {}) });
  const classification = classifyPullRequest(config, pr);

  if (pr.state !== 'open') add('PR_NOT_OPEN', 'github', `Pull request is ${pr.state}`);
  if (pr.isDraft) add('PR_DRAFT', 'github', 'Pull request is a draft');
  if (input.queuePaused) add('QUEUE_PAUSED', 'queue', 'The integration queue is paused');
  if (input.entryStatus === 'quarantined') add('QUARANTINED', 'queue', 'Entry is quarantined after repeated failures');
  if (input.entryStatus === 'escalated') add('ESCALATED', 'queue', 'Entry is escalated and waits for an operator');
  if (!pr.lastSyncedAt) add('NOT_SYNCED', 'sync', 'Remote state has never been observed; run `crew sync`');
  if (input.freshness.offline) {
    add('REMOTE_STATE_STALE', 'sync', `GitHub is unreachable; last seen ${input.freshness.lastSuccessAt ?? 'never'}`, {
      lastSuccessAt: input.freshness.lastSuccessAt,
    });
  }
  if (input.freshness.rateLimitResetAt && input.freshness.lastError) {
    add('RATE_LIMITED', 'sync', `GitHub rate limit until ${input.freshness.rateLimitResetAt}`);
  }
  if (pr.externalDivergence?.blocking) {
    add(
      'EXTERNAL_DIVERGENCE',
      'github',
      `Branch changed outside Crewyard (${pr.externalDivergence.detail}); run \`crew pr acknowledge ${pr.number}\` to continue`,
      {
        divergence: pr.externalDivergence,
      },
    );
  }

  for (const parent of input.parents) {
    if (parent.pr.state === 'merged') continue;
    const label = parent.kind === 'stack_parent' ? 'STACK_PARENT' : 'DEPENDENCY';
    const failed =
      parent.pr.state === 'closed' ||
      parent.entryStatus === 'quarantined' ||
      parent.entryStatus === 'escalated' ||
      parent.entryStatus === 'blocked' ||
      parent.entryStatus === 'removed';
    if (failed) {
      add(`${label}_BLOCKED`, 'stack', `#${parent.pr.number} below this PR is blocked or failed`, {
        parentPrId: parent.pr.id,
        parentNumber: parent.pr.number,
      });
    } else {
      blockers.push({
        code: `${label}_NOT_MERGED`,
        source: 'stack',
        soft: parent.kind === 'stack_parent' && parent.entryStatus !== null,
        message: `#${parent.pr.number} must integrate first`,
        details: { parentPrId: parent.pr.id, parentNumber: parent.pr.number },
      });
    }
  }

  const requirements = pr.governance?.requirements ?? null;
  if (pr.state === 'open') {
    if (!requirements) add('RULES_UNKNOWN', 'github', 'Branch rules have not been observed for the integration base');
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      add('MERGE_CONFLICT', 'github', 'GitHub reports a merge conflict with the base branch');
    } else if (pr.mergeable === 'UNKNOWN' || pr.mergeable === null) {
      add('MERGEABILITY_UNKNOWN', 'github', 'GitHub has not computed mergeability yet');
    }
  }
  if (requirements && pr.state === 'open') {
    if (config.integration.require_github_checks) {
      for (const required of requirements.requiredChecks) {
        const check = pr.checks.find((c) => c.name === required.context);
        if (!check) {
          add('REQUIRED_CHECK_MISSING', 'github', `Required check ${required.context} has not reported`, {
            check: required.context,
          });
        } else if (check.state === 'pending') {
          add('REQUIRED_CHECK_PENDING', 'github', `Required check ${required.context} is pending`, {
            check: required.context,
          });
        } else if (check.state === 'failure') {
          add('REQUIRED_CHECK_FAILED', 'github', `Required check ${required.context} failed`, {
            check: required.context,
          });
        }
      }
      const requiredNames = new Set(requirements.requiredChecks.map((c) => c.context));
      for (const check of pr.checks) {
        if (!requiredNames.has(check.name) && check.state === 'failure') {
          add('CHECK_FAILED', 'github', `Check ${check.name} failed`, { check: check.name });
        }
      }
    }
    const { approved, changes } = approvalsOnHead(
      pr,
      requirements.dismissStaleReviews || requirements.requireLastPushApproval,
    );
    if (changes || pr.reviewDecision === 'CHANGES_REQUESTED') {
      add('CHANGES_REQUESTED', 'github', 'A reviewer requested changes');
    }
    if (approved < requirements.requiredApprovals) {
      add('REVIEWS_REQUIRED', 'github', `${approved}/${requirements.requiredApprovals} required approvals`, {
        approved,
        required: requirements.requiredApprovals,
      });
    } else if (pr.reviewDecision === 'REVIEW_REQUIRED') {
      if (requirements.requireCodeOwnerReview) {
        add('CODEOWNER_REVIEW_REQUIRED', 'github', 'A code owner review is required');
      } else {
        add('REVIEWS_REQUIRED', 'github', 'GitHub reports that more reviews are required');
      }
    }
    if (input.mode === 'crew-managed' && requirements.strictChecks && pr.mergeStateStatus === 'BEHIND') {
      add(
        'BRANCH_BEHIND_BASE',
        'github',
        'Branch protection requires the branch to be up to date; a revision is needed',
      );
    }
    if (
      input.mode === 'crew-managed' &&
      requirements.allowedMergeMethods &&
      !requirements.allowedMergeMethods.includes(config.integration.merge_method)
    ) {
      add('MERGE_METHOD_NOT_ALLOWED', 'github', `Rules do not allow ${config.integration.merge_method} merges`);
    }
    if (input.mode === 'crew-managed' && requirements.mergeQueue) {
      add('MERGE_QUEUE_REQUIRED', 'github', 'The base branch requires the GitHub merge queue');
    }
    if (pr.mergeStateStatus === 'BLOCKED' && !blockers.some((b) => b.source === 'github')) {
      add('BLOCKED_BY_RULES', 'github', 'GitHub reports the merge is blocked by repository rules');
    }
  }

  if (input.autonomy === 'observe')
    add('AUTONOMY_OBSERVE', 'policy', 'Project autonomy is observe; Crewyard never merges');
  const highRisk = classification.risk === 'high';
  if (highRisk && config.review.require_review_for_high_risk) {
    const passed = (['code', 'security'] as const).some((t) => input.reviews.byType[t]?.status === 'passed');
    if (!passed) {
      add(
        'HIGH_RISK_REVIEW_REQUIRED',
        'policy',
        'High-risk change needs a passing Crewyard review on the current head',
        {
          classes: classification.classes,
        },
      );
    }
  }
  if (input.reviews.blockingFindings > 0) {
    add('REVIEW_FINDINGS_OPEN', 'crew', `${input.reviews.blockingFindings} high-severity review finding(s) are open`);
  }
  if (classification.approvalClasses.length > 0 && !input.mergeApproved) {
    add('APPROVAL_REQUIRED', 'policy', `Operator approval required for ${classification.approvalClasses.join(', ')}`, {
      classes: classification.approvalClasses,
    });
  } else if (
    (input.autonomy === 'assisted' || !config.integration.auto_merge_eligible) &&
    input.autonomy !== 'observe' &&
    !input.mergeApproved
  ) {
    add('OPERATOR_MERGE_APPROVAL_REQUIRED', 'policy', 'An operator must approve this merge explicitly');
  }
  return {
    eligible: blockers.every((b) => b.soft === true),
    blockers,
    risk: classification.risk,
    classification,
  };
}

export function hasMergeApproval(db: Database, pr: PullRequestRecord): boolean {
  return (
    one(
      db,
      `SELECT 1 FROM approvals WHERE subject_kind = 'merge' AND subject_id = ? AND status = 'approved' LIMIT 1`,
      mergeApprovalSubject(pr.id, pr.headSha),
    ) !== null
  );
}

export function eligibilityInputFor(
  db: Database,
  pr: PullRequestRecord,
  context: { autonomy: AutonomyMode; config: CrewConfig; mode: QueueMode; queuePaused: boolean },
): EligibilityInput {
  const entry = activeEntryForPr(db, pr.id);
  return {
    pr,
    autonomy: context.autonomy,
    config: context.config,
    mode: context.mode,
    mergeApproved: hasMergeApproval(db, pr),
    reviews: reviewSummary(db, pr.id, pr.headSha),
    parents: dependenciesOf(db, pr.id)
      .map((d) => ({ dep: d, record: pullRequestById(db, d.prId) }))
      .filter((d): d is { dep: (typeof d)['dep']; record: PullRequestRecord } => d.record !== null)
      .map(({ dep, record }) => ({
        pr: record,
        kind: dep.kind,
        entryStatus: activeEntryForPr(db, record.id)?.status ?? null,
      })),
    entryStatus: entry?.status ?? null,
    queuePaused: context.queuePaused,
    freshness: readFreshness(db, pr.repositoryId),
  };
}

export interface Explanation {
  prId: string;
  number: number;
  headSha: string;
  eligible: boolean;
  risk: Risk;
  securityClasses: string[];
  blockers: Blocker[];
  queue: { queueId: string; entryId: string; status: QueueEntryStatus; mode: QueueMode } | null;
  remote: RemoteFreshness;
  evaluatedAt: string;
}

export function explainPullRequest(ctx: CrewContext, prId: string, env: IntegrationEnv = {}): Explanation {
  const pr = requirePullRequest(ctx.store.db, prId);
  const repository = repositoryFor(ctx, pr.repositoryId);
  const config = configFor(ctx, env, repository.projectId);
  const entry = activeEntryForPr(ctx.store.db, pr.id);
  const queue = entry ? queueById(ctx.store.db, entry.queueId) : null;
  const mode: QueueMode =
    queue?.mode ??
    (config.integration.mode === 'auto'
      ? pr.governance?.requirements?.mergeQueue
        ? 'github-managed'
        : 'crew-managed'
      : config.integration.mode);
  const input = eligibilityInputFor(ctx.store.db, pr, {
    autonomy: autonomyFor(ctx, repository.projectId),
    config,
    mode,
    queuePaused: queue?.paused ?? false,
  });
  const result = evaluateEligibility(input);
  const queueBlockers = (entry?.blockers ?? []).filter(
    (b) => b.source === 'queue' && !result.blockers.some((r) => r.code === b.code),
  );
  const blockers = [...queueBlockers, ...result.blockers];
  return {
    prId: pr.id,
    number: pr.number,
    headSha: pr.headSha,
    eligible: result.eligible && queueBlockers.length === 0,
    risk: result.risk,
    securityClasses: result.classification.classes,
    blockers,
    queue: entry && queue ? { queueId: queue.id, entryId: entry.id, status: entry.status, mode: queue.mode } : null,
    remote: input.freshness,
    evaluatedAt: nowIso(ctx.clock),
  };
}

export function decideMergeApproval(
  ctx: CrewContext,
  input: { prId: string; approved: boolean; headSha?: string },
  actor: Actor,
): { approvalId: string; subjectId: string; status: 'approved' | 'rejected' } {
  if (actor.kind !== 'operator') {
    throw new CrewError('NOT_AUTHORIZED', 'Only an operator can decide merge approvals', { retryable: false });
  }
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const pr = requirePullRequest(db, input.prId);
    if (input.headSha && input.headSha !== pr.headSha) {
      throw new CrewError('HEAD_MISMATCH', `PR head is ${pr.headSha}, approval was for ${input.headSha}`, {
        suggestion: 'Re-run `crew queue explain` and approve the current head.',
      });
    }
    const repository = one<{ project_id: string }>(
      db,
      'SELECT project_id FROM repositories WHERE id = ?',
      pr.repositoryId,
    )!;
    const subjectId = mergeApprovalSubject(pr.id, pr.headSha);
    const status = input.approved ? 'approved' : 'rejected';
    const pending = one<{ id: string }>(
      db,
      `SELECT id FROM approvals WHERE subject_kind = 'merge' AND subject_id = ? AND status = 'pending'`,
      subjectId,
    );
    const approvalId = pending?.id ?? newId('apr');
    if (pending) {
      db.query('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(
        status,
        actor.id,
        at,
        approvalId,
      );
    } else {
      db.query(
        `INSERT INTO approvals (id, project_id, subject_kind, subject_id, reason, status, requested_by, decided_by, decided_at, created_at)
         VALUES (?, ?, 'merge', ?, 'operator decision', ?, ?, ?, ?, ?)`,
      ).run(approvalId, repository.project_id, subjectId, status, actor.id, actor.id, at, at);
    }
    recordTransition(
      db,
      {
        type: input.approved ? 'approval.granted' : 'approval.rejected',
        actor,
        projectId: repository.project_id,
        prId: pr.id,
        taskId: pr.taskId,
        payload: { approvalId, subjectKind: 'merge', subjectId, headSha: pr.headSha },
      },
      { action: 'merge.approve', input, decision: status },
      at,
    );
    return { approvalId, subjectId, status };
  });
}
