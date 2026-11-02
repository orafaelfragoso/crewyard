import { fingerprint } from '@agent-rail/core';
import { asArray, asBoolean, asNumber, asRecord, asString, field } from './json.ts';
import type {
  AsyncMergeResult,
  AsyncMergeStatus,
  BranchRequirements,
  CheckResult,
  CheckState,
  FileStatus,
  GitHubPullRequest,
  MergeMethod,
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueRule,
  MergeStateStatus,
  PullRequestFile,
  PullRequestGraphState,
  PullRequestReview,
  RequiredCheck,
  ReviewDecision,
  ReviewState,
  StackInfo,
  WorkflowRun,
} from './types.ts';

const MERGE_STATES: readonly MergeStateStatus[] = [
  'CLEAN',
  'DIRTY',
  'BLOCKED',
  'BEHIND',
  'UNSTABLE',
  'HAS_HOOKS',
  'DRAFT',
  'UNKNOWN',
];

export function toMergeStateStatus(value: unknown): MergeStateStatus {
  const upper = (asString(value) ?? 'unknown').toUpperCase() as MergeStateStatus;
  return MERGE_STATES.includes(upper) ? upper : 'UNKNOWN';
}

function toStack(value: unknown): StackInfo | null {
  const raw = asRecord(value);
  const id = asNumber(raw.id) ?? asString(raw.id);
  if (id === null) return null;
  return {
    id: String(id),
    position: asNumber(raw.position) ?? 0,
    size: asNumber(raw.size) ?? 0,
    baseRef: asString(field(raw, 'base', 'ref')) ?? '',
    baseSha: asString(field(raw, 'base', 'sha')) ?? '',
  };
}

export function toPullRequest(value: unknown): GitHubPullRequest {
  const raw = asRecord(value);
  const mergedAt = asString(raw.merged_at);
  const mergeable = asBoolean(raw.mergeable);
  return {
    number: asNumber(raw.number) ?? 0,
    url: asString(raw.html_url) ?? '',
    title: asString(raw.title) ?? '',
    body: asString(raw.body) ?? '',
    author: asString(field(raw, 'user', 'login')),
    state: mergedAt ? 'merged' : asString(raw.state) === 'closed' ? 'closed' : 'open',
    isDraft: asBoolean(raw.draft) ?? false,
    headRef: asString(field(raw, 'head', 'ref')) ?? '',
    headSha: asString(field(raw, 'head', 'sha')) ?? '',
    headRepository: asString(field(raw, 'head', 'repo', 'full_name')),
    baseRef: asString(field(raw, 'base', 'ref')) ?? '',
    baseSha: asString(field(raw, 'base', 'sha')) ?? '',
    mergeable: mergeable === true ? 'MERGEABLE' : mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: toMergeStateStatus(raw.mergeable_state),
    mergeCommitSha: mergedAt ? asString(raw.merge_commit_sha) : null,
    mergedAt,
    updatedAt: asString(raw.updated_at) ?? '',
    stack: raw.stack == null ? null : toStack(raw.stack),
  };
}

const FILE_STATUSES: readonly FileStatus[] = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];

export function toPullRequestFile(value: unknown): PullRequestFile {
  const raw = asRecord(value);
  const status = asString(raw.status) as FileStatus | null;
  return {
    path: asString(raw.filename) ?? '',
    previousPath: asString(raw.previous_filename),
    status: status && FILE_STATUSES.includes(status) ? status : 'modified',
    additions: asNumber(raw.additions) ?? 0,
    deletions: asNumber(raw.deletions) ?? 0,
    blobSha: asString(raw.sha),
  };
}

const REVIEW_STATES: readonly ReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'];

export function toReview(value: unknown): PullRequestReview {
  const raw = asRecord(value);
  const state = (asString(raw.state) ?? '').toUpperCase() as ReviewState;
  return {
    id: String(asNumber(raw.id) ?? asString(raw.id) ?? ''),
    reviewer: asString(field(raw, 'user', 'login')) ?? 'unknown',
    state: REVIEW_STATES.includes(state) ? state : 'COMMENTED',
    commitSha: asString(raw.commit_id),
    submittedAt: asString(raw.submitted_at),
  };
}

function checkRunState(status: string | null, conclusion: string | null): CheckState {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    default:
      return 'failure';
  }
}

export function toCheckRun(value: unknown): CheckResult & { id: number } {
  const raw = asRecord(value);
  return {
    id: asNumber(raw.id) ?? 0,
    name: asString(raw.name) ?? '',
    kind: 'check_run',
    state: checkRunState(asString(raw.status), asString(raw.conclusion)),
    appId: asNumber(field(raw, 'app', 'id')),
    headSha: asString(raw.head_sha) ?? '',
    detailsUrl: asString(raw.details_url),
  };
}

