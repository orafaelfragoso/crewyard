import type { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import type { CrewConfig } from '@crewyard/config';
import {
  type Actor,
  addSeconds,
  CrewError,
  fingerprint,
  isProcessAlive,
  matchesRecordedProcess,
  newId,
  nowIso,
  processIdentity,
  type Risk,
  SYSTEM_ACTOR,
} from '@crewyard/core';
import {
  abandonExecutionClaim,
  acquireExecutionClaim,
  all,
  assertExecutionClaim,
  bindExecutionProcess,
  type CrewContext,
  type ExecutionClaim,
  type ExecutionProcessIdentity,
  getExecutionClaim,
  one,
  parseJson,
  recordTransition,
  releaseExecutionClaim,
  renewExecutionClaim,
  toJson,
} from '@crewyard/storage';
import {
  type CacheCandidate,
  type CacheDecisionResult,
  decideReviewCache,
  evidenceFingerprint,
  type ReviewAcceptancePolicy,
  reviewEvidenceValidity,
  reviewPolicyVersion,
  sourceReviewContext,
} from './cache.ts';
import { classifyPaths } from './classify.ts';
import { collectReviewSource, normalizePatch, parseUnifiedDiff, type ReviewSource } from './patch.ts';
import {
  BLOCKING_SEVERITIES,
  type CacheDecision,
  type ContextFingerprintProvider,
  type EvidenceInputs,
  type Finding,
  type FindingInput,
  type FindingStatus,
  REVIEW_TYPES,
  type ReviewArtifact,
  type ReviewContext,
  type Reviewer,
  type ReviewStatus,
  type ReviewType,
} from './types.ts';

interface ReviewRow {
  id: string;
  repository_id: string;
  pr_id: string | null;
  task_id: string | null;
  review_type: ReviewType;
  fingerprint: string;
  fingerprint_inputs: string;
  commit_sha: string;
  base_sha: string | null;
  status: ReviewStatus;
  reviewer_identity: string;
  reviewer_model: string | null;
  policy_version: string;
  prompt_version: string;
  security_class: string;
  scope: string | null;
  confidence: number | null;
  llm_invoked: number;
  reused_from: string | null;
  invalidated_reason: string | null;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
}

interface FindingRow {
  id: string;
  review_id: string;
  signature: string;
  severity: Finding['severity'];
  confidence: number;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  reason: string;
  evidence: string | null;
  suggested_fix: string | null;
  status: FindingStatus;
  reviewer_identity: string;
  commit_sha: string;
  created_at: string;
  updated_at: string;
}

const mapFinding = (r: FindingRow): Finding => ({
  id: r.id,
  reviewId: r.review_id,
  signature: r.signature,
  severity: r.severity,
  confidence: r.confidence,
  path: r.path,
  startLine: r.start_line,
  endLine: r.end_line,
  reason: r.reason,
  evidence: r.evidence,
  suggestedFix: r.suggested_fix,
  status: r.status,
  reviewerIdentity: r.reviewer_identity,
  commitSha: r.commit_sha,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function mapReview(db: Database, r: ReviewRow): ReviewArtifact {
  return {
    id: r.id,
    repositoryId: r.repository_id,
    prId: r.pr_id,
    taskId: r.task_id,
    reviewType: r.review_type,
    fingerprint: r.fingerprint,
    fingerprintInputs: parseJson(r.fingerprint_inputs, {} as EvidenceInputs),
    commitSha: r.commit_sha,
    baseSha: r.base_sha,
    status: r.status,
    reviewerIdentity: r.reviewer_identity,
    reviewerModel: r.reviewer_model,
    policyVersion: r.policy_version,
    promptVersion: r.prompt_version,
    securityClasses: parseJson<string[]>(r.security_class, []),
    scope: r.scope,
    confidence: r.confidence,
    llmInvoked: r.llm_invoked === 1,
    reusedFrom: r.reused_from,
    invalidatedReason: r.invalidated_reason,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    findings: all<FindingRow>(
      db,
      'SELECT * FROM review_findings WHERE review_id = ? ORDER BY path, start_line, signature',
      r.id,
    ).map(mapFinding),
  };
}

export function findingSignature(finding: FindingInput): string {
  const semantic = (finding.ruleId ?? finding.reason)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return fingerprint({
    path: finding.path ?? null,
    start: finding.startLine ?? null,
    end: finding.endLine ?? finding.startLine ?? null,
    semantic,
  }).slice(0, 32);
}

export interface ReviewDeps {
  reviewers: Partial<Record<ReviewType, Reviewer>>;
  config: Pick<CrewConfig, 'review' | 'security'>;
  context?: ContextFingerprintProvider;
  minConfidence?: number;
}

export interface RequestReviewInput {
  repositoryId: string;
  prId?: string | null;
  taskId?: string | null;
  commitSha: string;
  baseSha: string;
  patch: string;
  source?: { kind: 'synthetic' };
  types?: ReviewType[];
  force?: boolean;
  actor?: Actor;
}

export interface ReviewOutcome {
  reviewType: ReviewType;
  decision: CacheDecision | 'skipped';
  reasons: string[];
  reviewerInvoked: boolean;
  review: ReviewArtifact | null;
  error: string | null;
}

export interface RequestReviewResult {
  risk: Risk;
  securityClasses: string[];
  integrationRequired: boolean;
  outcomes: ReviewOutcome[];
}

async function resolveContext(
  input: RequestReviewInput,
  paths: string[],
  provider: ContextFingerprintProvider | undefined,
  source: ReviewSource,
): Promise<ReviewContext> {
  if (provider) {
    const context = await provider.collect(input.repositoryId, input.commitSha, paths);
    if (context.contentFingerprint === null || context.coverage.kind === 'unavailable')
      throw new CrewError('INDEX_STALE', 'Review context is unavailable');
    return context;
  }
  return sourceReviewContext(source);
}

function candidate(row: ReviewRow | null, at: string): CacheCandidate | null {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    inputs: parseJson(row.fingerprint_inputs, {} as EvidenceInputs),
    confidence: row.confidence,
    expired: row.expires_at === null || row.expires_at <= at,
  };
}

function priorFor(db: Database, input: RequestReviewInput, type: ReviewType): ReviewRow | null {
  if (!input.prId && !input.taskId) return null;
  return one<ReviewRow>(
    db,
    `SELECT * FROM review_artifacts WHERE review_type = ? AND repository_id = ? AND status IN ('passed', 'changes_requested')
       AND ((? IS NOT NULL AND pr_id = ?) OR (? IS NOT NULL AND task_id = ?))
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    type,
    input.repositoryId,
    input.prId ?? null,
    input.prId ?? null,
    input.taskId ?? null,
    input.taskId ?? null,
  );
}

function insertFindings(
  db: Database,
  reviewId: string,
  reviewer: string,
  commitSha: string,
  findings: (FindingInput & { status?: FindingStatus; signature?: string })[],
  at: string,
): void {
  const stmt = db.query(
    `INSERT OR IGNORE INTO review_findings (id, review_id, signature, severity, confidence, path, start_line, end_line, reason, evidence, suggested_fix, status, reviewer_identity, commit_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of findings) {
    stmt.run(
      newId('fnd'),
      reviewId,
      f.signature ?? findingSignature(f),
      f.severity,
      Math.min(1, Math.max(0, f.confidence)),
      f.path ?? null,
      f.startLine ?? null,
      f.endLine ?? f.startLine ?? null,
      f.reason,
      f.evidence ?? null,
      f.suggestedFix ?? null,
      f.status ?? 'open',
      reviewer,
      commitSha,
      at,
      at,
    );
  }
}

function carriedFindings(prior: ReviewArtifact, keepPaths: Set<string> | null) {
  return prior.findings
    .filter((f) => keepPaths === null || (f.path !== null && keepPaths.has(f.path)))
    .map((f) => ({
      severity: f.severity,
      confidence: f.confidence,
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      reason: f.reason,
      evidence: f.evidence,
      suggestedFix: f.suggestedFix,
      status: f.status,
      signature: f.signature,
    }));
}

function statusFromFindings(db: Database, reviewId: string): ReviewStatus {
  const blocking = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM review_findings WHERE review_id = ? AND status IN ('open', 'accepted') AND severity IN (${BLOCKING_SEVERITIES.map(() => '?').join(',')})`,
    reviewId,
    ...BLOCKING_SEVERITIES,
  )!.n;
  return blocking > 0 ? 'changes_requested' : 'passed';
}

function insertArtifact(
  db: Database,
  values: {
    id: string;
    input: RequestReviewInput;
    type: ReviewType;
    fp: string;
    inputs: EvidenceInputs;
    status: ReviewStatus;
    reviewer: Reviewer;
    scope: string;
    confidence: number | null;
    llmInvoked: boolean;
    reusedFrom: string | null;
    expiresAt: string;
    at: string;
  },
): void {
  const { input, reviewer } = values;
  db.query(
    `INSERT INTO review_artifacts (id, repository_id, pr_id, task_id, review_type, fingerprint, fingerprint_inputs, commit_sha, base_sha, status, reviewer_identity, reviewer_model, policy_version, prompt_version, security_class, scope, confidence, llm_invoked, reused_from, expires_at, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    input.repositoryId,
    input.prId ?? null,
    input.taskId ?? null,
    values.type,
    values.fp,
    toJson(values.inputs),
    input.commitSha,
    input.baseSha,
    values.status,
    reviewer.identity,
    reviewer.model,
    values.inputs.policyVersion,
    reviewer.promptVersion,
    toJson(values.inputs.securityClasses),
    values.scope,
    values.confidence,
    values.llmInvoked ? 1 : 0,
    values.reusedFrom,
    values.expiresAt,
    values.at,
    values.status === 'running' || values.status === 'pending' ? null : values.at,
  );
}

const REVIEW_CLAIM_TTL_SECONDS = 30;

interface ReviewAttemptRow {
  id: string;
  fingerprint: string;
  mode: 'full' | 'incremental';
  review_id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
}

type ReviewAdmission =
  | { kind: 'ready'; review: ReviewArtifact; decision: CacheDecisionResult }
  | { kind: 'joined'; id: string; attemptId: string; decision: CacheDecisionResult }
  | { kind: 'run'; id: string; claim: ExecutionClaim; expiresAt: string; decision: CacheDecisionResult };

function recordReviewRequest(
  db: Database,
  input: RequestReviewInput,
  reviewId: string,
  attemptId: string | null,
  fp: string,
  at: string,
  ownerProcess: ExecutionProcessIdentity,
): void {
  db.query(`INSERT INTO review_requests (id, attempt_id, review_id, repository_id, pr_id, task_id, fingerprint, force, status, created_at, completed_at, process_host, process_pid, process_start_identity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId('rrq'),
    attemptId,
    reviewId,
    input.repositoryId,
    input.prId ?? null,
    input.taskId ?? null,
    fp,
    input.force ? 1 : 0,
    attemptId === null ? 'completed' : 'waiting',
    at,
    attemptId === null ? at : null,
    ownerProcess.host,
    ownerProcess.pid,
    ownerProcess.startIdentity,
  );
}

function abandonReviewAttachment(db: Database, reviewId: string, actor: Actor, at: string): ReviewArtifact {
  const review = mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', reviewId)!);
  if (review.status !== 'pending') return review;
  db.query(
    "UPDATE review_requests SET status = 'interrupted', completed_at = ? WHERE review_id = ? AND status = 'waiting'",
  ).run(at, reviewId);
  db.query(
    "UPDATE review_artifacts SET status = 'invalidated', completed_at = ?, invalidated_reason = 'attachment_interrupted' WHERE id = ?",
  ).run(at, reviewId);
  recordTransition(
    db,
    {
      type: 'review.invalidated',
      actor,
      prId: review.prId,
      taskId: review.taskId,
      payload: { reviewIds: [reviewId], reason: 'attachment_interrupted' },
    },
    { action: 'review.attachment_abandon', input: { reviewId }, decision: 'invalidated' },
    at,
  );
  return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', reviewId)!);
}

function interruptReviewAttempt(db: Database, attempt: ReviewAttemptRow, at: string, actor: Actor): void {
  if (one<ReviewAttemptRow>(db, 'SELECT * FROM review_attempts WHERE id = ?', attempt.id)?.status !== 'running') return;
  db.query("UPDATE review_attempts SET status = 'interrupted', completed_at = ? WHERE id = ?").run(at, attempt.id);
  const rows = all<{ id: string; pr_id: string | null; task_id: string | null }>(
    db,
    `SELECT r.id, r.pr_id, r.task_id FROM review_artifacts r JOIN review_requests q ON q.review_id = r.id WHERE q.attempt_id = ? AND q.status = 'waiting'`,
    attempt.id,
  );
  for (const row of rows) {
    db.query(
      "UPDATE review_artifacts SET status = 'failed', completed_at = ?, invalidated_reason = 'execution_claim_expired' WHERE id = ?",
    ).run(at, row.id);
    recordTransition(
      db,
      {
        type: 'review.failed',
        actor,
        prId: row.pr_id,
        taskId: row.task_id,
        payload: { reviewId: row.id, attemptId: attempt.id, error: 'execution claim expired' },
      },
      { action: 'review.interrupt', input: { reviewId: row.id, attemptId: attempt.id }, decision: 'interrupted' },
      at,
    );
  }
  db.query(
    "UPDATE review_requests SET status = 'interrupted', completed_at = ? WHERE attempt_id = ? AND status = 'waiting'",
  ).run(at, attempt.id);
}

function admitReview(
  ctx: CrewContext,
  input: RequestReviewInput,
  deps: ReviewDeps,
  type: ReviewType,
  reviewer: Reviewer,
  inputs: EvidenceInputs,
  actor: Actor,
  ownerProcess: ExecutionProcessIdentity,
): ReviewAdmission {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const fp = evidenceFingerprint(inputs);
    const exactRow = one<ReviewRow>(
      db,
      "SELECT * FROM review_artifacts WHERE review_type = ? AND fingerprint = ? AND status IN ('passed', 'changes_requested') ORDER BY created_at DESC, id DESC LIMIT 1",
      type,
      fp,
    );
    const priorRow = priorFor(db, input, type);
    const forbidReuse =
      input.force === true ||
      (type === 'security' && inputs.securityClasses.length > 0 && deps.config.review.require_review_for_high_risk);
    const decision = decideReviewCache({
      current: inputs,
      exact: candidate(exactRow, at),
      prior: candidate(priorRow, at),
      policy: {
        cacheEnabled: deps.config.review.cache_enabled,
        incremental: deps.config.review.incremental,
        forbidReuse,
        minConfidence: deps.minConfidence ?? 0.5,
      },
    });
    if (input.force) decision.reasons.push('forced');
    if (inputs.policyVersion !== reviewPolicyVersion(deps.config))
      throw new CrewError('CONFLICT', 'Review policy changed before admission');
    const id = newId('rev');
    const ttl = addSeconds(at, deps.config.review.cache_ttl_hours * 3600);
    const expiresAt =
      decision.decision === 'incremental' && priorRow?.expires_at && priorRow.expires_at < ttl
        ? priorRow.expires_at
        : ttl;
    if (decision.decision === 'reuse' && exactRow) {
      const source = mapReview(db, exactRow);
      insertArtifact(db, {
        id,
        input,
        type,
        fp,
        inputs,
        status: source.status,
        reviewer,
        scope: 'reused',
        confidence: source.confidence,
        llmInvoked: false,
        reusedFrom: source.id,
        expiresAt: source.expiresAt!,
        at,
      });
      insertFindings(db, id, reviewer.identity, input.commitSha, carriedFindings(source, null), at);
      recordReviewRequest(db, input, id, null, fp, at, ownerProcess);
      recordTransition(
        db,
        {
          type: 'review.reused',
          actor,
          taskId: input.taskId ?? null,
          prId: input.prId ?? null,
          payload: {
            reviewId: id,
            reviewType: type,
            reusedFrom: source.id,
            fingerprint: fp,
            commitSha: input.commitSha,
          },
        },
        { action: 'review.reuse', input: { fingerprint: fp }, decision: 'reused' },
        at,
      );
      return {
        kind: 'ready',
        review: mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!),
        decision,
      };
    }
    const mode = decision.decision === 'incremental' ? 'incremental' : 'full';
    const fullClaim = getExecutionClaim(db, `review:${fp}:full`);
    const selectedScope =
      fullClaim && fullClaim.releasedAt === null && fullClaim.expiresAt > at ? fullClaim.scope : `review:${fp}:${mode}`;
    const active = getExecutionClaim(db, selectedScope);
    if (active && active.releasedAt === null && active.expiresAt > at) {
      const attempt = one<ReviewAttemptRow>(db, 'SELECT * FROM review_attempts WHERE id = ?', active.attemptId);
      if (attempt?.status !== 'running' || attempt.fingerprint !== fp || (input.force && attempt.mode !== 'full'))
        throw new CrewError('CONFLICT', 'Active review execution does not match admission');
      const source = one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', attempt.review_id)!;
      insertArtifact(db, {
        id,
        input,
        type,
        fp,
        inputs,
        status: 'pending',
        reviewer,
        scope: 'joined',
        confidence: null,
        llmInvoked: false,
        reusedFrom: source.id,
        expiresAt: source.expires_at!,
        at,
      });
      recordReviewRequest(db, input, id, attempt.id, fp, at, ownerProcess);
      recordTransition(
        db,
        {
          type: 'review.joined',
          actor,
          taskId: input.taskId ?? null,
          prId: input.prId ?? null,
          payload: { reviewId: id, reviewType: type, attemptId: attempt.id, commitSha: input.commitSha },
        },
        { action: 'review.join', input: { fingerprint: fp }, decision: attempt.mode },
        at,
      );
      return {
        kind: 'joined',
        id,
        attemptId: attempt.id,
        decision: { ...decision, decision: attempt.mode, reasons: [...decision.reasons, 'active_execution_joined'] },
      };
    }
    if (active && active.releasedAt === null) {
      const interrupted = one<ReviewAttemptRow>(db, 'SELECT * FROM review_attempts WHERE id = ?', active.attemptId);
      if (interrupted) interruptReviewAttempt(db, interrupted, at, actor);
    }
    const claim = acquireExecutionClaim(
      db,
      {
        scope: selectedScope,
        attemptId: newId('rat'),
        ownerId: newId('wrk'),
        inputIdentity: fp,
        ttlSeconds: REVIEW_CLAIM_TTL_SECONDS,
      },
      at,
    );
    if (!claim) throw new CrewError('CONFLICT', 'Review execution was claimed during admission');
    bindExecutionProcess(db, claim, ownerProcess, at);
    insertArtifact(db, {
      id,
      input,
      type,
      fp,
      inputs,
      status: 'running',
      reviewer,
      scope: mode,
      confidence: null,
      llmInvoked: reviewer.model !== null,
      reusedFrom: decision.incrementalFrom,
      expiresAt,
      at,
    });
    db.query(
      "INSERT INTO review_attempts (id, repository_id, fingerprint, mode, review_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
    ).run(claim.attemptId, input.repositoryId, fp, mode, id, at);
    recordReviewRequest(db, input, id, claim.attemptId, fp, at, ownerProcess);
    recordTransition(
      db,
      {
        type: 'review.started',
        actor,
        taskId: input.taskId ?? null,
        prId: input.prId ?? null,
        payload: {
          reviewId: id,
          reviewType: type,
          scope: mode,
          reasons: decision.reasons,
          commitSha: input.commitSha,
          attemptId: claim.attemptId,
        },
      },
      { action: 'review.request', input: { fingerprint: fp, scope: mode }, decision: mode },
      at,
    );
    return { kind: 'run', id, claim, expiresAt, decision };
  });
}

async function awaitReviewAttempt(ctx: CrewContext, attemptId: string, actor: Actor): Promise<ReviewArtifact | null> {
  for (;;) {
    const attempt = one<ReviewAttemptRow>(ctx.store.db, 'SELECT * FROM review_attempts WHERE id = ?', attemptId);
    if (!attempt) throw new CrewError('NOT_FOUND', `Review attempt not found: ${attemptId}`);
    if (attempt.status === 'interrupted') return null;
    if (attempt.status !== 'running') return getReview(ctx, attempt.review_id);
    const at = nowIso(ctx.clock);
    const claim = getExecutionClaim(ctx.store.db, `review:${attempt.fingerprint}:${attempt.mode}`);
    if (!claim || claim.attemptId !== attemptId || claim.releasedAt !== null || claim.expiresAt <= at) {
      const interrupted = ctx.store.immediate((db) => {
        const current = getExecutionClaim(db, `review:${attempt.fingerprint}:${attempt.mode}`);
        if (current?.attemptId === attemptId && current.releasedAt === null && current.expiresAt > nowIso(ctx.clock))
          return false;
        interruptReviewAttempt(db, attempt, at, actor);
        return true;
      });
      if (interrupted) return null;
    }
    await Bun.sleep(25);
  }
}

export async function requestReview(
  ctx: CrewContext,
  input: RequestReviewInput,
  deps: ReviewDeps,
): Promise<RequestReviewResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const startIdentity = processIdentity(process.pid);
  if (startIdentity === null) throw new CrewError('UNAVAILABLE', 'Cannot establish review worker process identity');
  const ownerProcess = { host: hostname(), pid: process.pid, startIdentity };
  const repository = one<{ canonical_path: string }>(
    ctx.store.db,
    'SELECT canonical_path FROM repositories WHERE id = ?',
    input.repositoryId,
  );
  if (!repository) throw new CrewError('NOT_FOUND', `Repository not found: ${input.repositoryId}`);
  const collected =
    input.source?.kind === 'synthetic'
      ? null
      : await collectReviewSource(repository.canonical_path, input.baseSha, input.commitSha, 16 * 1024 * 1024);
  if (collected && collected.patch !== input.patch)
    throw new CrewError('INVALID_INPUT', 'Review patch does not match the complete Git source');
  const files = collected?.files ?? parseUnifiedDiff(input.patch);
  const normalized = normalizePatch(input.patch);
  const source: ReviewSource = collected?.source ?? { kind: 'synthetic', patchHash: normalized.patchHash };
  const fileHashes =
    source.kind === 'git'
      ? Object.fromEntries(source.changes.map((change) => [change.newPath ?? change.oldPath!, fingerprint(change)]))
      : Object.fromEntries(normalized.files.map((file) => [file.path, file.hash]));
  const patchHash = source.kind === 'git' ? fingerprint(source.changes) : normalized.patchHash;
  const paths =
    source.kind === 'git'
      ? [
          ...new Set(
            source.changes.flatMap((change) =>
              [change.oldPath, change.newPath].filter((path): path is string => path !== null),
            ),
          ),
        ].sort()
      : normalized.files.map((file) => file.path);
  const additions = files.reduce((n, f) => n + f.lines.filter((l) => l.kind === 'add').length, 0);
  const deletions = files.reduce((n, f) => n + f.lines.filter((l) => l.kind === 'del').length, 0);
  const classification = classifyPaths(deps.config.security, paths, { files: files.length, additions, deletions });
  const context = await resolveContext(input, paths, deps.context, source);
  const requested = [...new Set(input.types ?? (['code', 'security'] as ReviewType[]))];
  const outcomes: ReviewOutcome[] = [];
  let integrationRequired = false;

  const queue = [...requested];
  while (queue.length > 0) {
    const type = queue.shift()!;
    const reviewer = deps.reviewers[type];
    if (!reviewer) {
      outcomes.push({
        reviewType: type,
        decision: 'skipped',
        reasons: ['no_reviewer_configured'],
        reviewerInvoked: false,
        review: null,
        error: null,
      });
      continue;
    }
    const inputs: EvidenceInputs = {
      version: 2,
      source,
      context,
      contextOrigin: deps.context ? 'provider' : 'source',
      reviewerScope: reviewer.evidenceScope ?? 'whole-tree',
      repositoryId: input.repositoryId,
      reviewType: type,
      patchHash,
      fileHashes,
      policyVersion: reviewPolicyVersion(deps.config),
      reviewerIdentity: reviewer.identity,
      reviewerModel: reviewer.model,
      reviewerConfiguration: reviewer.configurationFingerprint ?? null,
      promptVersion: reviewer.promptVersion,
      dependencyContext: context.dependencyFingerprint,
      interfaceContext: context.interfaceFingerprint,
      symbolGraphRevision: context.symbolGraphRevision,
      securityClasses: classification.classes,
    };
    const admission = admitReview(ctx, input, deps, type, reviewer, inputs, actor, ownerProcess);
    const decision = admission.decision;
    if (decision.integrationRequired && type !== 'integration') {
      integrationRequired = true;
      if (!requested.includes('integration') && !queue.includes('integration')) queue.push('integration');
    }
    if (admission.kind === 'ready') {
      outcomes.push({
        reviewType: type,
        decision: 'reuse',
        reasons: decision.reasons,
        reviewerInvoked: false,
        review: admission.review,
        error: null,
      });
      continue;
    }
    if (admission.kind === 'joined') {
      try {
        const sourceReview = await awaitReviewAttempt(ctx, admission.attemptId, actor);
        if (sourceReview === null) {
          queue.unshift(type);
          continue;
        }
        const completedContext = await resolveContext(input, paths, deps.context, source);
        const completed = nowIso(ctx.clock);
        const joined = ctx.store.immediate((db) => {
          const request = one<{ status: string; attempt_id: string; fingerprint: string }>(
            db,
            'SELECT status, attempt_id, fingerprint FROM review_requests WHERE review_id = ?',
            admission.id,
          );
          if (
            request?.status !== 'waiting' ||
            request.attempt_id !== admission.attemptId ||
            request.fingerprint !== evidenceFingerprint(inputs)
          )
            throw new CrewError('CONFLICT', 'Review attachment no longer belongs to this request');
          if (getReview(ctx, admission.id).status !== 'pending')
            throw new CrewError('CONFLICT', 'Review attachment was invalidated');
          const current = getReview(ctx, sourceReview.id);
          const valid =
            current.fingerprint === evidenceFingerprint(inputs) &&
            current.expiresAt !== null &&
            current.expiresAt > completed &&
            inputs.policyVersion === reviewPolicyVersion(deps.config) &&
            fingerprint(completedContext) === fingerprint(context) &&
            (current.confidence ?? 0) >= (deps.minConfidence ?? 0.5);
          const status = current.status === 'failed' ? 'failed' : valid ? current.status : 'invalidated';
          insertFindings(
            db,
            admission.id,
            reviewer.identity,
            input.commitSha,
            carriedFindings(current, null),
            completed,
          );
          db.query(
            'UPDATE review_artifacts SET status = ?, confidence = ?, expires_at = ?, completed_at = ?, invalidated_reason = ? WHERE id = ?',
          ).run(
            status,
            current.confidence,
            current.expiresAt,
            completed,
            valid ? null : 'joined_evidence_no_longer_valid',
            admission.id,
          );
          db.query('UPDATE review_requests SET status = ?, completed_at = ? WHERE review_id = ?').run(
            status === 'failed' ? 'failed' : 'completed',
            completed,
            admission.id,
          );
          recordTransition(
            db,
            {
              type: status === 'invalidated' ? 'review.invalidated' : 'review.attached',
              actor,
              taskId: input.taskId ?? null,
              prId: input.prId ?? null,
              payload: {
                reviewId: admission.id,
                reviewType: type,
                attemptId: admission.attemptId,
                sourceReviewId: current.id,
                status,
              },
            },
            { action: 'review.attach', input: { reviewId: admission.id }, decision: status },
            completed,
          );
          return getReview(ctx, admission.id);
        });
        outcomes.push({
          reviewType: type,
          decision: decision.decision,
          reasons: decision.reasons,
          reviewerInvoked: false,
          review: joined,
          error: joined.status === 'failed' ? 'Shared review execution failed' : null,
        });
      } catch (cause) {
        const review = ctx.store.immediate((db) => abandonReviewAttachment(db, admission.id, actor, nowIso(ctx.clock)));
        outcomes.push({
          reviewType: type,
          decision: decision.decision,
          reasons: decision.reasons,
          reviewerInvoked: false,
          review,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      continue;
    }
    const { id, claim, expiresAt } = admission;
    const scope = decision.decision;
    let renewalError: unknown = null;
    const heartbeat = setInterval(() => {
      try {
        ctx.store.immediate((db) => renewExecutionClaim(db, claim, REVIEW_CLAIM_TTL_SECONDS, nowIso(ctx.clock)));
      } catch (cause) {
        renewalError = cause;
        clearInterval(heartbeat);
      }
    }, 10_000);
    heartbeat.unref();
    let error: string | null = null;
    let review: ReviewArtifact | null = null;
    try {
      const result = await reviewer.review({
        reviewType: type,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        baseSha: input.baseSha,
        patch: input.patch,
        files,
        scope: scope === 'incremental' ? 'incremental' : 'full',
        focusPaths: scope === 'incremental' ? decision.changedPaths : [],
        securityClasses: classification.classes,
        context,
        reasons: decision.reasons,
      });
      if (renewalError !== null) throw renewalError;
      const completedContext = await resolveContext(input, paths, deps.context, source);
      const contextChanged = fingerprint(completedContext) !== fingerprint(context);
      const done = nowIso(ctx.clock);
      review = ctx.store.immediate((db) => {
        assertExecutionClaim(db, claim, done);
        if (getReview(ctx, id).status !== 'running')
          throw new CrewError('CONFLICT', 'Review execution was invalidated');
        insertFindings(db, id, reviewer.identity, input.commitSha, result.findings, done);
        if (scope === 'incremental' && decision.incrementalFrom) {
          const prior = mapReview(
            db,
            one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', decision.incrementalFrom)!,
          );
          const unchanged = new Set(Object.keys(inputs.fileHashes).filter((p) => !decision.changedPaths.includes(p)));
          insertFindings(db, id, reviewer.identity, input.commitSha, carriedFindings(prior, unchanged), done);
        }
        const stale = contextChanged || done >= expiresAt || inputs.policyVersion !== reviewPolicyVersion(deps.config);
        const status = stale ? 'invalidated' : statusFromFindings(db, id);
        db.query(
          'UPDATE review_artifacts SET status = ?, confidence = ?, completed_at = ?, invalidated_reason = ? WHERE id = ?',
        ).run(
          status,
          Math.min(1, Math.max(0, result.confidence)),
          done,
          stale ? 'evidence_expired_or_inputs_changed' : null,
          id,
        );
        recordTransition(
          db,
          {
            type: stale ? 'review.invalidated' : 'review.completed',
            actor,
            taskId: input.taskId ?? null,
            prId: input.prId ?? null,
            payload: { reviewId: id, reviewType: type, status, findings: result.findings.length },
          },
          { action: 'review.complete', input: { reviewId: id }, decision: status },
          done,
        );
        db.query("UPDATE review_attempts SET status = 'completed', completed_at = ? WHERE id = ?").run(
          done,
          claim.attemptId,
        );
        db.query("UPDATE review_requests SET status = 'completed', completed_at = ? WHERE review_id = ?").run(done, id);
        releaseExecutionClaim(db, claim, done);
        return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!);
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      const done = nowIso(ctx.clock);
      review = ctx.store.immediate((db) => {
        const currentClaim = getExecutionClaim(db, claim.scope);
        if (
          !currentClaim ||
          currentClaim.attemptId !== claim.attemptId ||
          currentClaim.releasedAt !== null ||
          currentClaim.expiresAt <= done
        )
          return getReview(ctx, id);
        assertExecutionClaim(db, claim, done);
        db.query(
          `UPDATE review_artifacts SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'running'`,
        ).run(done, id);
        recordTransition(
          db,
          {
            type: 'review.failed',
            actor,
            taskId: input.taskId ?? null,
            prId: input.prId ?? null,
            payload: { reviewId: id, reviewType: type, error },
          },
          { action: 'review.complete', input: { reviewId: id }, decision: 'failed' },
          done,
        );
        db.query("UPDATE review_attempts SET status = 'failed', completed_at = ? WHERE id = ?").run(
          done,
          claim.attemptId,
        );
        db.query("UPDATE review_requests SET status = 'failed', completed_at = ? WHERE review_id = ?").run(done, id);
        releaseExecutionClaim(db, claim, done);
        return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!);
      });
    } finally {
      clearInterval(heartbeat);
    }
    outcomes.push({
      reviewType: type,
      decision: scope,
      reasons: decision.reasons,
      reviewerInvoked: true,
      review,
      error,
    });
  }
  return { risk: classification.risk, securityClasses: classification.classes, integrationRequired, outcomes };
}

export function getReview(ctx: CrewContext, id: string): ReviewArtifact {
  const row = one<ReviewRow>(ctx.store.db, 'SELECT * FROM review_artifacts WHERE id = ?', id);
  if (!row) throw new CrewError('NOT_FOUND', `Review not found: ${id}`);
  return mapReview(ctx.store.db, row);
}

export interface ReviewQuery {
  repositoryId?: string;
  prId?: string;
  taskId?: string;
  commitSha?: string;
  reviewType?: ReviewType;
  includeInvalidated?: boolean;
  limit?: number;
}

export function listReviews(ctx: CrewContext, query: ReviewQuery = {}): ReviewArtifact[] {
  return listReviewsInTx(ctx.store.db, query);
}

export function listReviewsInTx(db: Database, query: ReviewQuery = {}): ReviewArtifact[] {
  const where: string[] = [];
  const params: string[] = [];
  for (const [col, value] of [
    ['repository_id', query.repositoryId],
    ['pr_id', query.prId],
    ['task_id', query.taskId],
    ['commit_sha', query.commitSha],
    ['review_type', query.reviewType],
  ] as const) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  if (!query.includeInvalidated) where.push(`status <> 'invalidated'`);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  return all<ReviewRow>(
    db,
    `SELECT * FROM review_artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    ...params,
  ).map((r) => mapReview(db, r));
}

export interface ReviewSummary {
  commitSha: string;
  byType: Record<ReviewType, { reviewId: string; status: ReviewStatus; reused: boolean } | null>;
  blockingFindings: number;
}

export function reviewSummary(
  db: Database,
  prId: string,
  commitSha: string,
  policy: ReviewAcceptancePolicy,
): ReviewSummary {
  const byType = Object.fromEntries(REVIEW_TYPES.map((t) => [t, null])) as ReviewSummary['byType'];
  let blockingFindings = 0;
  for (const type of REVIEW_TYPES) {
    const row = one<ReviewRow>(
      db,
      `SELECT * FROM review_artifacts WHERE pr_id = ? AND commit_sha = ? AND review_type = ? AND status <> 'invalidated'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      prId,
      commitSha,
      type,
    );
    if (!row) continue;
    const artifact = mapReview(db, row);
    const invalid =
      row.status === 'running' || row.status === 'pending' || row.status === 'failed'
        ? null
        : reviewEvidenceValidity(artifact, policy);
    byType[type] = {
      reviewId: row.id,
      status: invalid ? 'invalidated' : row.status,
      reused: row.reused_from !== null && row.scope === 'reused',
    };
    blockingFindings += one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM review_findings WHERE review_id = ? AND status IN ('open', 'accepted') AND severity IN (${BLOCKING_SEVERITIES.map(() => '?').join(',')})`,
      row.id,
      ...BLOCKING_SEVERITIES,
    )!.n;
  }
  return { commitSha, byType, blockingFindings };
}

export function invalidateUnusableReviewEvidenceInTx(
  db: Database,
  prId: string,
  commitSha: string,
  policy: ReviewAcceptancePolicy,
  actor: Actor,
): string[] {
  const rows = all<ReviewRow>(
    db,
    "SELECT * FROM review_artifacts WHERE pr_id = ? AND commit_sha = ? AND status IN ('passed', 'changes_requested')",
    prId,
    commitSha,
  );
  const invalidated: string[] = [];
  for (const row of rows) {
    const reason = reviewEvidenceValidity(mapReview(db, row), policy);
    if (reason === null) continue;
    db.query("UPDATE review_artifacts SET status = 'invalidated', invalidated_reason = ? WHERE id = ?").run(
      reason,
      row.id,
    );
    recordTransition(
      db,
      { type: 'review.invalidated', actor, prId, taskId: row.task_id, payload: { reviewIds: [row.id], reason } },
      { action: 'review.invalidate', input: { reviewId: row.id, reason }, decision: 'invalidated' },
      policy.at,
    );
    invalidated.push(row.id);
  }
  return invalidated;
}

export interface InvalidateReviewsInput {
  prId?: string;
  taskId?: string;
  repositoryId?: string;
  reviewTypes?: ReviewType[];
  exceptCommitSha?: string;
  reason: string;
}

export function invalidateReviewsInTx(db: Database, input: InvalidateReviewsInput, actor: Actor, at: string): string[] {
  const where: string[] = [`status NOT IN ('invalidated', 'failed')`];
  const params: string[] = [];
  if (input.prId) {
    where.push('pr_id = ?');
    params.push(input.prId);
  }
  if (input.taskId) {
    where.push('task_id = ?');
    params.push(input.taskId);
  }
  if (input.repositoryId) {
    where.push('repository_id = ?');
    params.push(input.repositoryId);
  }
  if (input.exceptCommitSha) {
    where.push('commit_sha <> ?');
    params.push(input.exceptCommitSha);
  }
  if (input.reviewTypes && input.reviewTypes.length > 0) {
    where.push(`review_type IN (${input.reviewTypes.map(() => '?').join(',')})`);
    params.push(...input.reviewTypes);
  }
  if (!input.prId && !input.taskId && !input.repositoryId) {
    throw new CrewError('INVALID_INPUT', 'Invalidation requires a pr, task or repository scope');
  }
  const ids = all<{ id: string }>(db, `SELECT id FROM review_artifacts WHERE ${where.join(' AND ')}`, ...params).map(
    (r) => r.id,
  );
  if (ids.length === 0) return ids;
  const placeholders = ids.map(() => '?').join(',');
  db.query(
    `UPDATE review_artifacts SET status = 'invalidated', invalidated_reason = ? WHERE id IN (${placeholders})`,
  ).run(input.reason, ...ids);
  recordTransition(
    db,
    {
      type: 'review.invalidated',
      actor,
      prId: input.prId ?? null,
      taskId: input.taskId ?? null,
      payload: { reviewIds: ids, reason: input.reason },
    },
    { action: 'review.invalidate', input, decision: 'invalidated' },
    at,
  );
  return ids;
}

export function invalidateReviews(
  ctx: CrewContext,
  input: InvalidateReviewsInput,
  actor: Actor = SYSTEM_ACTOR,
): string[] {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => invalidateReviewsInTx(db, input, actor, at));
}

export function failOrphanedReviews(ctx: CrewContext, actor: Actor = SYSTEM_ACTOR): string[] {
  const at = nowIso(ctx.clock);
  const deadAttempts = new Set<string>();
  for (const attempt of all<ReviewAttemptRow>(ctx.store.db, "SELECT * FROM review_attempts WHERE status = 'running'")) {
    const claim = getExecutionClaim(ctx.store.db, `review:${attempt.fingerprint}:${attempt.mode}`);
    if (
      claim?.attemptId === attempt.id &&
      claim.process?.host === hostname() &&
      (!isProcessAlive(claim.process.pid) ||
        matchesRecordedProcess(claim.process.pid, claim.process.startIdentity) === false)
    )
      deadAttempts.add(attempt.id);
  }
  const abandonedRequests = all<{
    review_id: string;
    process_host: string;
    process_pid: number;
    process_start_identity: string;
  }>(
    ctx.store.db,
    "SELECT q.review_id, q.process_host, q.process_pid, q.process_start_identity FROM review_requests q JOIN review_artifacts r ON r.id = q.review_id WHERE q.status = 'waiting' AND r.scope = 'joined' AND r.status = 'pending'",
  ).filter(
    (request) =>
      request.process_host === hostname() &&
      (!isProcessAlive(request.process_pid) ||
        matchesRecordedProcess(request.process_pid, request.process_start_identity) === false),
  );
  return ctx.store.immediate((db) => {
    const failed: string[] = [];
    const attempts = all<ReviewAttemptRow>(db, "SELECT * FROM review_attempts WHERE status = 'running'");
    for (const attempt of attempts) {
      const claim = getExecutionClaim(db, `review:${attempt.fingerprint}:${attempt.mode}`);
      if (claim?.attemptId === attempt.id && claim.releasedAt === null) {
        if (claim.expiresAt > at) {
          if (!deadAttempts.has(attempt.id)) continue;
          releaseExecutionClaim(db, claim, at);
        } else abandonExecutionClaim(db, claim, at);
      }
      const ids = all<{ review_id: string }>(
        db,
        "SELECT review_id FROM review_requests WHERE attempt_id = ? AND status = 'waiting'",
        attempt.id,
      );
      interruptReviewAttempt(db, attempt, at, actor);
      failed.push(...ids.map((row) => row.review_id));
    }
    for (const request of abandonedRequests) {
      const current = one<{ status: string }>(
        db,
        'SELECT status FROM review_requests WHERE review_id = ?',
        request.review_id,
      );
      if (current?.status !== 'waiting') continue;
      abandonReviewAttachment(db, request.review_id, actor, at);
      failed.push(request.review_id);
    }
    const legacy = all<Pick<ReviewRow, 'id' | 'review_type' | 'pr_id' | 'task_id'>>(
      db,
      "SELECT id, review_type, pr_id, task_id FROM review_artifacts WHERE status IN ('pending', 'running') AND id NOT IN (SELECT review_id FROM review_requests)",
    );
    for (const row of legacy) {
      db.query(
        "UPDATE review_artifacts SET status = 'failed', completed_at = ?, invalidated_reason = 'unsupported_execution' WHERE id = ?",
      ).run(at, row.id);
      recordTransition(
        db,
        {
          type: 'review.failed',
          actor,
          taskId: row.task_id,
          prId: row.pr_id,
          payload: { reviewId: row.id, reviewType: row.review_type, error: 'interrupted legacy execution' },
        },
        { action: 'review.complete', input: { reviewId: row.id }, decision: 'failed' },
        at,
      );
      failed.push(row.id);
    }
    return failed;
  });
}

export function listFindings(
  ctx: CrewContext,
  query: { prId?: string; reviewId?: string; status?: FindingStatus },
): Finding[] {
  const where: string[] = [];
  const params: string[] = [];
  if (query.reviewId) {
    where.push('f.review_id = ?');
    params.push(query.reviewId);
  }
  if (query.prId) {
    where.push(`r.pr_id = ? AND r.status <> 'invalidated'`);
    params.push(query.prId);
  }
  if (query.status) {
    where.push('f.status = ?');
    params.push(query.status);
  }
  const rows = all<FindingRow>(
    ctx.store.db,
    `SELECT f.* FROM review_findings f JOIN review_artifacts r ON r.id = f.review_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY f.created_at DESC, f.id DESC LIMIT 1000`,
    ...params,
  );
  const latest = new Map<string, FindingRow>();
  for (const row of rows) if (!latest.has(row.signature)) latest.set(row.signature, row);
  return [...latest.values()].map(mapFinding);
}

export function updateFindingStatus(
  ctx: CrewContext,
  input: { findingId: string; status: FindingStatus; note?: string },
  actor: Actor,
): Finding {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const row = one<FindingRow & { pr_id: string | null; task_id: string | null }>(
      db,
      'SELECT f.*, r.pr_id, r.task_id FROM review_findings f JOIN review_artifacts r ON r.id = f.review_id WHERE f.id = ?',
      input.findingId,
    );
    if (!row) throw new CrewError('NOT_FOUND', `Finding not found: ${input.findingId}`);
    db.query('UPDATE review_findings SET status = ?, updated_at = ? WHERE id = ?').run(input.status, at, row.id);
    const review = one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', row.review_id)!;
    if (review.status === 'changes_requested' || review.status === 'passed') {
      const next = statusFromFindings(db, review.id);
      if (next !== review.status) {
        db.query('UPDATE review_artifacts SET status = ? WHERE id = ?').run(next, review.id);
      }
    }
    recordTransition(
      db,
      {
        type: 'review.finding_updated',
        actor,
        prId: row.pr_id,
        taskId: row.task_id,
        payload: { findingId: row.id, from: row.status, to: input.status, note: input.note ?? null },
      },
      { action: 'review.finding_status', input, decision: input.status },
      at,
    );
    return mapFinding(one<FindingRow>(db, 'SELECT * FROM review_findings WHERE id = ?', row.id)!);
  });
}
