import { loadConfig, type RailConfig } from '@agent-rail/config';
import { RailError } from '@agent-rail/core';
import { one, type RailContext } from '@agent-rail/storage';

export function loadTaskConfig(ctx: RailContext, projectId: string): RailConfig {
  const row = one<{ name: string; canonical_path: string | null }>(
    ctx.store.db,
    `SELECT p.name, r.canonical_path FROM projects p
     LEFT JOIN repositories r ON r.project_id = p.id
     WHERE p.id = ? ORDER BY r.canonical_path LIMIT 1`,
    projectId,
  );
  if (!row) throw new RailError('NOT_FOUND', `Project not found: ${projectId}`);
  if (!row.canonical_path) {
    throw new RailError('NOT_FOUND', `Project ${projectId} has no repositories`, {
      suggestion: 'Run `rail init --repo PATH`.',
    });
  }
  return loadConfig({ repoRoot: row.canonical_path, dirs: ctx.dirs, projectNameFallback: row.name }).config;
}

export function resolveTaskConfig(ctx: RailContext, projectId: string, config?: RailConfig): RailConfig {
  return config ?? loadTaskConfig(ctx, projectId);
}
