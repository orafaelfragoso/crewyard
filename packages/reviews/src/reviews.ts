import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, addSeconds, CrewError, fingerprint, newId, nowIso, type Risk, SYSTEM_ACTOR } from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition, toJson } from '@crewyard/storage';
import { type CacheCandidate, type CacheDecisionResult, decideReviewCache, evidenceFingerprint } from './cache.ts';
import { classifyPaths } from './classify.ts';
import { normalizePatch, parseUnifiedDiff } from './patch.ts';
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
): Promise<{ context: ReviewContext; error: string | null }> {
  if (!provider) {
    return {
      context: {
        dependencyFingerprint: `base:${input.baseSha}`,
        interfaceFingerprint: null,
        symbolGraphRevision: null,
      },
      error: null,
    };
  }
  try {
    const [dependencyFingerprint, interfaceFingerprint, symbolGraphRevision] = await Promise.all([
      provider.relatedDependencyFingerprint(input.repositoryId, input.commitSha, paths),
      provider.interfaceFingerprint(input.repositoryId, input.commitSha, paths),
      provider.symbolGraphRevision(input.repositoryId, input.commitSha),
    ]);
    return { context: { dependencyFingerprint, interfaceFingerprint, symbolGraphRevision }, error: null };
  } catch (error) {
    return {
      context: { dependencyFingerprint: null, interfaceFingerprint: null, symbolGraphRevision: null },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function candidate(row: ReviewRow | null, at: string): CacheCandidate | null {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    inputs: parseJson(row.fingerprint_inputs, {} as EvidenceInputs),
    confidence: row.confidence,
    expired: row.expires_at !== null && row.expires_at <= at,
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
    .filter((f) => keepPaths === null || (f.path !== null && keepPaths.has(f.path)) || f.path === null)
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

function statusFromFindings(db: Database, reviewId: string, verdict: string | undefined): ReviewStatus {
  const blocking = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM review_findings WHERE review_id = ? AND status IN ('open', 'accepted') AND severity IN (${BLOCKING_SEVERITIES.map(() => '?').join(',')})`,
    reviewId,
    ...BLOCKING_SEVERITIES,
  )!.n;
  return blocking > 0 || verdict === 'changes_requested' ? 'changes_requested' : 'passed';
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
    values.status === 'running' ? null : values.at,
  );
}

export async function requestReview(
  ctx: CrewContext,
  input: RequestReviewInput,
  deps: ReviewDeps,
): Promise<RequestReviewResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const files = parseUnifiedDiff(input.patch);
  const normalized = normalizePatch(input.patch);
  const paths = normalized.files.map((f) => f.path);
  const additions = files.reduce((n, f) => n + f.lines.filter((l) => l.kind === 'add').length, 0);
  const deletions = files.reduce((n, f) => n + f.lines.filter((l) => l.kind === 'del').length, 0);
  const classification = classifyPaths(deps.config.security, paths, { files: paths.length, additions, deletions });
  const { context, error: contextError } = await resolveContext(input, paths, deps.context);
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
      repositoryId: input.repositoryId,
      reviewType: type,
      patchHash: normalized.patchHash,
      fileHashes: Object.fromEntries(normalized.files.map((f) => [f.path, f.hash])),
      policyVersion: deps.config.review.policy_version,
      reviewerIdentity: reviewer.identity,
      reviewerModel: reviewer.model,
      promptVersion: reviewer.promptVersion,
      dependencyContext: context.dependencyFingerprint,
      interfaceContext: context.interfaceFingerprint,
      symbolGraphRevision: context.symbolGraphRevision,
      securityClasses: classification.classes,
    };
    const fp = evidenceFingerprint(inputs);
    const at = nowIso(ctx.clock);
    const exactRow = one<ReviewRow>(
      ctx.store.db,
      `SELECT * FROM review_artifacts WHERE review_type = ? AND fingerprint = ? AND status IN ('passed', 'changes_requested')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      type,
      fp,
    );
    const priorRow = priorFor(ctx.store.db, input, type);
    const forbidReuse =
      input.force === true ||
      contextError !== null ||
      (type === 'security' && classification.classes.length > 0 && deps.config.review.require_review_for_high_risk);
    const decision: CacheDecisionResult = decideReviewCache({
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
    if (contextError) decision.reasons.push('context_unavailable');
    if (input.force) decision.reasons.push('forced');
    if (decision.integrationRequired && type !== 'integration') {
      integrationRequired = true;
      if (!requested.includes('integration') && !queue.includes('integration')) queue.push('integration');
    }
    const expiresAt = addSeconds(at, deps.config.review.cache_ttl_hours * 3600);

    if (decision.decision === 'reuse' && decision.reuseFrom) {
      const id = newId('rev');
      const review = ctx.store.immediate((db) => {
        const source = mapReview(
          db,
          one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', decision.reuseFrom)!,
        );
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
          expiresAt: source.expiresAt ?? expiresAt,
          at,
        });
        insertFindings(db, id, reviewer.identity, input.commitSha, carriedFindings(source, null), at);
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
        return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!);
      });
      outcomes.push({
        reviewType: type,
        decision: 'reuse',
        reasons: decision.reasons,
        reviewerInvoked: false,
        review,
        error: null,
      });
      continue;
    }

    const id = newId('rev');
    const scope = decision.decision;
    ctx.store.immediate((db) => {
      insertArtifact(db, {
        id,
        input,
        type,
        fp,
        inputs,
        status: 'running',
        reviewer,
        scope,
        confidence: null,
        llmInvoked: reviewer.model !== null,
        reusedFrom: decision.incrementalFrom,
        expiresAt,
        at,
      });
      recordTransition(
        db,
        {
          type: 'review.started',
          actor,
          taskId: input.taskId ?? null,
          prId: input.prId ?? null,
          payload: { reviewId: id, reviewType: type, scope, reasons: decision.reasons, commitSha: input.commitSha },
        },
        { action: 'review.request', input: { fingerprint: fp, scope }, decision: scope },
        at,
      );
    });
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
      const done = nowIso(ctx.clock);
      review = ctx.store.immediate((db) => {
        insertFindings(db, id, reviewer.identity, input.commitSha, result.findings, done);
        if (scope === 'incremental' && decision.incrementalFrom) {
          const prior = mapReview(
            db,
            one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', decision.incrementalFrom)!,
          );
          const unchanged = new Set(Object.keys(inputs.fileHashes).filter((p) => !decision.changedPaths.includes(p)));
          insertFindings(db, id, reviewer.identity, input.commitSha, carriedFindings(prior, unchanged), done);
        }
        const status = statusFromFindings(db, id, result.verdict);
        db.query('UPDATE review_artifacts SET status = ?, confidence = ?, completed_at = ? WHERE id = ?').run(
          status,
          Math.min(1, Math.max(0, result.confidence)),
          done,
          id,
        );
        recordTransition(
          db,
          {
            type: 'review.completed',
            actor,
            taskId: input.taskId ?? null,
            prId: input.prId ?? null,
            payload: { reviewId: id, reviewType: type, status, findings: result.findings.length },
          },
          { action: 'review.complete', input: { reviewId: id }, decision: status },
          done,
        );
        return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!);
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      const done = nowIso(ctx.clock);
      review = ctx.store.immediate((db) => {
        db.query(`UPDATE review_artifacts SET status = 'failed', completed_at = ? WHERE id = ?`).run(done, id);
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
        return mapReview(db, one<ReviewRow>(db, 'SELECT * FROM review_artifacts WHERE id = ?', id)!);
      });
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

export function reviewSummary(db: Database, prId: string, commitSha: string): ReviewSummary {
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
    byType[type] = { reviewId: row.id, status: row.status, reused: row.reused_from !== null && row.scope === 'reused' };
    blockingFindings += one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM review_findings WHERE review_id = ? AND status IN ('open', 'accepted') AND severity IN ('high', 'critical')`,
      row.id,
    )!.n;
  }
  return { commitSha, byType, blockingFindings };
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
      const next = statusFromFindings(db, review.id, undefined);
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
