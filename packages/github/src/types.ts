export interface RepositoryCoordinates {
  host: string;
  owner: string;
  name: string;
}

export type PullRequestState = 'open' | 'closed' | 'merged';
export type Mergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type MergeStateStatus =
  | 'CLEAN'
  | 'DIRTY'
  | 'BLOCKED'
  | 'BEHIND'
  | 'UNSTABLE'
  | 'HAS_HOOKS'
  | 'DRAFT'
  | 'UNKNOWN';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface StackInfo {
  id: string;
  position: number;
  size: number;
  baseRef: string;
  baseSha: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  author: string | null;
  state: PullRequestState;
  isDraft: boolean;
  headRef: string;
  headSha: string;
  headRepository: string | null;
  baseRef: string;
  baseSha: string;
  mergeable: Mergeability;
  mergeStateStatus: MergeStateStatus;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  updatedAt: string;
  stack: StackInfo | null;
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface PullRequestFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  blobSha: string | null;
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface PullRequestReview {
  id: string;
  reviewer: string;
  state: ReviewState;
  commitSha: string | null;
  submittedAt: string | null;
}

export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped';

export interface CheckResult {
  name: string;
  kind: 'check_run' | 'status';
  state: CheckState;
  appId: number | null;
  headSha: string;
  detailsUrl: string | null;
}

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
}

export interface RequiredCheck {
  context: string;
  appId: number | null;
}

export interface MergeQueueRule {
  mergeMethod: MergeMethod;
  groupingStrategy: 'ALLGREEN' | 'HEADGREEN';
  maxEntriesToBuild: number;
  maxEntriesToMerge: number;
  minEntriesToMerge: number;
  checkResponseTimeoutMinutes: number;
}

export interface BranchRequirements {
  branch: string;
  requiredChecks: RequiredCheck[];
  strictChecks: boolean;
  requiredApprovals: number;
  requireCodeOwnerReview: boolean;
  dismissStaleReviews: boolean;
  requireLastPushApproval: boolean;
  requireThreadResolution: boolean;
  requireLinearHistory: boolean;
  allowedMergeMethods: MergeMethod[] | null;
  mergeQueue: MergeQueueRule | null;
  sources: ('ruleset' | 'branch_protection')[];
  protectionVisible: boolean;
  fingerprint: string;
}

export type MergeQueueEntryState = 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'QUEUED' | 'UNMERGEABLE';

export interface MergeQueueEntry {
  id: string;
  position: number;
  state: MergeQueueEntryState;
  pullRequestNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  enqueuedAt: string;
}

export interface PullRequestGraphState {
  nodeId: string;
  reviewDecision: ReviewDecision;
  mergeable: Mergeability;
  mergeStateStatus: MergeStateStatus;
  isInMergeQueue: boolean;
  isMergeQueueEnabled: boolean;
  mergeQueueEntry: MergeQueueEntry | null;
  mergeCommitSha: string | null;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

export type AsyncMergeStatus = 'pending' | 'merged' | 'enqueued' | 'failed';
export type AsyncMergeAction = 'default' | 'direct_merge' | 'merge_queue';

export interface AsyncMergeResult {
  status: AsyncMergeStatus;
  uuid: string | null;
  sha: string | null;
  message: string | null;
  expectedHeadSha: string | null;
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface BranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
  base?: string;
  state?: 'open' | 'closed';
}
