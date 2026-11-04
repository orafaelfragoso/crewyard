import type { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, canonicalPath, git, isWithin, nowIso } from '@crewyard/core';
import { type CrewContext, one, recordTransition } from '@crewyard/storage';
import { freeDiskBytes } from './disk-space.ts';
import {
  assertManagedWorkspacePath,
  listWorkspaces,
  repositoryConfig,
  requireRepository,
  type Workspace,
} from './model.ts';

export interface PrunedBuildOutput {
  workspaceId: string;
  taskId: string | null;
  paths: string[];
  freedBytes: number;
}

async function isWorktreeRoot(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const result = await git(path, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  return result.exitCode === 0 && canonicalPath(result.stdout.trim()) === path;
}

async function isIgnoredAndUntracked(root: string, entry: string): Promise<boolean> {
  const ignored = await git(root, ['check-ignore', '--quiet', '--', entry], { allowFailure: true });
  if (ignored.exitCode !== 0) return false;
  const tracked = await git(root, ['--literal-pathspecs', 'ls-files', '--', entry], { allowFailure: true });
  return tracked.exitCode === 0 && tracked.stdout.trim() === '';
}

function isIdle(db: Database, ws: Workspace): boolean {
  if (ws.taskId && one(db, 'SELECT 1 FROM leases WHERE task_id = ? AND released_at IS NULL', ws.taskId)) return false;
  return !one(
    db,
    `SELECT 1 FROM sessions WHERE workspace_id = ? AND state IN ('starting', 'running', 'stopping')`,
    ws.id,
  );
}

export async function pruneBuildOutput(
  ctx: CrewContext,
  input: { repositoryId: string; actor: Actor; config?: CrewConfig },
): Promise<PrunedBuildOutput[]> {
  const repo = requireRepository(ctx, input.repositoryId);
  const entries = repositoryConfig(ctx, repo, input.config).workspace.build_output;
  if (entries.length === 0) return [];
  const db = ctx.store.db;
  const pruned: PrunedBuildOutput[] = [];
  for (const ws of listWorkspaces(ctx, {
    repositoryId: repo.id,
    states: ['ready', 'in_use', 'preserved', 'needs_reconciliation'],
  })) {
    if (!isIdle(db, ws)) continue;
    const root = assertManagedWorkspacePath(ctx, ws, repo);
    if (!(await isWorktreeRoot(root))) continue;
    const paths: string[] = [];
    let freedBytes = 0;
    for (const entry of entries) {
      const target = resolve(root, entry);
      if (target === root || !isWithin(root, target) || !existsSync(target) || canonicalPath(target) !== target)
        continue;
      if (!(await isIgnoredAndUntracked(root, entry)) || !isIdle(db, ws)) continue;
      const before = freeDiskBytes(root);
      rmSync(target, { recursive: true, force: true });
      freedBytes += Math.max(0, freeDiskBytes(root) - before);
      paths.push(entry);
    }
    if (paths.length === 0) continue;
    ctx.store.immediate((tx) =>
      recordTransition(
        tx,
        {
          type: 'workspace.build_output_pruned',
          actor: input.actor,
          projectId: repo.projectId,
          taskId: ws.taskId,
          payload: { workspaceId: ws.id, paths, freedBytes },
        },
        { action: 'workspace.prune_build_output', input: { workspaceId: ws.id, paths }, decision: 'accepted' },
        nowIso(ctx.clock),
      ),
    );
    pruned.push({ workspaceId: ws.id, taskId: ws.taskId, paths, freedBytes });
  }
  return pruned;
}
