import { type Actor, CrewError, fingerprint, nowIso } from '@crewyard/core';
import type { BranchRequirements, CheckResult } from '@crewyard/github';
import { clientFor, configFor, type IntegrationEnv, pullRequestById } from '@crewyard/integration';
import { getRepository } from '@crewyard/projects';
import { all, type CrewContext, one, recordTransition } from '@crewyard/storage';
import { insertTaskInTx } from '@crewyard/tasks';

export type MergeHealth = 'unknown' | 'pending' | 'passed' | 'failed' | 'superseded';

export interface MergeHealthObservation {
  repositoryId: string;
  mergeCommitSha: string;
  baseBranch: string;
  currentBaseSha: string;
  requirements: BranchRequirements | null;
  checks: readonly CheckResult[];
  actor: Actor;
}

export interface MergeHealthResult {
  incidentId: string;
  state: MergeHealth;
  failingChecks: string[];
  repairTaskId: string | null;
  changed: boolean;
}

export function mergeHealthState(observation: MergeHealthObservation): MergeHealth {
  if (observation.checks.some((check) => check.headSha !== observation.mergeCommitSha)) {
    throw new CrewError('INVALID_INPUT', 'Post-merge checks must refer to the observed merge commit');
  }
  if (observation.currentBaseSha !== observation.mergeCommitSha) return 'superseded';
  if (!observation.requirements?.protectionVisible) return 'unknown';
  const required = observation.requirements?.requiredChecks;
  if (!required || required.length === 0) return 'unknown';
  const checks = required.map((requirement) =>
    observation.checks.find(
      (check) =>
        check.name === requirement.context && (requirement.appId === null || requirement.appId === check.appId),
    ),
  );
  if (checks.some((check) => check?.state === 'failure')) return 'failed';
  if (checks.some((check) => !check)) return 'unknown';
  if (checks.some((check) => check?.state === 'pending')) return 'pending';
  return checks.every((check) => check?.state === 'success') ? 'passed' : 'unknown';
}

