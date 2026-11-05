import type { CrewConfig } from '@crewyard/config';
import { type Actor, nowIso } from '@crewyard/core';
import { primaryRepository } from '@crewyard/projects';
import { requestInterventionInTx } from '@crewyard/reviews';
import { type DiskSpace, diskSpace, gigabytes } from '@crewyard/scheduler';
import { type CrewContext, one, recordTransition } from '@crewyard/storage';
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
    prune: 'always' | 'when-low';
    measure?: (path: string) => number;
  },
): Promise<DiskGuard> {
  const measure = input.measure ?? freeDiskBytes;
  const measured = input.config.scheduler.min_free_disk_gb === 0 ? null : measure(ctx.dirs.worktrees);
  const repo = primaryRepository(ctx, input.projectId);
  const prune = input.prune === 'always' || diskSpace(measured, input.config).low;
  const pruned = prune
    ? await pruneBuildOutput(ctx, { repositoryId: repo.id, actor: input.actor, config: input.config })
    : [];
  const free = measured === null ? null : prune ? measure(ctx.dirs.worktrees) : measured;
  const disk = diskSpace(free, input.config);
  ctx.store.immediate((db) => {
    const previous = one<{ low: number }>(
      db,
      "SELECT json_extract(payload, '$.low') AS low FROM events WHERE type = 'service.disk_space_changed' AND project_id = ? ORDER BY seq DESC LIMIT 1",
      input.projectId,
    );
    if ((previous?.low === 1) === disk.low) return;
    const at = nowIso(ctx.clock);
    recordTransition(
      db,
      {
        type: 'service.disk_space_changed',
        actor: input.actor,
        projectId: input.projectId,
        payload: { repositoryId: repo.id, ...disk },
      },
      {
        action: 'service.disk_space',
        input: { repositoryId: repo.id, ...disk },
        decision: disk.low ? 'low' : 'recovered',
      },
      at,
    );
    if (!disk.low || !input.alert) return;
    const freed = pruned.reduce((sum, p) => sum + p.freedBytes, 0);
    requestInterventionInTx(
      db,
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
      at,
    );
  });
  return { freeDiskBytes: free, disk, pruned };
}
