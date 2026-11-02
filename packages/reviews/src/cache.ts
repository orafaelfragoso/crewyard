import { fingerprint } from '@crewyard/core';
import type { CacheDecision, EvidenceInputs } from './types.ts';

export function evidenceFingerprint(inputs: EvidenceInputs): string {
  const { fileHashes: _fileHashes, ...keyed } = inputs;
  return fingerprint(keyed);
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
  return inputs.dependencyContext !== null && !inputs.dependencyContext.startsWith('base:');
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
  let integrationRequired = false;
  if (prior) {
    const p = prior.inputs;
    if (p.patchHash !== current.patchHash) reasons.push('patch_changed');
    if (p.policyVersion !== current.policyVersion) reasons.push('policy_changed');
    if (
      p.reviewerIdentity !== current.reviewerIdentity ||
      p.reviewerModel !== current.reviewerModel ||
      p.promptVersion !== current.promptVersion
    ) {
      reasons.push('reviewer_changed');
    }
    if (p.dependencyContext !== current.dependencyContext) reasons.push('dependency_context_changed');
    if (p.interfaceContext !== current.interfaceContext) reasons.push('interface_changed');
    if (p.symbolGraphRevision !== current.symbolGraphRevision) reasons.push('symbol_graph_changed');
    if (p.securityClasses.join(',') !== current.securityClasses.join(',')) reasons.push('security_class_changed');
    integrationRequired = reasons.includes('interface_changed') || reasons.includes('dependency_context_changed');
  }
  const base = { integrationRequired, reuseFrom: null, incrementalFrom: null, changedPaths: [] as string[] };
  if (exact) {
    if (!policy.cacheEnabled) reasons.push('cache_disabled');
    else if (policy.forbidReuse) reasons.push('risk_class_forbids_reuse');
    else if (exact.expired) reasons.push('cache_expired');
    else if ((exact.confidence ?? 0) < policy.minConfidence) reasons.push('low_confidence_prior');
    else return { ...base, decision: 'reuse', reasons: ['fingerprint_match'], reuseFrom: exact.id };
  } else if (!prior) {
    reasons.push('no_prior_review');
  }
  if (!isContextKnown(current)) reasons.push('dependency_context_unknown');
  const onlyPatchChanged =
    prior !== null &&
    reasons.includes('patch_changed') &&
    !reasons.some((r) =>
      ['policy_changed', 'reviewer_changed', 'security_class_changed', 'low_confidence_prior'].includes(r),
    );
  if (policy.incremental && onlyPatchChanged && isContextKnown(current) && isContextKnown(prior.inputs)) {
    const paths = changedPaths(prior.inputs, current);
    const total = new Set([...Object.keys(prior.inputs.fileHashes), ...Object.keys(current.fileHashes)]).size;
    if (paths.length > 0 && paths.length < total) {
      return { ...base, decision: 'incremental', reasons, changedPaths: paths, incrementalFrom: prior.id };
    }
  }
  return { ...base, decision: 'full', reasons, changedPaths: Object.keys(current.fileHashes).sort() };
}
