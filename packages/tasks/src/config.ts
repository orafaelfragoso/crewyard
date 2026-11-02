import { type CrewConfig, loadConfig } from '@crewyard/config';
import { CrewError } from '@crewyard/core';
import { type CrewContext, one } from '@crewyard/storage';

export function loadTaskConfig(ctx: CrewContext, projectId: string): CrewConfig {
  const row = one<{ name: string; canonical_path: string | null }>(
    ctx.store.db,
    `SELECT p.name, r.canonical_path FROM projects p
     LEFT JOIN repositories r ON r.project_id = p.id
     WHERE p.id = ? ORDER BY r.canonical_path LIMIT 1`,
    projectId,
  );
  if (!row) throw new CrewError('NOT_FOUND', `Project not found: ${projectId}`);
  if (!row.canonical_path) {
    throw new CrewError('NOT_FOUND', `Project ${projectId} has no repositories`, {
      suggestion: 'Run `crew init --repo PATH`.',
    });
  }
  return loadConfig({ repoRoot: row.canonical_path, dirs: ctx.dirs, projectNameFallback: row.name }).config;
}

export function resolveTaskConfig(ctx: CrewContext, projectId: string, config?: CrewConfig): CrewConfig {
  return config ?? loadTaskConfig(ctx, projectId);
}