export function toCommitStatus(value: unknown, headSha: string): CheckResult {
  const raw = asRecord(value);
  const state = asString(raw.state);
  return {
    name: asString(raw.context) ?? '',
    kind: 'status',
    state: state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure',
    appId: null,
    headSha,
    detailsUrl: asString(raw.target_url),
  };
}

export function mergeChecks(runs: (CheckResult & { id: number })[], statuses: CheckResult[]): CheckResult[] {
  const latest = new Map<string, CheckResult & { id: number }>();
  for (const run of runs) {
    const current = latest.get(run.name);
    if (!current || run.id > current.id) latest.set(run.name, run);
  }
  const byName = new Map<string, CheckResult>();
  for (const status of statuses) if (!byName.has(status.name)) byName.set(status.name, status);
  for (const { id: _id, ...run } of latest.values()) byName.set(run.name, run);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function toWorkflowRun(value: unknown): WorkflowRun {
  const raw = asRecord(value);
  return {
    id: asNumber(raw.id) ?? 0,
    name: asString(raw.name) ?? '',
    event: asString(raw.event) ?? '',
    status: asString(raw.status) ?? '',
    conclusion: asString(raw.conclusion),
    headSha: asString(raw.head_sha) ?? '',
    headBranch: asString(raw.head_branch),
  };
}

function toMergeMethod(value: unknown): MergeMethod | null {
  const lower = (asString(value) ?? '').toLowerCase();
  return lower === 'merge' || lower === 'squash' || lower === 'rebase' ? lower : null;
}

interface RequirementsDraft {
  requiredChecks: Map<string, RequiredCheck>;
  strictChecks: boolean;
  requiredApprovals: number;
  requireCodeOwnerReview: boolean;
  dismissStaleReviews: boolean;
  requireLastPushApproval: boolean;
  requireThreadResolution: boolean;
  requireLinearHistory: boolean;
  allowedMergeMethods: MergeMethod[] | null;
  mergeQueue: MergeQueueRule | null;
  sources: Set<'ruleset' | 'branch_protection'>;
}

function emptyDraft(): RequirementsDraft {
  return {
    requiredChecks: new Map(),
    strictChecks: false,
    requiredApprovals: 0,
    requireCodeOwnerReview: false,
    dismissStaleReviews: false,
    requireLastPushApproval: false,
    requireThreadResolution: false,
    requireLinearHistory: false,
    allowedMergeMethods: null,
    mergeQueue: null,
    sources: new Set(),
  };
}

function addCheck(draft: RequirementsDraft, context: string | null, appId: number | null): void {
  if (!context) return;
  const existing = draft.requiredChecks.get(context);
  draft.requiredChecks.set(context, { context, appId: existing?.appId ?? appId });
}

function applyRules(draft: RequirementsDraft, rules: unknown[]): void {
  for (const item of rules) {
    const rule = asRecord(item);
    const params = asRecord(rule.parameters);
    const type = asString(rule.type);
    if (type) draft.sources.add('ruleset');
    if (type === 'pull_request') {
      draft.requiredApprovals = Math.max(
        draft.requiredApprovals,
        asNumber(params.required_approving_review_count) ?? 0,
      );
      draft.requireCodeOwnerReview ||= asBoolean(params.require_code_owner_review) ?? false;
      draft.dismissStaleReviews ||= asBoolean(params.dismiss_stale_reviews_on_push) ?? false;
      draft.requireLastPushApproval ||= asBoolean(params.require_last_push_approval) ?? false;
      draft.requireThreadResolution ||= asBoolean(params.required_review_thread_resolution) ?? false;
      const methods = asArray(params.allowed_merge_methods)
        .map(toMergeMethod)
        .filter((m): m is MergeMethod => m !== null);
      if (methods.length > 0) {
        draft.allowedMergeMethods = draft.allowedMergeMethods
          ? draft.allowedMergeMethods.filter((m) => methods.includes(m))
          : methods;
      }
    } else if (type === 'required_status_checks') {
      draft.strictChecks ||= asBoolean(params.strict_required_status_checks_policy) ?? false;
      for (const check of asArray(params.required_status_checks)) {
        addCheck(draft, asString(field(check, 'context')), asNumber(field(check, 'integration_id')));
      }
    } else if (type === 'required_linear_history') {
      draft.requireLinearHistory = true;
    } else if (type === 'merge_queue' && !draft.mergeQueue) {
      const strategy = asString(params.grouping_strategy);
      draft.mergeQueue = {
        mergeMethod: toMergeMethod(params.merge_method) ?? 'merge',
        groupingStrategy: strategy === 'HEADGREEN' ? 'HEADGREEN' : 'ALLGREEN',
        maxEntriesToBuild: asNumber(params.max_entries_to_build) ?? 5,
        maxEntriesToMerge: asNumber(params.max_entries_to_merge) ?? 5,
        minEntriesToMerge: asNumber(params.min_entries_to_merge) ?? 1,
        checkResponseTimeoutMinutes: asNumber(params.check_response_timeout_minutes) ?? 60,
      };
    }
  }
}

function applyProtection(draft: RequirementsDraft, protection: unknown): void {
  const raw = asRecord(protection);
  if (Object.keys(raw).length === 0) return;
  draft.sources.add('branch_protection');
  const checks = asRecord(raw.required_status_checks);
  if (Object.keys(checks).length > 0) {
    draft.strictChecks ||= asBoolean(checks.strict) ?? false;
    for (const context of asArray(checks.contexts)) addCheck(draft, asString(context), null);
    for (const check of asArray(checks.checks)) {
      addCheck(draft, asString(field(check, 'context')), asNumber(field(check, 'app_id')));
    }
  }
  const reviews = asRecord(raw.required_pull_request_reviews);
  if (Object.keys(reviews).length > 0) {
    draft.requiredApprovals = Math.max(draft.requiredApprovals, asNumber(reviews.required_approving_review_count) ?? 1);
    draft.requireCodeOwnerReview ||= asBoolean(reviews.require_code_owner_reviews) ?? false;
    draft.dismissStaleReviews ||= asBoolean(reviews.dismiss_stale_reviews) ?? false;
    draft.requireLastPushApproval ||= asBoolean(reviews.require_last_push_approval) ?? false;
  }
  draft.requireLinearHistory ||= asBoolean(field(raw, 'required_linear_history', 'enabled')) ?? false;
  draft.requireThreadResolution ||= asBoolean(field(raw, 'required_conversation_resolution', 'enabled')) ?? false;
}

export function toBranchRequirements(
  branch: string,
  rules: unknown[],
  protection: unknown,
  protectionVisible: boolean,
): BranchRequirements {
  const draft = emptyDraft();
  applyRules(draft, rules);
  applyProtection(draft, protection);
  const body = {
    requiredChecks: [...draft.requiredChecks.values()].sort((a, b) => (a.context < b.context ? -1 : 1)),
    strictChecks: draft.strictChecks,
    requiredApprovals: draft.requiredApprovals,
    requireCodeOwnerReview: draft.requireCodeOwnerReview,
    dismissStaleReviews: draft.dismissStaleReviews,
    requireLastPushApproval: draft.requireLastPushApproval,
    requireThreadResolution: draft.requireThreadResolution,
    requireLinearHistory: draft.requireLinearHistory,
    allowedMergeMethods: draft.allowedMergeMethods ? [...draft.allowedMergeMethods].sort() : null,
    mergeQueue: draft.mergeQueue,
    sources: [...draft.sources].sort(),
    protectionVisible,
  };
  return { branch, ...body, fingerprint: fingerprint(body) };
}

const QUEUE_STATES: readonly MergeQueueEntryState[] = [
  'AWAITING_CHECKS',
  'LOCKED',
  'MERGEABLE',
  'QUEUED',
  'UNMERGEABLE',
];

export function toMergeQueueEntry(value: unknown): MergeQueueEntry | null {
  const raw = asRecord(value);
  const id = asString(raw.id);
  if (!id) return null;
  const state = asString(raw.state) as MergeQueueEntryState | null;
  return {
    id,
    position: asNumber(raw.position) ?? 0,
    state: state && QUEUE_STATES.includes(state) ? state : 'QUEUED',
    pullRequestNumber: asNumber(field(raw, 'pullRequest', 'number')),
    headSha: asString(field(raw, 'headCommit', 'oid')),
    baseSha: asString(field(raw, 'baseCommit', 'oid')),
    enqueuedAt: asString(raw.enqueuedAt) ?? '',
  };
}

export function toGraphState(value: unknown): PullRequestGraphState {
  const raw = asRecord(value);
  const decision = asString(raw.reviewDecision);
  return {
    nodeId: asString(raw.id) ?? '',
    reviewDecision:
      decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED'
        ? (decision as ReviewDecision)
        : null,
    mergeStateStatus: toMergeStateStatus(raw.mergeStateStatus),
    isInMergeQueue: asBoolean(raw.isInMergeQueue) ?? false,
    isMergeQueueEnabled: asBoolean(raw.isMergeQueueEnabled) ?? false,
    mergeQueueEntry: raw.mergeQueueEntry == null ? null : toMergeQueueEntry(raw.mergeQueueEntry),
  };
}

const ASYNC_STATUSES: readonly AsyncMergeStatus[] = ['pending', 'merged', 'enqueued', 'failed'];

export function toAsyncMergeResult(value: unknown): AsyncMergeResult {
  const raw = asRecord(value);
  const details = asRecord(raw.details);
  const status = asString(raw.status) as AsyncMergeStatus | null;
  return {
    status: status && ASYNC_STATUSES.includes(status) ? status : 'pending',
    uuid: asString(details.uuid),
    sha: asString(details.sha),
    message: asString(details.message),
    expectedHeadSha: asString(details.expected_head_sha),
  };
}
