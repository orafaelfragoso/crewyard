import { type Actor, RailError } from '@agent-rail/core';
import { loadProjectConfig } from '@agent-rail/projects';
import type { RailContext } from '@agent-rail/storage';
import {
  type ClaimResult,
  claimTask,
  type LeaseHolder,
  releaseLease,
  requiresPullRequest,
  showTask,
} from '@agent-rail/tasks';
import { allocateWorkspace, type Workspace } from '@agent-rail/workspaces';
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

async function impactScopes(
  ctx: RailContext,
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
    if (error instanceof RailError && error.code === 'INDEX_STALE') return { scopes: [], note: error.message };
    throw error;
  }
}

export async function claimAndPrepare(
  ctx: RailContext,
  input: { taskId: string; holder: LeaseHolder; actor: Actor; allocateWorkspace?: boolean },
): Promise<PreparedClaim> {
  const detail = showTask(ctx, input.taskId);
  const task = detail.task;
  const config = loadProjectConfig(ctx, task.projectId).config;
  const { scopes, note } = await impactScopes(ctx, task.projectId, task.id, task.scopeHints);
  const claim = claimTask(ctx, { taskId: task.id, holder: input.holder, impactScopes: scopes, config });
  let workspace: Workspace | null = null;
  if (input.allocateWorkspace !== false && requiresPullRequest(task)) {
    try {
      workspace = (await allocateWorkspace(ctx, { taskId: task.id, actor: input.actor, config })).workspace;
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