export function recordMergeHealth(
  ctx: CrewContext,
  observation: MergeHealthObservation,
  env: IntegrationEnv,
): MergeHealthResult {
  const repository = getRepository(ctx, observation.repositoryId);
  const config = configFor(ctx, env, repository.projectId);
  const state = mergeHealthState(observation);
  const required = observation.requirements?.requiredChecks ?? [];
  const failingChecks = observation.checks
    .filter(
      (check) =>
        check.state === 'failure' &&
        required.some(
          (requirement) =>
            requirement.context === check.name && (requirement.appId === null || requirement.appId === check.appId),
        ),
    )
    .map((check) => check.name)
    .sort();
  const incidentId = fingerprint({
    repositoryId: repository.id,
    mergeCommitSha: observation.mergeCommitSha,
    baseBranch: observation.baseBranch,
    rules: observation.requirements?.fingerprint ?? null,
  });
  const healthFingerprint = fingerprint({ state, failingChecks });
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const merged = one<{ id: string; number: number }>(
      db,
      `SELECT id, number FROM pull_requests WHERE repository_id = ? AND merge_commit_sha = ? AND base_ref = ? AND state = 'merged' ORDER BY number LIMIT 1`,
      repository.id,
      observation.mergeCommitSha,
      observation.baseBranch,
    );
    if (!merged) throw new CrewError('NOT_FOUND', 'Post-merge health requires an observed merged pull request');
    const prior = one<{ fingerprint: string }>(
      db,
      `SELECT json_extract(payload, '$.healthFingerprint') AS fingerprint FROM events
       WHERE type = 'postmerge.health_observed' AND project_id = ? AND json_extract(payload, '$.incidentId') = ? ORDER BY seq DESC LIMIT 1`,
      repository.projectId,
      incidentId,
    );
    const originRef = `postmerge:${incidentId}`;
    let repairTaskId =
      one<{ id: string }>(
        db,
        'SELECT id FROM tasks WHERE project_id = ? AND origin_ref = ? ORDER BY created_at LIMIT 1',
        repository.projectId,
        originRef,
      )?.id ?? null;
    const changed = prior?.fingerprint !== healthFingerprint;
    if (state === 'failed' && repairTaskId === null && ['guarded', 'autopilot'].includes(config.project.autonomy)) {
      const pr = pullRequestById(db, merged.id)!;
      repairTaskId = insertTaskInTx(
        db,
        {
          projectId: repository.projectId,
          repositoryId: repository.id,
          title: `Investigate failing merge #${merged.number}`,
          objective: `Investigate required checks ${failingChecks.join(', ')} on merge ${observation.mergeCommitSha}. Verify the current base before proposing a repair. Preserve branch protections and submit any repair through the ordinary task workflow.`,
          acceptanceCriteria: [
            'Identify the evidenced cause at the recorded merge and current base',
            'Demonstrate the required checks on the proposed repair',
            'Obtain required approvals before implementation and integration',
          ],
          baseBranch: observation.baseBranch,
          scopeHints: (pr.changedFiles ?? []).map((file) => file.path),
          scopeReason:
            'Post-merge diagnosis starts from the observed change; actual repair scope requires operator review.',
          risk: 'high',
          priority: 100,
          initialState: 'DRAFT',
          origin: 'ai',
          originRef,
          actor: observation.actor,
        },
        config,
        at,
      ).id;
    }
    for (const check of observation.checks) {
      if (!check.execution) continue;
      const durationMs = Date.parse(check.execution.completedAt) - Date.parse(check.execution.startedAt);
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new CrewError('EXTERNAL_FAILURE', 'GitHub returned invalid check execution timestamps');
      const identity = `${repository.id}:${observation.mergeCommitSha}:${check.execution.id}`;
      if (
        one(
          db,
          `SELECT 1 FROM events WHERE type = 'postmerge.check_recorded' AND json_extract(payload, '$.identity') = ? LIMIT 1`,
          identity,
        )
      )
        continue;
      recordTransition(
        db,
        {
          type: 'postmerge.check_recorded',
          actor: observation.actor,
          projectId: repository.projectId,
          prId: merged.id,
          payload: {
            identity,
            repositoryId: repository.id,
            mergeCommitSha: observation.mergeCommitSha,
            checkId: check.execution.id,
            name: check.name,
            startedAt: check.execution.startedAt,
            completedAt: check.execution.completedAt,
            durationMs,
          },
        },
        { action: 'postmerge.check_observe', input: { identity }, decision: 'observed' },
        at,
      );
    }
    if (changed) {
      recordTransition(
        db,
        {
          type: 'postmerge.health_observed',
          actor: observation.actor,
          projectId: repository.projectId,
          prId: merged.id,
          payload: {
            incidentId,
            healthFingerprint,
            repositoryId: repository.id,
            mergeCommitSha: observation.mergeCommitSha,
            currentBaseSha: observation.currentBaseSha,
            state,
            failingChecks,
            repairTaskId,
          },
        },
        { action: 'postmerge.health_observe', input: { incidentId, healthFingerprint }, decision: state },
        at,
      );
      if (state === 'failed')
        recordTransition(
          db,
          {
            type: 'postmerge.intervention_required',
            actor: observation.actor,
            projectId: repository.projectId,
            prId: merged.id,
            taskId: repairTaskId,
            payload: {
              incidentId,
              mergeCommitSha: observation.mergeCommitSha,
              failingChecks,
              repairTaskId,
              action: repairTaskId
                ? 'Review the draft repair task and its scope before approving execution.'
                : 'Inspect the required checks and create an approved repair task.',
            },
          },
          { action: 'postmerge.intervention', input: { incidentId }, decision: 'required' },
          at,
        );
    }
    return { incidentId, state, failingChecks, repairTaskId, changed };
  });
}

export async function scanPostMergeHealth(
  ctx: CrewContext,
  input: { repositoryId: string; actor: Actor; limit: number },
  env: IntegrationEnv,
): Promise<MergeHealthResult[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new CrewError('INVALID_INPUT', 'Post-merge scan limit must be between 1 and 100');
  const repository = getRepository(ctx, input.repositoryId);
  const client = await clientFor(ctx, env, repository);
  const merges = all<{ merge_commit_sha: string; base_ref: string }>(
    ctx.store.db,
    `SELECT merge_commit_sha, base_ref FROM pull_requests WHERE repository_id = ? AND state = 'merged' AND merge_commit_sha IS NOT NULL GROUP BY merge_commit_sha, base_ref ORDER BY MAX(merged_at) DESC LIMIT ?`,
    repository.id,
    input.limit,
  );
  const results: MergeHealthResult[] = [];
  const targets = new Map<string, { sha: string; requirements: BranchRequirements }>();
  for (const merge of merges) {
    let target = targets.get(merge.base_ref);
    if (!target) {
      const branch = await client.getBranch(merge.base_ref);
      target = { sha: branch.sha, requirements: await client.getBranchRequirements(merge.base_ref) };
      targets.set(merge.base_ref, target);
    }
    results.push(
      recordMergeHealth(
        ctx,
        {
          repositoryId: repository.id,
          mergeCommitSha: merge.merge_commit_sha,
          baseBranch: merge.base_ref,
          currentBaseSha: target.sha,
          requirements: target.requirements,
          checks: await client.listChecks(merge.merge_commit_sha),
          actor: input.actor,
        },
        env,
      ),
    );
  }
  return results;
}
