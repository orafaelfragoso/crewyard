import type { CrewConfig } from '@crewyard/config';
import { fingerprint } from '@crewyard/core';
import type { CacheDecision, EvidenceInputs, ReviewArtifact, Reviewer, ReviewType } from './types.ts';

export function evidenceFingerprint(inputs: EvidenceInputs): string {
  return fingerprint(inputs);
}

export function reviewPolicyVersion(config: Pick<CrewConfig, 'review' | 'security'>): string {
  return fingerprint({ review: config.review, security: config.security });
}

export type ReviewReviewerIdentity = Pick<
  Reviewer,
  'identity' | 'model' | 'promptVersion' | 'configurationFingerprint'
>;

export interface ReviewAcceptancePolicy {
  at: string;
  expectedBaseSha: string | null;
  policyVersion: string;
  minConfidence: number;
  cacheEnabled: boolean;
  requireReviewForHighRisk: boolean;
  expectedReviewers: Partial<Record<ReviewType, ReviewReviewerIdentity>>;
}

export function isCurrentEvidence(inputs: EvidenceInputs): boolean {
  return inputs.version === 2 && inputs.source !== undefined && inputs.context !== undefined;
}

export function reviewEvidenceValidity(review: ReviewArtifact, policy: ReviewAcceptancePolicy): string | null {
  const inputs = review.fingerprintInputs;
  if (!isCurrentEvidence(inputs) || inputs.source.kind !== 'git') return 'unsupported_evidence';
  if (policy.expectedBaseSha === null || review.baseSha !== policy.expectedBaseSha) return 'base_changed';
  const expected = policy.expectedReviewers[review.reviewType];
  if (!expected) return 'reviewer_identity_unavailable';
  if (
    inputs.reviewerIdentity !== expected.identity ||
    inputs.reviewerModel !== expected.model ||
    inputs.promptVersion !== expected.promptVersion ||
    inputs.reviewerConfiguration !== (expected.configurationFingerprint ?? null)
  )
    return 'reviewer_changed';
  if (review.status === 'invalidated' || review.status === 'failed') return 'invalidated_evidence';
  if (review.expiresAt === null || review.expiresAt <= policy.at) return 'evidence_expired';
  if (review.policyVersion !== policy.policyVersion || inputs.policyVersion !== policy.policyVersion)
    return 'policy_changed';
  if ((review.confidence ?? 0) < policy.minConfidence) return 'low_confidence_prior';
  if (review.fingerprint !== evidenceFingerprint(inputs)) return 'evidence_identity_mismatch';
  if (
    inputs.reviewerIdentity !== review.reviewerIdentity ||
    inputs.reviewerModel !== review.reviewerModel ||
    inputs.promptVersion !== review.promptVersion
  )
    return 'reviewer_changed';
  if (
    (review.scope === 'reused' || review.scope === 'incremental') &&
    (!policy.cacheEnabled ||
      (review.reviewType === 'security' && inputs.securityClasses.length > 0 && policy.requireReviewForHighRisk))
  )
    return 'reuse_forbidden';
  return null;
}

export interface CachePolicy {
  cacheEnabled: boolean;
  incremental: boolean;
  forbidReuse: boolean;
  minConfidence: number;
}

export interface CacheCandidate {
  id: string;
  fingerprint: string;
  inputs: EvidenceInputs;
  confidence: number | null;
  expired: boolean;
}

export interface CacheDecisionResult {
  decision: CacheDecision;
  reasons: string[];
  changedPaths: string[];
  integrationRequired: boolean;
  reuseFrom: string | null;
  incrementalFrom: string | null;
}

export function isContextKnown(inputs: EvidenceInputs): boolean {
  if (!isCurrentEvidence(inputs)) return false;
  const { coverage } = inputs.context;
  return (
    inputs.context.contentFingerprint !== null &&
    coverage.kind === 'whole-tree' &&
    !coverage.truncated &&
    coverage.missingPaths.length === 0 &&
    coverage.unresolvedImports.length === 0
  );
}

