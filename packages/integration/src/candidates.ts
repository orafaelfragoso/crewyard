import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewConfig } from '@crewyard/config';
import {
  type Actor,
  addSeconds,
  CrewError,
  ensureDir,
  fingerprint,
  git,
  gitText,
  newId,
  nowIso,
  sanitizeEnv,
} from '@crewyard/core';
import type { Repository } from '@crewyard/projects';
import { environmentFingerprint, runValidation, selectValidation, type ValidationRun } from '@crewyard/reviews';
import {
  acquireExecutionClaim,
  assertExecutionClaim,
  type CrewContext,
  getExecutionClaim,
  one,
  recordTransition,
  releaseExecutionClaim,
  renewExecutionClaim,
  toJson,
} from '@crewyard/storage';
import type { PendingHook } from './env.ts';
import { applyEntryFailure } from './failures.ts';
import { candidateById, entryById, pullRequestById, setEntryStatus } from './records.ts';
import type { CandidateStep, IntegrationCandidate, PrefixEvidence, PullRequestRecord, QueueEntry } from './types.ts';

const SYNTH_ENV = {
  GIT_AUTHOR_NAME: 'Crewyard',
  GIT_AUTHOR_EMAIL: 'crew@crewyard.local',
  GIT_COMMITTER_NAME: 'Crewyard',
  GIT_COMMITTER_EMAIL: 'crew@crewyard.local',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00+0000',
};

async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  return (await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true })).exitCode === 0;
}

export async function fetchIntegrationRefs(
  repoPath: string,
  baseBranch: string,
  prs: readonly Pick<PullRequestRecord, 'number' | 'headRef' | 'headSha'>[],
): Promise<string> {
  const namespace = newId('lease');
  const baseRef = `refs/crew/fetch/${namespace}/base`;
  await git(repoPath, [
    'fetch',
    '--no-write-fetch-head',
    '--no-tags',
    '--quiet',
    'origin',
    `+refs/heads/${baseBranch}:${baseRef}`,
  ]);
  for (const pr of prs) {
    if (await hasCommit(repoPath, pr.headSha)) continue;
    const target = `refs/crew/fetch/${namespace}/pr/${pr.number}`;
    const viaPull = await git(
      repoPath,
      ['fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', `+refs/pull/${pr.number}/head:${target}`],
      {
        allowFailure: true,
      },
    );
    if (viaPull.exitCode !== 0 || !(await hasCommit(repoPath, pr.headSha))) {
      await git(
        repoPath,
        ['fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', `+refs/heads/${pr.headRef}:${target}`],
        {
          allowFailure: true,
        },
      );
    }
    if (!(await hasCommit(repoPath, pr.headSha))) {
      await git(repoPath, ['fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', pr.headSha], {
        allowFailure: true,
      });
    }
    if (!(await hasCommit(repoPath, pr.headSha))) {
      throw new CrewError('EXTERNAL_FAILURE', `Head ${pr.headSha} of #${pr.number} is not available locally`, {
        retryable: true,
        details: { number: pr.number, headSha: pr.headSha },
      });
    }
  }
  return gitText(repoPath, ['rev-parse', baseRef]);
}

export type SynthesisResult =
  | { ok: true; treeSha: string; commitSha: string; steps: CandidateStep[] }
  | { ok: false; conflict: { prId: string; number: number; files: string[] }; steps: CandidateStep[] };

export async function synthesizeCandidate(
  repoPath: string,
  baseSha: string,
  steps: readonly CandidateStep[],
): Promise<SynthesisResult> {
  let current = baseSha;
  let tree = await gitText(repoPath, ['rev-parse', `${baseSha}^{tree}`]);
  const out: CandidateStep[] = [];
  for (const step of steps) {
    const result = await git(
      repoPath,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', current, step.headSha],
      { allowFailure: true },
    );
    if (result.exitCode === 1) {
      const files = result.stdout.trim().split('\n').slice(1).filter(Boolean);
      return { ok: false, conflict: { prId: step.prId, number: step.number, files }, steps: out };
    }
    if (result.exitCode !== 0) {
      throw new CrewError('EXTERNAL_FAILURE', `git merge-tree failed: ${result.stderr.trim().slice(0, 300)}`, {
        retryable: false,
      });
    }
    tree = result.stdout.trim().split('\n')[0]!;
    current = await gitText(
      repoPath,
      ['commit-tree', tree, '-p', current, '-p', step.headSha, '-m', `crew candidate: #${step.number}`],
      { env: SYNTH_ENV },
    );
    out.push({ ...step, treeSha: tree, commitSha: current });
  }
  return { ok: true, treeSha: tree, commitSha: current, steps: out };
}

export interface CandidatePlan {
  queueId: string;
  baseSha: string;
  group: { entry: QueueEntry; pr: PullRequestRecord }[];
  rulesFingerprint: string | null;
  policyRevision: number;
}

