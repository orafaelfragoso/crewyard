import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, addSeconds, CrewError, ensureDir, fingerprint, git, gitText, newId, nowIso } from '@crewyard/core';
import type { Repository } from '@crewyard/projects';
import { runValidation, selectValidation, type ValidationRun } from '@crewyard/reviews';
import { type CrewContext, recordTransition, toJson } from '@crewyard/storage';
import type { PendingHook } from './env.ts';
import { applyEntryFailure } from './failures.ts';
import { candidateById, entryById, pullRequestById, setEntryStatus } from './records.ts';
import type { CandidateStep, IntegrationCandidate, PullRequestRecord, QueueEntry } from './types.ts';

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
  const baseRef = `refs/crew/base/${baseBranch}`;
  await git(repoPath, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${baseBranch}:${baseRef}`]);
  for (const pr of prs) {
    if (await hasCommit(repoPath, pr.headSha)) continue;
    const target = `refs/crew/pr/${pr.number}`;
    const viaPull = await git(
      repoPath,
      ['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${pr.number}/head:${target}`],
      {
        allowFailure: true,
      },
    );
    if (viaPull.exitCode !== 0 || !(await hasCommit(repoPath, pr.headSha))) {
      await git(repoPath, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${pr.headRef}:${target}`], {
        allowFailure: true,
      });
    }
    if (!(await hasCommit(repoPath, pr.headSha))) {
      await git(repoPath, ['fetch', '--no-tags', '--quiet', 'origin', pr.headSha], { allowFailure: true });
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

export async function buildAndValidateCandidate(
  ctx: CrewContext,
  candidateId: string,
  deps: ValidateCandidateDeps,
): Promise<CandidateOutcome> {
  const { repository, config, actor } = deps;
  const candidate = candidateById(ctx.store.db, candidateId);
  if (!candidate) throw new CrewError('NOT_FOUND', `Candidate not found: ${candidateId}`);
  const synthesis = await synthesizeCandidate(repository.canonicalPath, candidate.baseSha, candidate.entries);
  const at = nowIso(ctx.clock);
  if (!synthesis.ok) {
    const { conflict } = synthesis;
    ctx.store.immediate((db) => {
      db.query(
        `UPDATE integration_candidates SET status = 'failed', invalid_reason = ?, updated_at = ? WHERE id = ?`,
      ).run(`merge_conflict:#${conflict.number}`, at, candidateId);
      const step = candidate.entries.find((e) => e.prId === conflict.prId)!;
      const pr = pullRequestById(db, conflict.prId)!;
      for (const other of candidate.entries) {
        if (other.prId !== conflict.prId) setEntryStatus(db, other.entryId, 'waiting', at);
      }
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
    });
    return { candidate: candidateById(ctx.store.db, candidateId)!, validation: null, conflict };
  }
  ctx.store.immediate((db) => {
    db.query(
      `UPDATE integration_candidates SET status = 'validating', entries = ?, tree_sha = ?, commit_sha = ?, updated_at = ? WHERE id = ?`,
    ).run(toJson(synthesis.steps), synthesis.treeSha, synthesis.commitSha, at, candidateId);
    for (const step of synthesis.steps) {
      setEntryStatus(db, step.entryId, 'validating', at);
      const pr = pullRequestById(db, step.prId);
      if (pr?.taskId) {
        deps.hooks.push({
          name: 'onValidating',
          event: { taskId: pr.taskId, prId: pr.id, prNumber: pr.number, repositoryId: pr.repositoryId, candidateId },
        });
      }
    }
  });
  const commands = selectValidation(config, 'broad', []);
  let validation: ValidationRun | null = null;
  if (commands.length > 0) {
    const worktree = join(ensureDir(join(ctx.dirs.worktrees, 'candidates')), candidateId);
    try {
      await git(repository.canonicalPath, ['worktree', 'add', '--detach', '--force', worktree, synthesis.commitSha]);
      validation = await runValidation(ctx, {
        repositoryId: repository.id,
        candidateId,
        prId: synthesis.steps.length === 1 ? synthesis.steps[0]!.prId : null,
        scope: 'broad',
        cwd: worktree,
        commitSha: synthesis.commitSha,
        treeSha: synthesis.treeSha,
        commands,
        envAllowlist: config.workspace.env_allowlist,
        actor,
      });
    } finally {
      await git(repository.canonicalPath, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
      await git(repository.canonicalPath, ['worktree', 'prune'], { allowFailure: true });
    }
  }
  const singleHead = synthesis.steps.length === 1 ? synthesis.steps[0]! : null;
  const headTree = singleHead
    ? await gitText(repository.canonicalPath, ['rev-parse', `${singleHead.headSha}^{tree}`])
    : null;
  const done = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    const prs = synthesis.steps.map((s) => pullRequestById(db, s.prId)!);
    const requiredGreen = prs.every((pr) => {
      const required = pr.governance?.requirements?.requiredChecks ?? [];
      return required.every((r) => pr.checks.some((c) => c.name === r.context && c.state === 'success'));
    });
    const exact = headTree !== null && headTree === synthesis.treeSha && requiredGreen;
    const evidence = {
      attestation: exact ? 'exact' : 'not-yet-integration-validated',
      local: validation
        ? {
            validationId: validation.id,
            status: validation.status,
            commitSha: validation.commitSha,
            treeSha: validation.treeSha,
          }
        : { status: 'not_configured' },
      github: prs.map((pr) => ({ number: pr.number, headSha: pr.headSha, checksState: pr.checksState })),
    };
    const passed = validation === null || validation.status === 'passed';
    db.query(
      `UPDATE integration_candidates SET status = ?, ci_evidence = ?, integration_validated = ?, invalid_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(
      passed ? 'valid' : 'failed',
      toJson(evidence),
      exact ? 1 : 0,
      passed ? null : `validation_${validation?.status}`,
      done,
      candidateId,
    );
    recordTransition(
      db,
      {
        type: passed ? 'integration.candidate_validated' : 'integration.candidate_failed',
        actor,
        payload: { candidateId, treeSha: synthesis.treeSha, commitSha: synthesis.commitSha, evidence },
      },
      { action: 'integration.candidate_validate', input: { candidateId }, decision: passed ? 'valid' : 'failed' },
      done,
    );
    if (passed) {
      for (const step of synthesis.steps) {
        setEntryStatus(db, step.entryId, 'validating', done, {
          validatedBase: candidate.baseSha,
          validatedHead: step.headSha,
        });
      }
      return;
    }
    const blame = synthesis.steps[0]!;
    for (const step of synthesis.steps.slice(1)) setEntryStatus(db, step.entryId, 'waiting', done);
    applyEntryFailure(
      db,
      {
        entry: entryById(db, blame.entryId)!,
        pr: pullRequestById(db, blame.prId)!,
        projectId: repository.projectId,
        failure: {
          fingerprint: validation?.failureFingerprint ?? fingerprint({ candidateId, kind: 'validation' }),
          failureClass: validation?.failureClass ?? 'unknown',
          evidence: { candidateId, validationId: validation?.id ?? null, outputRef: validation?.outputRef ?? null },
        },
        maxRetries: config.agents.max_retries_per_failure,
        reason: `Broad validation ${validation?.status ?? 'failed'} for candidate ${candidateId}`,
        actor,
      },
      done,
      deps.hooks,
    );
  });
  return { candidate: candidateById(ctx.store.db, candidateId)!, validation, conflict: null };
}
