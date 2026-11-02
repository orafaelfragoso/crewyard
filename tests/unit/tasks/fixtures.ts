import { join } from 'node:path';
import { type CrewConfig, type CrewConfigInput, crewConfigSchema } from '@crewyard/config';
import { type Actor, type AutonomyMode, newId, nowIso, type TaskState } from '@crewyard/core';
import type { CrewContext } from '@crewyard/storage';
import { type ClaimResult, claimTask, startTask, submitWork, transitionTask } from '@crewyard/tasks';

export const operator: Actor = { kind: 'operator', id: 'rafael' };

export function testConfig(overrides: Partial<CrewConfigInput> = {}): CrewConfig {
  return crewConfigSchema.parse({ version: 1, project: { name: 'sample' }, ...overrides });
}

export function seedProject(
  ctx: CrewContext & { root: string },
  options: { name?: string; autonomy?: AutonomyMode; repoPath?: string; trusted?: boolean } = {},
): { projectId: string; repositoryId: string } {
  const projectId = newId('prj');
  const repositoryId = newId('repo');
  const at = nowIso(ctx.clock);
  ctx.store.db
    .query('INSERT INTO projects (id, name, autonomy, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, options.name ?? `project-${projectId.slice(-6)}`, options.autonomy ?? 'guarded', at, at);
  ctx.store.db
    .query(
      `INSERT INTO repositories (id, project_id, canonical_path, default_base, trusted, created_at, updated_at)
       VALUES (?, ?, ?, 'main', ?, ?, ?)`,
    )
    .run(
      repositoryId,
      projectId,
      options.repoPath ?? join(ctx.root, `repo-${repositoryId.slice(-6)}`),
      options.trusted ? 1 : 0,
      at,
      at,
    );
  return { projectId, repositoryId };
}

export function agent(id: string): { kind: 'agent'; id: string } {
  return { kind: 'agent', id };
}

export function driveToState(ctx: CrewContext, taskId: string, target: TaskState, config: CrewConfig): ClaimResult {
  const claim = claimTask(ctx, { taskId, holder: agent(`driver-${taskId}`), config });
  startTask(ctx, claim);
  submitWork(ctx, { ...claim, handoff: { summary: 'done', commits: ['abcdef1'] } });
  const path: TaskState[] = ['QUEUED', 'VALIDATING', 'MERGED', 'DONE'];
  for (const to of path.slice(0, path.indexOf(target) + 1)) {
    transitionTask(ctx, { taskId, to, actor: { kind: 'service', id: 'integration' } });
  }
  return claim;
}