export function createCandidate(
  ctx: CrewContext,
  plan: CandidatePlan,
  actor: Actor,
  ttlSeconds: number,
): IntegrationCandidate {
  const at = nowIso(ctx.clock);
  const id = newId('cand');
  const steps: CandidateStep[] = plan.group.map(({ entry, pr }) => ({
    entryId: entry.id,
    prId: pr.id,
    number: pr.number,
    headSha: pr.headSha,
    treeSha: null,
    commitSha: null,
    merged: false,
    mergeCommitSha: null,
  }));
  return ctx.store.immediate((db) => {
    db.query(
      `INSERT INTO integration_candidates (id, queue_id, base_sha, entries, policy_revision, rules_fingerprint, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?, ?)`,
    ).run(
      id,
      plan.queueId,
      plan.baseSha,
      toJson(steps),
      plan.policyRevision,
      plan.rulesFingerprint,
      at,
      at,
      addSeconds(at, ttlSeconds),
    );
    for (const step of steps) setEntryStatus(db, step.entryId, 'candidate', at);
    recordTransition(
      db,
      {
        type: 'integration.candidate_created',
        actor,
        payload: {
          candidateId: id,
          queueId: plan.queueId,
          baseSha: plan.baseSha,
          prs: steps.map((s) => ({ prId: s.prId, number: s.number, headSha: s.headSha })),
        },
      },
      { action: 'integration.candidate_create', input: { baseSha: plan.baseSha }, decision: 'building' },
      at,
    );
    return candidateById(db, id)!;
  });
}

export interface ValidateCandidateDeps {
  repository: Repository;
  config: CrewConfig;
  actor: Actor;
  hooks: PendingHook[];
}

export interface CandidateOutcome {
  candidate: IntegrationCandidate;
  validation: ValidationRun | null;
  conflict: { prId: string; number: number; files: string[] } | null;
}

export const CANDIDATE_EVIDENCE_VERSION = 2;

export function candidateConfigFingerprint(config: CrewConfig): string {
  return fingerprint(config);
}

