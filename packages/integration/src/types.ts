import type { CrewConfig } from '@crewyard/config';
import type { Risk } from '@crewyard/core';
import type {
  BranchRequirements,
  CheckResult,
  GitHubClient,
  MergeQueueEntry,
  PullRequestFile,
  PullRequestReview,
  StackInfo,
} from '@crewyard/github';
import type { Repository } from '@crewyard/projects';

export interface TaskHookEvent {
  taskId: string;
  prId: string;
  prNumber: number;
  repositoryId: string;
}

export interface TaskHooks {
  onQueued?(event: TaskHookEvent & { entryId: string; revived?: boolean }): void | Promise<void>;
  onValidating?(event: TaskHookEvent & { candidateId: string }): void | Promise<void>;
  onMerged?(event: TaskHookEvent & { mergeCommitSha: string }): void | Promise<void>;
  onBlocked?(event: TaskHookEvent & { reason: string; blockers: Blocker[] }): void | Promise<void>;
  onEscalated?(event: TaskHookEvent & { reason: string; failureFingerprint: string | null }): void | Promise<void>;
  onRevisionRequired?(
    event: TaskHookEvent & { reason: string; details: Record<string, unknown> },
  ): void | Promise<void>;
}

export type GitHubClientFactory = (repository: Repository) => GitHubClient;

export interface IntegrationEnv {
  github?: GitHubClientFactory;
  hooks?: TaskHooks;
  config?: CrewConfig;
  remoteUrl?: (repository: Repository) => Promise<string | null>;
  leaseTtlSeconds?: number;
}

export type DivergenceKind =
  | 'force_push'
  | 'external_push'
  | 'merged_outside_crew'
  | 'closed_outside_crew'
  | 'rules_changed'
  | 'reviewers_changed'
  | 'base_retargeted';

export interface Divergence {
  kinds: DivergenceKind[];
  blocking: boolean;
  detectedAt: string;
  previousHead: string | null;
  observedHead: string | null;
  detail: string;
}

export interface Governance {
  requirements: BranchRequirements | null;
  integrationBase: string;
  nodeId: string | null;
  isInMergeQueue: boolean;
  mergeQueueEntry: MergeQueueEntry | null;
  stack: StackInfo | null;
  workflowRuns: { name: string; event: string; status: string; conclusion: string | null }[];
}

export type ChecksState = 'success' | 'pending' | 'failure' | 'none';

export interface PullRequestRecord {
  id: string;
  repositoryId: string;
  number: number;
  taskId: string | null;
  url: string | null;
  title: string;
  author: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string | null;
  expectedRemoteHead: string | null;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  checksState: ChecksState | null;
  checks: CheckResult[];
  reviews: PullRequestReview[];
  governance: Governance | null;
  changedFiles: PullRequestFile[] | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  stackId: string | null;
  stackOrder: number | null;
  imported: boolean;
  externalDivergence: Divergence | null;
  remoteUpdatedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BlockerSource = 'github' | 'policy' | 'crew' | 'stack' | 'queue' | 'sync';

export interface Blocker {
  code: string;
  message: string;
  source: BlockerSource;
  soft?: boolean;
  details?: Record<string, unknown>;
}

export type QueueMode = 'github-managed' | 'crew-managed';
export type QueueEntryStatus =
  | 'waiting'
  | 'eligible'
  | 'candidate'
  | 'validating'
  | 'merging'
  | 'merged'
  | 'blocked'
  | 'quarantined'
  | 'escalated'
  | 'removed';

export const ACTIVE_ENTRY_STATUSES: readonly QueueEntryStatus[] = [
  'waiting',
  'eligible',
  'candidate',
  'validating',
  'merging',
  'blocked',
  'quarantined',
  'escalated',
];

export interface IntegrationQueue {
  id: string;
  repositoryId: string;
  baseBranch: string;
  mode: QueueMode;
  paused: boolean;
  capacity: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueueEntry {
  id: string;
  queueId: string;
  prId: string;
  priority: number;
  risk: Risk;
  stackId: string | null;
  stackOrder: number | null;
  status: QueueEntryStatus;
  blockers: Blocker[];
  attempts: number;
  lastValidatedBaseSha: string | null;
  lastValidatedHeadSha: string | null;
  requestedBy: string;
  enqueuedAt: string;
  updatedAt: string;
}

export type CandidateStatus = 'building' | 'validating' | 'valid' | 'invalid' | 'merged' | 'failed';

export interface CandidateStep {
  entryId: string;
  prId: string;
  number: number;
  headSha: string;
  treeSha: string | null;
  commitSha: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
}

export interface IntegrationCandidate {
  id: string;
  queueId: string;
  baseSha: string;
  entries: CandidateStep[];
  treeSha: string | null;
  commitSha: string | null;
  policyRevision: number;
  rulesFingerprint: string | null;
  status: CandidateStatus;
  ciEvidence: Record<string, unknown>;
  integrationValidated: boolean;
  invalidReason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
