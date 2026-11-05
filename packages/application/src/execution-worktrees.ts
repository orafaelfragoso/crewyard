import { existsSync } from 'node:fs';
import { CrewError, git, toPosix, withProcessLifecycle } from '@crewyard/core';
import { assertExecutionWorktreePath, type CrewContext, executionWorktrees } from '@crewyard/storage';
import type { ExecutionLaunch } from './execution.ts';
import { finishExecutionProcesses, recordExecutionProcess } from './execution-processes.ts';

export async function cleanExecutionWorktrees(ctx: CrewContext, launch: ExecutionLaunch): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  await withProcessLifecycle({ signal, onSpawn: (pid) => recordExecutionProcess(launch.directory, pid) }, async () => {
    for (const worktree of executionWorktrees(launch.directory)) {
      assertExecutionWorktreePath(ctx, worktree, launch.claim.attemptId);
      const listed = await git(worktree.repositoryPath, ['worktree', 'list', '--porcelain', '-z'], {
        timeoutMs: 2_000,
      });
      const registered = listed.stdout.split('\0').includes(`worktree ${toPosix(worktree.path)}`);
      if (!registered) {
        if (existsSync(worktree.path))
          throw new CrewError('CONFLICT', 'Unregistered disposable worktree preserved for inspection');
        continue;
      }
      await git(worktree.repositoryPath, ['worktree', 'remove', '--force', worktree.path], { timeoutMs: 2_000 });
      if (existsSync(worktree.path))
        throw new CrewError('CONFLICT', 'Disposable worktree still exists after Git removal');
    }
  });
}

export async function finishExecutionResources(
  ctx: CrewContext,
  launch: ExecutionLaunch,
): Promise<{ stopped: number; unverifiable: number; pending: number; cleanupError: string | null }> {
  const children = await finishExecutionProcesses(launch.directory, 1_000);
  if (children.unverifiable || children.pending) return { ...children, cleanupError: null };
  let cleanupError: string | null = null;
  try {
    await cleanExecutionWorktrees(ctx, launch);
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  const cleanup = await finishExecutionProcesses(launch.directory, 1_000);
  return {
    stopped: children.stopped + cleanup.stopped,
    unverifiable: cleanup.unverifiable,
    pending: cleanup.pending,
    cleanupError,
  };
}
