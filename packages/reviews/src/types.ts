import type { DiffFile, ReviewSource } from './patch.ts';

export type ReviewType = 'code' | 'security' | 'integration';
export const REVIEW_TYPES: readonly ReviewType[] = ['code', 'security', 'integration'];

export type ReviewStatus = 'pending' | 'running' | 'passed' | 'changes_requested' | 'failed' | 'invalidated';
export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'resolved';
export type CacheDecision = 'reuse' | 'incremental' | 'full';

export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['high', 'critical'];

export interface FindingInput {
  ruleId?: string;
  severity: FindingSeverity;
  confidence: number;
  path?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  reason: string;
  evidence?: string | null;
  suggestedFix?: string | null;
}

export interface StructuredFindings {
  verdict?: 'passed' | 'changes_requested';
  confidence: number;
  summary?: string;
  findings: FindingInput[];
}

export interface ContextCoverage {
  kind: 'whole-tree' | 'bounded' | 'unavailable';
  depth: number | null;
  limit: number | null;
  truncated: boolean;
  missingPaths: string[];
  unresolvedImports: string[];
}

export interface ReviewContext {
  contentFingerprint: string | null;
  coverage: ContextCoverage;
  dependencyFingerprint: string | null;
  interfaceFingerprint: string | null;
  symbolGraphRevision: string | null;
}

export interface ReviewInput {
  reviewType: ReviewType;
  repositoryId: string;
  commitSha: string;
  baseSha: string;
  patch: string;
  files: DiffFile[];
  scope: 'full' | 'incremental';
  focusPaths: string[];
  securityClasses: string[];
  context: ReviewContext;
  reasons: string[];
}

export interface Reviewer {
  readonly identity: string;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly evidenceScope?: 'whole-tree' | 'patch';
  readonly configurationFingerprint?: string;
  review(input: ReviewInput): Promise<StructuredFindings>;
}

export interface ContextFingerprintProvider {
  collect(repositoryId: string, sha: string, paths: readonly string[]): Promise<ReviewContext>;
}

export interface EvidenceInputs {
  version: 2;
  source: ReviewSource;
  context: ReviewContext;
  contextOrigin: 'source' | 'provider';
  reviewerScope: 'whole-tree' | 'patch';
  repositoryId: string;
  reviewType: ReviewType;
  patchHash: string;
  fileHashes: Record<string, string>;
  policyVersion: string;
  reviewerIdentity: string;
  reviewerModel: string | null;
  reviewerConfiguration: string | null;
  promptVersion: string;
  dependencyContext: string | null;
  interfaceContext: string | null;
  symbolGraphRevision: string | null;
  securityClasses: string[];
}

export interface Finding {
  id: string;
  reviewId: string;
  signature: string;
  severity: FindingSeverity;
  confidence: number;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  reason: string;
  evidence: string | null;
  suggestedFix: string | null;
  status: FindingStatus;
  reviewerIdentity: string;
  commitSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewArtifact {
  id: string;
  repositoryId: string;
  prId: string | null;
  taskId: string | null;
  reviewType: ReviewType;
  fingerprint: string;
  fingerprintInputs: EvidenceInputs;
  commitSha: string;
  baseSha: string | null;
  status: ReviewStatus;
  reviewerIdentity: string;
  reviewerModel: string | null;
  policyVersion: string;
  promptVersion: string;
  securityClasses: string[];
  scope: string | null;
  confidence: number | null;
  llmInvoked: boolean;
  reusedFrom: string | null;
  invalidatedReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  findings: Finding[];
}