export function changedPaths(previous: EvidenceInputs, current: EvidenceInputs): string[] {
  const paths = new Set([...Object.keys(previous.fileHashes), ...Object.keys(current.fileHashes)]);
  return [...paths].filter((p) => previous.fileHashes[p] !== current.fileHashes[p]).sort();
}

export function decideReviewCache(input: {
  current: EvidenceInputs;
  exact: CacheCandidate | null;
  prior: CacheCandidate | null;
  policy: CachePolicy;
}): CacheDecisionResult {
  const { current, exact, prior, policy } = input;
  const reasons: string[] = [];
  const previous = prior && isCurrentEvidence(prior.inputs) ? prior : null;
  if (prior && !previous) reasons.push('unsupported_evidence');
  if (previous) {
    const p = previous.inputs;
    if (p.patchHash !== current.patchHash) reasons.push('patch_changed');
    if (p.policyVersion !== current.policyVersion) reasons.push('policy_changed');
    if (
      p.reviewerIdentity !== current.reviewerIdentity ||
      p.reviewerModel !== current.reviewerModel ||
      p.promptVersion !== current.promptVersion ||
      p.reviewerConfiguration !== current.reviewerConfiguration ||
      p.reviewerScope !== current.reviewerScope
    )
      reasons.push('reviewer_changed');
    if (p.dependencyContext !== current.dependencyContext) reasons.push('dependency_context_changed');
    if (p.interfaceContext !== current.interfaceContext) reasons.push('interface_changed');
    if (fingerprint(p.context) !== fingerprint(current.context)) reasons.push('context_changed');
    if (p.symbolGraphRevision !== current.symbolGraphRevision) reasons.push('symbol_graph_changed');
    if (fingerprint(p.securityClasses) !== fingerprint(current.securityClasses)) reasons.push('security_class_changed');
  }
  const base = {
    integrationRequired: reasons.some((reason) =>
      ['interface_changed', 'dependency_context_changed', 'context_changed'].includes(reason),
    ),
    reuseFrom: null,
    incrementalFrom: null,
    changedPaths: Object.keys(current.fileHashes).sort(),
  };
  if (!policy.cacheEnabled) reasons.push('cache_disabled');
  if (policy.forbidReuse) reasons.push('risk_class_forbids_reuse');
  const reusable = (candidate: CacheCandidate): boolean => {
    if (!isCurrentEvidence(candidate.inputs)) {
      reasons.push('unsupported_evidence');
      return false;
    }
    if (candidate.expired) {
      reasons.push('cache_expired');
      return false;
    }
    if ((candidate.confidence ?? 0) < policy.minConfidence) {
      reasons.push('low_confidence_prior');
      return false;
    }
    if (candidate.fingerprint !== evidenceFingerprint(candidate.inputs)) {
      reasons.push('evidence_identity_mismatch');
      return false;
    }
    return true;
  };
  if (
    policy.cacheEnabled &&
    !policy.forbidReuse &&
    exact &&
    reusable(exact) &&
    exact.fingerprint === evidenceFingerprint(current)
  ) {
    return { ...base, decision: 'reuse', reasons: ['fingerprint_match'], reuseFrom: exact.id, changedPaths: [] };
  }
  if (!prior) reasons.push('no_prior_review');
  if (!isContextKnown(current)) reasons.push('context_incomplete');
  if (
    policy.cacheEnabled &&
    !policy.forbidReuse &&
    policy.incremental &&
    previous &&
    reusable(previous) &&
    current.reviewerScope === 'patch' &&
    isContextKnown(current) &&
    isContextKnown(previous.inputs) &&
    reasons.every((reason) => reason === 'patch_changed')
  ) {
    const paths = changedPaths(previous.inputs, current);
    const total = new Set([...Object.keys(previous.inputs.fileHashes), ...Object.keys(current.fileHashes)]).size;
    if (paths.length > 0 && paths.length < total) {
      return { ...base, decision: 'incremental', reasons, changedPaths: paths, incrementalFrom: previous.id };
    }
  }
  return { ...base, decision: 'full', reasons };
}
