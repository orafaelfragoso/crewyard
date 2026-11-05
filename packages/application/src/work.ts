import { type Actor, CrewError, fingerprint, git, nowIso } from '@crewyard/core';
import { getRepository, loadProjectConfig } from '@crewyard/projects';
import type { CrewContext } from '@crewyard/storage';
import {
  type ClaimResult,
  claimTask,
  type LeaseHolder,
  releaseLease,
  requiresPullRequest,
  showTask,
} from '@crewyard/tasks';
import { type AllocateResult, allocateWorkspace, type Workspace } from '@crewyard/workspaces';
import { DEFAULT_EXECUTION_LIMITS } from './execution.ts';
import { driveExecution } from './execution-driver.ts';
import { impact } from './retrieval.ts';

export interface PreparedClaim {
  taskId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  claimToken: string;
  workspaceId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  reservations: ClaimResult['reservations'];
  advisoryOverlaps: ClaimResult['advisoryOverlaps'];
  impactNote: string | null;
}

export interface WorkspaceLeaseIdentity {
  id: string;
  generation: number;
  holder: LeaseHolder;
}

function assertWorkspaceLease(ctx: CrewContext, taskId: string, expected: WorkspaceLeaseIdentity): void {
  const detail = showTask(ctx, taskId);
  const lease = detail.lease;
  if (
    !lease ||
    lease.id !== expected.id ||
    lease.generation !== expected.generation ||
    detail.task.leaseGeneration !== expected.generation ||
    lease.holder.kind !== expected.holder.kind ||
    lease.holder.id !== expected.holder.id ||
    lease.releasedAt !== null ||
    lease.expiresAt <= nowIso(ctx.clock)
  )
    throw new CrewError('STALE_LEASE', `Workspace allocation lease for ${taskId} is no longer current`);
}

export async function allocateTaskWorkspace(
  ctx: CrewContext,
  input: {
    taskId: string;
    actor: Actor;
    baseRef?: string;
    baseSha?: string;
    expectedLease?: WorkspaceLeaseIdentity;
    configurationFingerprint?: string;
    inProcess?: boolean;
  },
): Promise<AllocateResult> {
  const detail = showTask(ctx, input.taskId);
  if (!detail.task.repositoryId) throw new CrewError('INVALID_INPUT', 'Task has no repository for a workspace');
  const lease = input.expectedLease ?? detail.lease;
  if (!lease) throw new CrewError('STALE_LEASE', 'Claim the task before allocating its workspace');
  const expectedLease: WorkspaceLeaseIdentity = { id: lease.id, generation: lease.generation, holder: lease.holder };
  assertWorkspaceLease(ctx, input.taskId, expectedLease);
  const repository = getRepository(ctx, detail.task.repositoryId);
  const config = loadProjectConfig(ctx, repository.projectId).config;
  const configurationFingerprint = fingerprint(config);
  if (input.configurationFingerprint && input.configurationFingerprint !== configurationFingerprint)
    throw new CrewError('CONFLICT', 'Workspace configuration changed after execution admission');
  const baseRef = input.baseRef ?? detail.task.baseBranch ?? repository.defaultBase;
  let baseSha = input.baseSha;
  if (!baseSha) {
    for (const ref of [`refs/remotes/origin/${baseRef}`, baseRef]) {
      const result = await git(repository.canonicalPath, ['rev-parse', '--verify', `${ref}^{commit}`], {
        allowFailure: true,
      });
      if (result.exitCode === 0) {
        baseSha = result.stdout.trim();
        break;
      }
    }
  }
  if (!baseSha) throw new CrewError('NOT_FOUND', `Workspace base ${baseRef} is unavailable`);
  assertWorkspaceLease(ctx, input.taskId, expectedLease);
  if (!ctx.execution && !input.inProcess) {
    const result = await driveExecution(
      ctx,
      {
        projectId: repository.projectId,
        repositoryId: repository.id,
        actor: input.actor,
        leaderId: input.actor.id,
        operation: {
          kind: 'workspace',
          taskId: input.taskId,
          baseRef,
          baseSha,
          lease: expectedLease,
          configurationFingerprint,
        },
      },
      { ...DEFAULT_EXECUTION_LIMITS },
    );
    assertWorkspaceLease(ctx, input.taskId, expectedLease);
    return result as unknown as AllocateResult;
  }
  const guarded: CrewContext = {
    ...ctx,
    store: {
      ...ctx.store,
      immediate: (fn) =>
        ctx.store.immediate((db) => {
          assertWorkspaceLease(ctx, input.taskId, expectedLease);
          return fn(db);
        }),
      preview: (fn) =>
        ctx.store.preview((db) => {
          assertWorkspaceLease(ctx, input.taskId, expectedLease);
          return fn(db);
        }),
    },
  };
  const result = await allocateWorkspace(guarded, {
    taskId: input.taskId,
    actor: input.actor,
    baseRef,
    baseSha,
    config,
  });
  assertWorkspaceLease(ctx, input.taskId, expectedLease);
  if (!['ready', 'in_use', 'preserved'].includes(result.workspace.state))
    throw new CrewError('CONFLICT', `Workspace ${result.workspace.id} requires reconciliation before reuse`);
  return result;
}

async function impactScopes(
  ctx: CrewContext,
  projectId: string,
  taskId: string,
  hints: string[],
): Promise<{ scopes: string[]; note: string | null }> {
  const paths = hints.filter((h) => !/^[a-z][a-z0-9_-]*:/i.test(h));
  if (paths.length === 0) return { scopes: [], note: null };
  try {
    const report = await impact(ctx, { projectId, paths, excludeTaskId: taskId });
    return {
      scopes: report.modules.filter((m) => m.tier !== 'heuristic').map((m) => m.module),
      note: report.disclaimer,
    };
  } catch (error) {
    if (error instanceof CrewError && error.code === 'INDEX_STALE') return { scopes: [], note: error.message };
    throw error;
  }
}

export async function claimAndPrepare(
  ctx: CrewContext,
  input: { taskId: string; holder: LeaseHolder; actor: Actor; allocateWorkspace?: boolean; inProcess?: boolean },
): Promise<PreparedClaim> {
  const detail = showTask(ctx, input.taskId);
  const task = detail.task;
  const config = loadProjectConfig(ctx, task.projectId).config;
  const { scopes, note } = await impactScopes(ctx, task.projectId, task.id, task.scopeHints);
  const claim = claimTask(ctx, { taskId: task.id, holder: input.holder, impactScopes: scopes, config });
  let workspace: Workspace | null = null;
  if (input.allocateWorkspace !== false && requiresPullRequest(task)) {
    try {
      workspace = (
        await allocateTaskWorkspace(ctx, {
          taskId: task.id,
          actor: input.actor,
          expectedLease: { id: claim.leaseId, generation: claim.generation, holder: input.holder },
          ...(input.inProcess ? { inProcess: true } : {}),
        })
      ).workspace;
    } catch (error) {
      releaseLease(ctx, {
        taskId: task.id,
        generation: claim.generation,
        token: claim.token,
        reason: `workspace allocation failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }
  return {
    taskId: task.id,
    leaseGeneration: claim.generation,
    leaseExpiresAt: claim.expiresAt,
    heartbeatIntervalSeconds: claim.heartbeatIntervalSeconds,
    claimToken: claim.token,
    workspaceId: workspace?.id ?? null,
    worktreePath: workspace?.path ?? null,
    branch: workspace?.branch ?? null,
    baseSha: workspace?.baseSha ?? null,
    reservations: claim.reservations,
    advisoryOverlaps: claim.advisoryOverlaps,
    impactNote: note,
  };
}