export function candidateEnvironmentFingerprint(config: CrewConfig): string {
  const env = sanitizeEnv(process.env, undefined, {});
  for (const key of config.workspace.env_allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return environmentFingerprint(env);
}

export async function buildAndValidateCandidate(
  ctx: CrewContext,
  candidateId: string,
  deps: ValidateCandidateDeps,
): Promise<CandidateOutcome> {
  const { repository, config, actor } = deps;
  const candidate = candidateById(ctx.store.db, candidateId);
  if (!candidate) throw new CrewError('NOT_FOUND', `Candidate not found: ${candidateId}`);
  if (candidate.status !== 'building' || !candidate.expiresAt) {
    throw new CrewError('INVALID_TRANSITION', `Candidate ${candidateId} is not awaiting validation`);
  }
  const attemptId = newId('lease');
  const claim = ctx.store.immediate((db) =>
    acquireExecutionClaim(
      db,
      {
        scope: `integration:candidate:${candidateId}`,
        attemptId,
        ownerId: ctx.execution?.claim.ownerId ?? attemptId,
        inputIdentity: fingerprint({ candidateId, baseSha: candidate.baseSha, entries: candidate.entries }),
        ttlSeconds: 120,
      },
      nowIso(ctx.clock),
    ),
  );
  if (!claim) throw new CrewError('BUSY', `Candidate ${candidateId} is already being validated`, { retryable: true });
  const renewal = setInterval(() => {
    try {
      ctx.store.immediate((db) => renewExecutionClaim(db, claim, 120, nowIso(ctx.clock)));
    } catch (error) {
      ctx.logger.warn('candidate claim renewal failed', { candidateId, error: String(error) });
    }
  }, 40_000);
  try {
    const configFingerprint = candidateConfigFingerprint(config);
    const envFingerprint = candidateEnvironmentFingerprint(config);
    const synthesis = await synthesizeCandidate(repository.canonicalPath, candidate.baseSha, candidate.entries);
    const at = nowIso(ctx.clock);
    if (!synthesis.ok) {
      const { conflict } = synthesis;
      ctx.store.immediate((db) => {
        assertExecutionClaim(db, claim, nowIso(ctx.clock));
        db.query(
          `UPDATE integration_candidates SET status = 'failed', invalid_reason = ?, updated_at = ? WHERE id = ?`,
        ).run(`merge_conflict:#${conflict.number}`, at, candidateId);
        const failingIndex = candidate.entries.findIndex((e) => e.prId === conflict.prId);
        const contributors = candidate.entries.slice(0, failingIndex + 1);
        for (const step of candidate.entries) {
          if (contributors.length > 1 && contributors.includes(step)) {
            setEntryStatus(db, step.entryId, 'blocked', at, {
              blockers: [
                {
                  code: 'CANDIDATE_INTERACTION_FAILED',
                  source: 'queue',
                  message: 'Candidate merge conflict needs interaction review',
                  details: {
                    candidateId,
                    headSha: step.headSha,
                    contributors: contributors.map((s) => s.prId),
                    files: conflict.files,
                  },
                },
              ],
            });
          } else setEntryStatus(db, step.entryId, 'waiting', at);
        }
        if (contributors.length === 1) {
          const step = contributors[0]!;
          const pr = pullRequestById(db, step.prId)!;
          applyEntryFailure(
            db,
            {
              entry: entryById(db, step.entryId)!,
              pr,
              projectId: repository.projectId,
              failure: {
                fingerprint: fingerprint({ kind: 'merge_conflict', files: conflict.files, base: 'integration' }),
                failureClass: 'merge_conflict',
                evidence: { candidateId, baseSha: candidate.baseSha, files: conflict.files, headSha: pr.headSha },
              },
              maxRetries: config.agents.max_retries_per_failure,
              reason: `Integration conflict with ${candidate.baseSha.slice(0, 12)} in ${conflict.files.join(', ') || 'unknown files'}`,
              actor,
            },
            at,
            deps.hooks,
          );
        }
        recordTransition(
          db,
          {
            type: 'integration.candidate_failed',
            actor,
            payload: { candidateId, conflict, contributors: contributors.map((s) => s.prId) },
          },
          { action: 'integration.candidate_validate', input: { candidateId }, decision: 'merge_conflict' },
          at,
        );
      });
      return { candidate: candidateById(ctx.store.db, candidateId)!, validation: null, conflict };
    }
    ctx.store.immediate((db) => {
      assertExecutionClaim(db, claim, nowIso(ctx.clock));
      db.query(
        `UPDATE integration_candidates SET status = 'validating', entries = ?, tree_sha = ?, commit_sha = ?, updated_at = ? WHERE id = ?`,
      ).run(toJson(synthesis.steps), synthesis.treeSha, synthesis.commitSha, at, candidateId);
      for (const step of synthesis.steps) {
        setEntryStatus(db, step.entryId, 'validating', at);
        const pr = pullRequestById(db, step.prId);
        if (pr?.taskId)
          deps.hooks.push({
            name: 'onValidating',
            event: { taskId: pr.taskId, prId: pr.id, prNumber: pr.number, repositoryId: pr.repositoryId, candidateId },
          });
      }
      recordTransition(
        db,
        { type: 'integration.candidate_validating', actor, payload: { candidateId } },
        { action: 'integration.candidate_validate', input: { candidateId }, decision: 'validating' },
        at,
      );
    });
    const commands = selectValidation(config, 'broad', []);
    const prefixes: PrefixEvidence[] = [];
    let validation: ValidationRun | null = null;
    for (const step of synthesis.steps) {
      if (commands.length > 0) {
        const worktree = join(
          ensureDir(join(ctx.dirs.worktrees, 'candidates')),
          `${candidateId}-${claim.attemptId}-${step.entryId}`,
        );
        try {
          await git(repository.canonicalPath, ['worktree', 'add', '--detach', worktree, step.commitSha!]);
          validation = await runValidation(ctx, {
            repositoryId: repository.id,
            candidateId,
            prId: synthesis.steps.length === 1 ? step.prId : null,
            scope: 'broad',
            cwd: worktree,
            commitSha: step.commitSha!,
            treeSha: step.treeSha!,
            commands,
            envAllowlist: config.workspace.env_allowlist,
            actor,
          });
        } finally {
          await git(repository.canonicalPath, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
          rmSync(worktree, { recursive: true, force: true });
        }
      }
      const pr = pullRequestById(ctx.store.db, step.prId)!;
      const required = pr.governance?.requirements?.requiredChecks ?? [];
      const headTree = await gitText(repository.canonicalPath, ['rev-parse', `${step.headSha}^{tree}`]);
      const exact =
        headTree === step.treeSha &&
        required.length > 0 &&
        required.every((r) => pr.checks.some((c) => c.name === r.context && c.state === 'success'));
      const status = validation?.status ?? 'not_configured';
      if (status === 'pending' || status === 'running')
        throw new CrewError('INVALID_TRANSITION', 'Validation did not finish');
      prefixes.push({
        prId: step.prId,
        headSha: step.headSha,
        treeSha: step.treeSha!,
        commitSha: step.commitSha!,
        validationId: validation?.id ?? null,
        status,
        envFingerprint: validation?.envFingerprint ?? envFingerprint,
        configFingerprint,
        policyRevision: candidate.policyRevision,
        expiresAt: candidate.expiresAt,
        attestation:
          validation?.status === 'passed' ? 'local-prefix' : exact ? 'exact-head-checks' : 'guarded-unverified',
      });
      if (validation && validation.status !== 'passed') break;
    }
    const done = nowIso(ctx.clock);
    ctx.store.immediate((db) => {
      assertExecutionClaim(db, claim, nowIso(ctx.clock));
      const current = candidateById(db, candidateId)!;
      const policyRevision = one<{ policy_revision: number }>(
        db,
        'SELECT policy_revision FROM projects WHERE id = ?',
        repository.projectId,
      )!.policy_revision;
      const authoritative =
        current.status === 'validating' &&
        current.policyRevision === policyRevision &&
        candidateConfigFingerprint(config) === configFingerprint &&
        Date.parse(candidate.expiresAt!) > Date.parse(done);
      const passed =
        prefixes.length === synthesis.steps.length &&
        prefixes.every((p) => p.status === 'passed' || p.status === 'not_configured');
      const evidence = {
        version: CANDIDATE_EVIDENCE_VERSION,
        attemptId: claim.attemptId,
        generation: claim.generation,
        prefixes,
        attestation: prefixes.every((p) => p.attestation !== 'guarded-unverified')
          ? 'prefix-validated'
          : 'guarded-unverified',
        failingPrefix: passed ? null : prefixes.length,
        contributors: passed ? [] : synthesis.steps.slice(0, prefixes.length).map((s) => s.prId),
      };
      db.query(
        `UPDATE integration_candidates SET status = ?, ci_evidence = ?, integration_validated = ?, invalid_reason = ?, updated_at = ? WHERE id = ?`,
      ).run(
        !authoritative ? 'invalid' : passed ? 'valid' : 'failed',
        toJson(evidence),
        authoritative && passed && prefixes.every((prefix) => prefix.attestation === 'exact-head-checks') ? 1 : 0,
        !authoritative ? 'authority_changed_during_validation' : passed ? null : `validation_${validation?.status}`,
        done,
        candidateId,
      );
      recordTransition(
        db,
        {
          type: authoritative && passed ? 'integration.candidate_validated' : 'integration.candidate_failed',
          actor,
          payload: { candidateId, treeSha: synthesis.treeSha, commitSha: synthesis.commitSha, evidence },
        },
        {
          action: 'integration.candidate_validate',
          input: { candidateId },
          decision: !authoritative ? 'invalid' : passed ? 'valid' : 'failed',
        },
        done,
      );
      if (!authoritative) {
        for (const step of synthesis.steps)
          setEntryStatus(db, step.entryId, 'waiting', done, { validatedBase: null, validatedHead: null });
        return;
      }
      if (passed) {
        for (const step of synthesis.steps)
          setEntryStatus(db, step.entryId, 'validating', done, {
            validatedBase: candidate.baseSha,
            validatedHead: step.headSha,
          });
        return;
      }
      const contributors = synthesis.steps.slice(0, prefixes.length);
      for (const step of synthesis.steps) {
        if (contributors.length > 1 && contributors.includes(step)) {
          setEntryStatus(db, step.entryId, 'blocked', done, {
            blockers: [
              {
                code: 'CANDIDATE_INTERACTION_FAILED',
                source: 'queue',
                message: 'A cumulative prefix failed; individual responsibility is unknown',
                details: {
                  candidateId,
                  headSha: step.headSha,
                  contributors: evidence.contributors,
                  failingPrefix: prefixes.length,
                },
              },
            ],
            validatedBase: null,
            validatedHead: null,
          });
        } else setEntryStatus(db, step.entryId, 'waiting', done);
      }
      if (contributors.length === 1) {
        const failing = contributors[0]!;
        applyEntryFailure(
          db,
          {
            entry: entryById(db, failing.entryId)!,
            pr: pullRequestById(db, failing.prId)!,
            projectId: repository.projectId,
            failure: {
              fingerprint: validation?.failureFingerprint ?? fingerprint({ candidateId, kind: 'validation' }),
              failureClass: validation?.failureClass ?? 'unknown',
              evidence: { candidateId, validationId: validation?.id ?? null, outputRef: validation?.outputRef ?? null },
            },
            maxRetries: config.agents.max_retries_per_failure,
            reason: `Broad validation ${validation?.status} for candidate ${candidateId}`,
            actor,
          },
          done,
          deps.hooks,
        );
      }
    });
    return { candidate: candidateById(ctx.store.db, candidateId)!, validation, conflict: null };
  } finally {
    clearInterval(renewal);
    ctx.store.immediate((db) => {
      const current = getExecutionClaim(db, claim.scope);
      const at = nowIso(ctx.clock);
      if (current?.attemptId === claim.attemptId && current.releasedAt === null && current.expiresAt > at)
        releaseExecutionClaim(db, claim, at);
    });
  }
}
