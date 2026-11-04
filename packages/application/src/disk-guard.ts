import type { CrewConfig } from '@crewyard/config';
import type { Actor } from '@crewyard/core';
import { primaryRepository } from '@crewyard/projects';
import { requestIntervention } from '@crewyard/reviews';
import { type DiskSpace, diskSpace, gigabytes } from '@crewyard/scheduler';
import type { CrewContext } from '@crewyard/storage';
import { freeDiskBytes, type PrunedBuildOutput, pruneBuildOutput } from '@crewyard/workspaces';

export interface DiskGuard {
  freeDiskBytes: number | null;
  disk: DiskSpace;
  pruned: PrunedBuildOutput[];
}

export async function guardDiskSpace(
  ctx: CrewContext,
  input: {
    projectId: string;
    config: CrewConfig;
    actor: Actor;
    alert: boolean;
    measure?: (path: string) => number;
  },
): Promise<DiskGuard> {
  if (input.config.scheduler.min_free_disk_gb === 0) {
    return { freeDiskBytes: null, disk: diskSpace(null, input.config), pruned: [] };
  }
  const measure = input.measure ?? freeDiskBytes;
  const measured = measure(ctx.dirs.worktrees);
  if (!diskSpace(measured, input.config).low) {
    return { freeDiskBytes: measured, disk: diskSpace(measured, input.config), pruned: [] };
  }
  const repo = primaryRepository(ctx, input.projectId);
  const pruned = await pruneBuildOutput(ctx, { repositoryId: repo.id, actor: input.actor, config: input.config });
  const free = measure(ctx.dirs.worktrees);
  const disk = diskSpace(free, input.config);
  if (disk.low && input.alert) {
    const freed = pruned.reduce((sum, p) => sum + p.freedBytes, 0);
    requestIntervention(
      ctx,
      {
        projectId: input.projectId,
        title: `Disk space low for ${input.config.project.name}`,
        reasons: [
          `${disk.freeGb} GB free under ${ctx.dirs.worktrees}, below scheduler.min_free_disk_gb (${disk.minFreeGb} GB); no new agent sessions start`,
          input.config.workspace.build_output.length === 0
            ? 'Set workspace.build_output (for example `[target]`) so build output in idle worktrees can be pruned'
            : `Pruned ${input.config.workspace.build_output.join(', ')} in ${pruned.length} idle worktree(s), freeing ${gigabytes(freed)} GB`,
          'Free disk space or lower scheduler.min_free_disk_gb; dispatch resumes on its own once there is room',
        ],
      },
      input.actor,
    );
  }
  return { freeDiskBytes: free, disk, pruned };
}
